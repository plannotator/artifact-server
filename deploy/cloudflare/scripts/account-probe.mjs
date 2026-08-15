import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as Schema from "effect/Schema";

const PACKAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STACK_NAME = "artifact-server-cloudflare";
const COMPATIBILITY_DATE = "2026-08-15";
const MAX_CAPTURE_BYTES = 1_000_000;
const DEPLOYMENT_OUTPUT_KEYS = [
  "applicationUrl",
  "contentDomain",
  "databaseResourceId",
  "healthUrl",
  "imageDigest",
  "installationId",
  "logDestination",
  "mcpUrl",
  "networkResourceIds",
  "objectStorageResourceId",
  "readinessUrl",
  "runtimeResourceId",
  "secretResourceIds",
  "stateBackend",
  "supportManifestLocation",
  "workloadIdentityResourceId",
];
const ProbePolicyConfiguration = Schema.Struct({
  cloudflareAccountId: Schema.String,
  compatibilityDate: Schema.String,
  dnsZoneId: Schema.optionalKey(Schema.String),
  environment: Schema.String,
  ingress: Schema.String,
  installationName: Schema.String,
  stage: Schema.String,
  stateStore: Schema.String,
  target: Schema.String,
});
const ProbeDatabaseId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,
  ),
);

const usage = `Usage:
  pnpm probe:account \\
    --config ./probe.config.json \\
    --confirm-account <cloudflare-account-id> \\
    [--alchemy-profile default]

The probe plans, deploys twice, proves a no-drift plan, destroys compute,
checks retained D1 and R2 resources by exact ID, then permanently deletes
those two probe-only durable resources. It writes redacted evidence under
evidence/.
`;

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const capture = (current, chunk) =>
  `${current}${chunk}`.slice(-MAX_CAPTURE_BYTES);

const commandEvidence = (result) => ({
  command: result.command,
  exitCode: result.exitCode,
  stderrSha256: sha256(result.stderr),
  stdoutSha256: sha256(result.stdout),
});

const runCommand = (command, args, environment, input) =>
  new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: PACKAGE_DIRECTORY,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      resolveResult({
        command: [command, ...args].join(" "),
        exitCode: 1,
        stdout,
        stderr: capture(stderr, error.message),
      });
    });
    child.on("close", (code) => {
      resolveResult({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
    child.stdin.end(input);
  });

const boundedName = (value, limit) => {
  if (value.length <= limit) {
    return value;
  }
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const digest = (hash >>> 0).toString(16).padStart(8, "0");
  return `${value.slice(0, limit - digest.length - 1)}-${digest}`;
};

const resourceNames = (configuration) => {
  const applicationName = configuration.stage.startsWith("probe-")
    ? "probe-artifact-server"
    : "artifact-server";
  const base = [
    applicationName,
    configuration.installationName,
    configuration.environment,
    configuration.stage,
  ].join("-");
  return {
    bucket: boundedName(`${base}-objects`, 63),
    database: boundedName(`${base}-records`, 64),
    worker: boundedName(`${base}-worker`, 63),
  };
};

const parseOptions = () => {
  try {
    return {
      ok: true,
      value: parseArgs({
        options: {
          "alchemy-profile": {
            type: "string",
            default: "default",
          },
          config: {
            type: "string",
          },
          "confirm-account": {
            type: "string",
          },
          help: {
            type: "boolean",
            default: false,
          },
        },
        strict: true,
      }).values,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Could not parse probe options.",
    };
  }
};

const parseConfiguration = async (path) => {
  try {
    const raw = await readFile(path, "utf8");
    return {
      ok: true,
      raw,
      value: JSON.parse(raw),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Could not read the probe configuration.",
    };
  }
};

const validateProbePolicy = (options, configuration) => {
  if (!Schema.is(ProbePolicyConfiguration)(configuration)) {
    return ["configuration is missing a probe policy field"];
  }
  const failures = [];
  if (configuration.target !== "cloudflare") {
    failures.push("target must be cloudflare");
  }
  if (configuration.environment !== "development") {
    failures.push("environment must be development");
  }
  if (!configuration.stage.startsWith("probe-")) {
    failures.push("stage must start with probe-");
  }
  if (!configuration.installationName.startsWith("probe-")) {
    failures.push("installationName must start with probe-");
  }
  if (configuration.compatibilityDate !== COMPATIBILITY_DATE) {
    failures.push(
      `compatibilityDate must be ${COMPATIBILITY_DATE}`,
    );
  }
  if (configuration.stateStore !== "cloudflare") {
    failures.push("stateStore must be cloudflare");
  }
  if (configuration.ingress !== "private") {
    failures.push("the approved probe requires private ingress");
  }
  if (configuration.dnsZoneId !== undefined) {
    failures.push("the approved probe forbids dnsZoneId");
  }
  if (
    options["confirm-account"] !==
    configuration.cloudflareAccountId
  ) {
    failures.push(
      "--confirm-account must exactly match cloudflareAccountId",
    );
  }
  const names = resourceNames(configuration);
  if (
    Object.values(names).some((name) => !name.startsWith("probe-"))
  ) {
    failures.push("every proposed resource name must start with probe-");
  }
  return failures;
};

const planSummary = (output) =>
  output.split("\n")
    .find((line) => line.includes("Plan:")) ?? "";

const hasNoDrift = (result) => {
  const summary = planSummary(result.stdout);
  return result.exitCode === 0 &&
    summary.trim() === "Plan: 3 to noop";
};

const hasDeploymentOutput = (result, configuration, names) => {
  const applicationUrl = `https://${configuration.applicationDomain}`;
  const expectedValues = [
    `${configuration.installationName}:${configuration.environment}`,
    applicationUrl,
    configuration.contentDomain,
    `${applicationUrl}/mcp`,
    `${applicationUrl}/health`,
    `${applicationUrl}/ready`,
    names.bucket,
    names.worker,
    "cloudflare:alchemy-state-store",
    `r2://${names.bucket}/support/installation-manifest.json`,
  ];
  return result.exitCode === 0 &&
    DEPLOYMENT_OUTPUT_KEYS.every((key) =>
      result.stdout.includes(key)
    ) &&
    expectedValues.every((value) => result.stdout.includes(value)) &&
    result.stdout.includes("sha256:");
};

const parseJson = (result) => {
  if (result.exitCode !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
};

const hasApprovedAccount = (result, accountId) => {
  const document = parseJson(result);
  return document?.loggedIn === true &&
    Array.isArray(document.accounts) &&
    document.accounts.some((account) => account.id === accountId);
};

const d1Databases = (result) => {
  const document = parseJson(result);
  return Array.isArray(document) ? document : undefined;
};

const normalizedD1Inventory = (result) => {
  const databases = d1Databases(result);
  return databases?.map(({ name, uuid }) => ({ name, uuid }))
    .toSorted((left, right) => left.uuid.localeCompare(right.uuid));
};

const r2BucketNames = (result) => {
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.split(/\r?\n/gu)
    .map((line) => /^\s*name:\s*(.+?)\s*$/iu.exec(line)?.[1])
    .filter((name) => name !== undefined)
    .toSorted((left, right) => left.localeCompare(right));
};

const workerIsAbsent = (result) =>
  result.exitCode !== 0 &&
  /(?:not found|does not exist|10090|script_not_found)/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );

const stageIsAbsent = (result, stage) =>
  result.exitCode === 0 &&
  !result.stdout.split(/\r?\n/gu).some((line) => line.trim() === stage);

const initialPlanIsSafe = (result) =>
  result.exitCode === 0 &&
  planSummary(result.stdout).trim() === "Plan: 3 to create" &&
  !/plannotator/iu.test(`${result.stdout}\n${result.stderr}`);

const extractOutputValue = (result, key) => {
  const match = new RegExp(
    `["']?${key}["']?\\s*:\\s*["']([^"']+)["']`,
    "u",
  ).exec(result.stdout);
  return match?.[1];
};

const createdResourceIds = (result) => ({
  worker: extractOutputValue(result, "runtimeResourceId"),
  database: extractOutputValue(result, "databaseResourceId"),
  bucket: extractOutputValue(result, "objectStorageResourceId"),
});

const exactResourceIdsAreValid = (ids, names) =>
  ids.worker === names.worker &&
  ids.bucket === names.bucket &&
  Schema.is(ProbeDatabaseId)(ids.database);

const resourcesMatchExactIds = (
  databaseResult,
  bucketResult,
  ids,
  names,
) => {
  const database = parseJson(databaseResult);
  const bucket = parseJson(bucketResult);
  return database?.uuid === ids.database &&
    database?.name === names.database &&
    bucket?.name === ids.bucket;
};

const createdIdsAreEqual = (left, right) =>
  left.worker === right.worker &&
  left.database === right.database &&
  left.bucket === right.bucket;

const writeEvidence = async (evidence) => {
  const timestamp = evidence.finishedAt.replaceAll(/[:.]/gu, "-");
  const path = resolve(
    PACKAGE_DIRECTORY,
    "evidence",
    `account-probe-${timestamp}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const parsedOptions = parseOptions();
  if (!parsedOptions.ok) {
    console.error(parsedOptions.message);
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const options = parsedOptions.value;
  if (options.help) {
    console.log(usage);
    return;
  }
  if (
    options.config === undefined ||
    options["confirm-account"] === undefined
  ) {
    console.error("--config and --confirm-account are required.");
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(PACKAGE_DIRECTORY, options.config);
  const parsedConfiguration = await parseConfiguration(configPath);
  if (!parsedConfiguration.ok) {
    console.error(parsedConfiguration.message);
    process.exitCode = 1;
    return;
  }
  const configuration = parsedConfiguration.value;
  const policyFailures = validateProbePolicy(options, configuration);
  if (policyFailures.length > 0) {
    console.error(
      `Probe policy rejected the request:\n- ${policyFailures.join("\n- ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const names = resourceNames(configuration);
  const environment = {
    ...process.env,
    ALCHEMY_TELEMETRY_DISABLED: "1",
    ARTIFACT_SERVER_CLOUDFLARE_CONFIG:
      parsedConfiguration.raw.trim(),
    CLOUDFLARE_ACCOUNT_ID: configuration.cloudflareAccountId,
    DO_NOT_TRACK: "1",
    FORCE_COLOR: "0",
    NO_TRACK: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  const alchemy = (...args) =>
    runCommand(
      "pnpm",
      [
        "exec",
        "alchemy",
        ...args,
        "--profile",
        options["alchemy-profile"],
        "alchemy.run.ts",
      ],
      environment,
    );
  const wrangler = (args, input) =>
    runCommand(
      "npx",
      [
        "wrangler",
        ...args,
      ],
      environment,
      input,
    );
  const steps = [];
  const checks = {
    accountMatched: false,
    cleanupSucceeded: false,
    deploymentOutputValid: false,
    dnsChangesExcluded: true,
    durableDataRetained: false,
    exactResourceIdsCaptured: false,
    initialInventoryClear: false,
    nativePlanNoWrites: false,
    nonProbeDurableInventoryUnchanged: false,
    repeatDeploymentNoDrift: false,
    workerDestroyed: false,
  };
  let exactIds = {
    worker: null,
    database: null,
    bucket: null,
  };
  const finish = async (stoppedReason) => {
    const finishedAt = new Date().toISOString();
    const evidencePath = await writeEvidence({
      schemaVersion: 2,
      startedAt,
      finishedAt,
      accountId: configuration.cloudflareAccountId,
      configurationSha256: sha256(parsedConfiguration.raw),
      stage: configuration.stage,
      resources: names,
      createdResourceIds: exactIds,
      checks,
      stoppedReason,
      steps,
    });
    return evidencePath;
  };
  const stop = async (reason, message) => {
    const evidencePath = await finish(reason);
    console.error(`${message} Evidence: ${evidencePath}`);
    process.exitCode = 1;
  };

  const identity = await wrangler(["whoami", "--json"]);
  steps.push(commandEvidence(identity));
  checks.accountMatched = hasApprovedAccount(
    identity,
    configuration.cloudflareAccountId,
  );
  if (!checks.accountMatched) {
    await stop(
      "account-mismatch",
      "The authenticated Wrangler account does not match.",
    );
    return;
  }

  const existingStages = await alchemy(
    "state",
    "stages",
    "--stack",
    STACK_NAME,
  );
  steps.push(commandEvidence(existingStages));
  if (!stageIsAbsent(existingStages, configuration.stage)) {
    await stop(
      "stage-exists",
      "The probe stage already exists or cannot be verified.",
    );
    return;
  }

  const initialD1Inventory = await wrangler(["d1", "list", "--json"]);
  const initialR2Inventory = await wrangler(["r2", "bucket", "list"]);
  const initialWorkerLookup = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(initialD1Inventory),
    commandEvidence(initialR2Inventory),
    commandEvidence(initialWorkerLookup),
  );
  const initialDatabases = d1Databases(initialD1Inventory);
  const initialBuckets = r2BucketNames(initialR2Inventory);
  checks.initialInventoryClear =
    initialDatabases !== undefined &&
    initialBuckets !== undefined &&
    !initialDatabases.some(({ name }) => name === names.database) &&
    !initialBuckets.includes(names.bucket) &&
    workerIsAbsent(initialWorkerLookup);
  if (!checks.initialInventoryClear) {
    await stop(
      "proposed-resource-exists",
      "A proposed resource exists or the initial inventory is uncertain.",
    );
    return;
  }

  const initialPlan = await alchemy(
    "plan",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(initialPlan));
  checks.nativePlanNoWrites = initialPlanIsSafe(initialPlan);
  if (!checks.nativePlanNoWrites) {
    await stop(
      "unsafe-initial-plan",
      "The initial plan was not an exact three-resource create.",
    );
    return;
  }

  const firstDeploy = await alchemy(
    "deploy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(firstDeploy));
  if (firstDeploy.exitCode !== 0) {
    await stop(
      "first-deploy-failed",
      "The first deployment failed. Automatic cleanup did not run because exact IDs are unavailable.",
    );
    return;
  }

  const discoveredIds = createdResourceIds(firstDeploy);
  exactIds = {
    worker: discoveredIds.worker ?? null,
    database: discoveredIds.database ?? null,
    bucket: discoveredIds.bucket ?? null,
  };
  if (!exactResourceIdsAreValid(exactIds, names)) {
    await stop(
      "resource-id-missing",
      "The deployment did not return every exact resource ID.",
    );
    return;
  }

  const createdDatabaseInfo = await wrangler([
    "d1",
    "info",
    names.database,
    "--json",
  ]);
  const createdBucketInfo = await wrangler([
    "r2",
    "bucket",
    "info",
    names.bucket,
    "--json",
  ]);
  const createdWorkerInfo = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(createdDatabaseInfo),
    commandEvidence(createdBucketInfo),
    commandEvidence(createdWorkerInfo),
  );
  checks.exactResourceIdsCaptured =
    resourcesMatchExactIds(
      createdDatabaseInfo,
      createdBucketInfo,
      exactIds,
      names,
    ) &&
    createdWorkerInfo.exitCode === 0 &&
    Array.isArray(parseJson(createdWorkerInfo)) &&
    parseJson(createdWorkerInfo).length > 0;
  if (!checks.exactResourceIdsCaptured) {
    await stop(
      "resource-id-mismatch",
      "Cloudflare inventory does not match the returned resource IDs.",
    );
    return;
  }

  let repeatDeploy = {
    command: "repeat deploy skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  repeatDeploy = await alchemy(
    "deploy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(repeatDeploy));
  const repeatIds = createdResourceIds(repeatDeploy);
  checks.deploymentOutputValid =
    hasDeploymentOutput(repeatDeploy, configuration, names) &&
    createdIdsAreEqual(exactIds, repeatIds);
  checks.repeatDeploymentNoDrift = hasNoDrift(repeatDeploy);
  if (!checks.deploymentOutputValid) {
    await stop(
      "repeat-deploy-id-mismatch",
      "The second deployment did not return the same exact resource IDs.",
    );
    return;
  }

  const destroy = await alchemy(
    "destroy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(destroy));
  if (destroy.exitCode !== 0) {
    await stop(
      "worker-destroy-failed",
      "Alchemy did not destroy the exact probe stage.",
    );
    return;
  }

  const destroyedWorkerInfo = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  const retainedDatabaseInfo = await wrangler([
    "d1",
    "info",
    exactIds.database,
    "--json",
  ]);
  const retainedBucketInfo = await wrangler([
    "r2",
    "bucket",
    "info",
    exactIds.bucket,
    "--json",
  ]);
  steps.push(
    commandEvidence(destroyedWorkerInfo),
    commandEvidence(retainedDatabaseInfo),
    commandEvidence(retainedBucketInfo),
  );
  checks.workerDestroyed = workerIsAbsent(destroyedWorkerInfo);
  checks.durableDataRetained = resourcesMatchExactIds(
    retainedDatabaseInfo,
    retainedBucketInfo,
    exactIds,
    names,
  );
  if (
    !checks.workerDestroyed ||
    !checks.durableDataRetained
  ) {
    await stop(
      "retention-check-failed",
      "Worker destruction or exact durable-resource retention was not verified.",
    );
    return;
  }

  const databaseDelete = await wrangler([
    "d1",
    "delete",
    exactIds.database,
    "--skip-confirmation",
  ]);
  const bucketDelete = await wrangler(
    ["r2", "bucket", "delete", exactIds.bucket],
    "y\n",
  );
  steps.push(
    commandEvidence(databaseDelete),
    commandEvidence(bucketDelete),
  );

  const finalD1Inventory = await wrangler(["d1", "list", "--json"]);
  const finalR2Inventory = await wrangler(["r2", "bucket", "list"]);
  const finalWorkerLookup = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(finalD1Inventory),
    commandEvidence(finalR2Inventory),
    commandEvidence(finalWorkerLookup),
  );
  const initialNormalizedDatabases =
    normalizedD1Inventory(initialD1Inventory);
  const finalNormalizedDatabases =
    normalizedD1Inventory(finalD1Inventory);
  const finalBuckets = r2BucketNames(finalR2Inventory);
  checks.nonProbeDurableInventoryUnchanged =
    initialNormalizedDatabases !== undefined &&
    finalNormalizedDatabases !== undefined &&
    JSON.stringify(initialNormalizedDatabases) ===
      JSON.stringify(finalNormalizedDatabases) &&
    initialBuckets !== undefined &&
    finalBuckets !== undefined &&
    JSON.stringify(initialBuckets) === JSON.stringify(finalBuckets);
  checks.cleanupSucceeded =
    databaseDelete.exitCode === 0 &&
    bucketDelete.exitCode === 0 &&
    checks.nonProbeDurableInventoryUnchanged &&
    workerIsAbsent(finalWorkerLookup);

  const evidencePath = await finish(undefined);
  const passed = Object.values(checks).every(Boolean);
  const status = passed ? "passed" : "failed";
  console.log(`Cloudflare account probe ${status}: ${evidencePath}`);
  if (!passed) {
    process.exitCode = 1;
  }
};

await main();
