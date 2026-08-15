import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as Schema from "effect/Schema";

import { buildCloudflareDeploymentManifest } from
  "../src/deployment-manifest.ts";

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
  dnsZoneIds: Schema.optionalKey(Schema.Struct({
    application: Schema.String,
    content: Schema.String,
  })),
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
const QualificationUpload = Schema.Struct({
  commitUrl: Schema.String,
  files: Schema.Array(Schema.Struct({uploadUrl: Schema.String})),
});
const QualificationCommit = Schema.Struct({
  artifact: Schema.Struct({id: Schema.String}),
});
const QualificationList = Schema.Struct({
  artifacts: Schema.Array(Schema.Struct({
    artifact: Schema.Struct({id: Schema.String}),
  })),
});
const CloudflareCursor = Schema.String.check(Schema.isMinLength(1));
const R2ObjectListResponse = Schema.Struct({
  result: Schema.Array(Schema.Struct({key: Schema.String})),
  result_info: Schema.optionalKey(Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    is_truncated: Schema.optionalKey(Schema.Boolean),
  })),
  success: Schema.Literal(true),
});
const R2ObjectDeleteResponse = Schema.Struct({
  success: Schema.Literal(true),
});

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

const resourceNames = (configuration) =>
  buildCloudflareDeploymentManifest(configuration).resourceNames;

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
  if (configuration.dnsZoneIds !== undefined) {
    failures.push("the approved probe forbids dnsZoneIds");
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

const delay = (durationMs) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));

const rewriteQualificationUrl = (qualificationUrl, value) => {
  const source = new URL(value);
  const target = new URL(qualificationUrl);
  target.pathname = source.pathname;
  target.search = source.search;
  return target;
};

const requestStatus = async (url, options) => {
  const response = await fetch(url, options);
  return {
    body: await response.text(),
    status: response.status,
  };
};

const parseCloudflareResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const r2ObjectsUrl = (accountId, bucketName) =>
  new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
  );

const encodedObjectKey = (key) =>
  key.split("/").map(encodeURIComponent).join("/");

const listExactR2ObjectKeys = async (
  accountId,
  bucketName,
  headers,
  cursor,
  remainingPages,
) => {
  if (remainingPages === 0) return {keys: [], ok: false};
  const url = r2ObjectsUrl(accountId, bucketName);
  url.searchParams.set("per_page", "1000");
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, {headers});
  const document = await parseCloudflareResponse(response);
  if (!response.ok || !Schema.is(R2ObjectListResponse)(document)) {
    return {keys: [], ok: false};
  }
  const keys = document.result.map(({key}) => key);
  if (document.result_info?.is_truncated !== true) {
    return {keys, ok: true};
  }
  const nextCursor = document.result_info.cursor;
  if (!Schema.is(CloudflareCursor)(nextCursor)) {
    return {keys: [], ok: false};
  }
  const remaining = await listExactR2ObjectKeys(
    accountId,
    bucketName,
    headers,
    nextCursor,
    remainingPages - 1,
  );
  return remaining.ok
    ? {keys: [...keys, ...remaining.keys], ok: true}
    : remaining;
};

const emptyExactR2Bucket = async (
  accountId,
  bucketName,
  apiToken,
) => {
  if (apiToken === undefined || apiToken.length === 0) {
    return {deletedCount: 0, ok: false};
  }
  const headers = {Authorization: `Bearer ${apiToken}`};
  const listed = await listExactR2ObjectKeys(
    accountId,
    bucketName,
    headers,
    undefined,
    100,
  );
  if (!listed.ok) return {deletedCount: 0, ok: false};
  const deleted = await Promise.all(listed.keys.map(async (key) => {
    const url = r2ObjectsUrl(accountId, bucketName);
    url.pathname = `${url.pathname}/${encodedObjectKey(key)}`;
    const response = await fetch(url, {headers, method: "DELETE"});
    const document = await parseCloudflareResponse(response);
    return response.ok && Schema.is(R2ObjectDeleteResponse)(document);
  }));
  const deletedCount = deleted.filter(Boolean).length;
  return {deletedCount, ok: deletedCount === listed.keys.length};
};

const parseResponseDocument = (response) => {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
};

const awaitHealthyRuntime = async (qualificationUrl, attempts) => {
  const response = await requestStatus(new URL("/health", qualificationUrl));
  if (response.status === 200 || attempts <= 1) return response;
  await delay(500);
  return awaitHealthyRuntime(qualificationUrl, attempts - 1);
};

const parseQualificationUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".workers.dev")
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const qualifyRuntime = async (qualificationUrl, apiToken) => {
  const evidence = {
    artifactIdSha256: null,
    commit: null,
    health: null,
    list: null,
    ready: null,
    replay: null,
    unauthorized: null,
    upload: null,
    uploadFile: null,
  };
  try {
    const health = await awaitHealthyRuntime(qualificationUrl, 20);
    evidence.health = health.status;
    const ready = await requestStatus(new URL("/ready", qualificationUrl));
    evidence.ready = ready.status;
    const unauthorized = await requestStatus(
      new URL("/api/v1/artifacts", qualificationUrl),
    );
    evidence.unauthorized = unauthorized.status;

    const bytes = new TextEncoder().encode(
      "<main>Live Cloudflare qualification</main>",
    );
    const upload = await requestStatus(
      new URL("/api/v1/uploads", qualificationUrl),
      {
        body: JSON.stringify({
          entryPath: "index.html",
          files: [{
            mediaType: "text/html; charset=utf-8",
            path: "index.html",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          }],
        }),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    evidence.upload = upload.status;
    const uploadDocument = parseResponseDocument(upload);
    if (!Schema.is(QualificationUpload)(uploadDocument)) {
      return {evidence, passed: false};
    }
    const plannedFile = uploadDocument.files[0];
    if (plannedFile === undefined) return {evidence, passed: false};
    const uploadedFile = await requestStatus(
      rewriteQualificationUrl(qualificationUrl, plannedFile.uploadUrl),
      {
        body: bytes,
        headers: {Authorization: `Bearer ${apiToken}`},
        method: "PUT",
      },
    );
    evidence.uploadFile = uploadedFile.status;
    const commitBody = JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Live Cloudflare qualification",
      tags: ["cloudflare", "qualification"],
    }});
    const commitHeaders = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "cloudflare-live-runtime-qualification",
    };
    const commit = await requestStatus(
      rewriteQualificationUrl(qualificationUrl, uploadDocument.commitUrl),
      {body: commitBody, headers: commitHeaders, method: "POST"},
    );
    evidence.commit = commit.status;
    const commitDocument = parseResponseDocument(commit);
    if (!Schema.is(QualificationCommit)(commitDocument)) {
      return {evidence, passed: false};
    }
    const artifactId = commitDocument.artifact.id;
    evidence.artifactIdSha256 = sha256(artifactId);
    const replay = await requestStatus(
      rewriteQualificationUrl(qualificationUrl, uploadDocument.commitUrl),
      {body: commitBody, headers: commitHeaders, method: "POST"},
    );
    evidence.replay = replay.status;
    const list = await requestStatus(
      new URL("/api/v1/artifacts", qualificationUrl),
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    evidence.list = list.status;
    const listDocument = parseResponseDocument(list);
    const listed = Schema.is(QualificationList)(listDocument) &&
      listDocument.artifacts.some((item) => item.artifact.id === artifactId);
    const passed = evidence.health === 200 &&
      evidence.ready === 200 &&
      evidence.unauthorized === 401 &&
      evidence.upload === 201 &&
      evidence.uploadFile === 200 &&
      evidence.commit === 201 &&
      evidence.replay === 200 &&
      evidence.list === 200 &&
      listed;
    return {evidence, passed};
  } catch {
    return {evidence, passed: false};
  }
};

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
  const runtimeApiToken = randomBytes(32).toString("base64url");
  const environment = {
    ...process.env,
    ALCHEMY_TELEMETRY_DISABLED: "1",
    ARTIFACT_SERVER_CLOUDFLARE_CONFIG:
      parsedConfiguration.raw.trim(),
    ARTIFACT_SERVER_API_TOKEN: runtimeApiToken,
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
  const runtimeQualificationRequested =
    configuration.stage.startsWith("probe-runtime-");
  const checks = {
    accountMatched: false,
    bucketEmptied: false,
    cleanupSucceeded: false,
    deploymentOutputValid: false,
    dnsChangesExcluded: true,
    durableDataRetained: false,
    exactResourceIdsCaptured: false,
    initialInventoryClear: false,
    nativePlanNoWrites: false,
    nonProbeDurableInventoryUnchanged: false,
    repeatDeploymentNoDrift: false,
    runtimeQualified: !runtimeQualificationRequested,
    workerDestroyed: false,
  };
  let runtimeEvidence = null;
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
      runtime: runtimeEvidence,
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

  if (runtimeQualificationRequested) {
    const qualificationUrl = extractOutputValue(
      firstDeploy,
      "qualificationUrl",
    );
    const parsedQualificationUrl = qualificationUrl === undefined
      ? undefined
      : parseQualificationUrl(qualificationUrl);
    if (parsedQualificationUrl === undefined) {
      await stop(
        "qualification-url-missing",
        "The runtime probe did not return a workers.dev qualification URL.",
      );
      return;
    }
    const runtimeResult = await qualifyRuntime(
      parsedQualificationUrl,
      runtimeApiToken,
    );
    runtimeEvidence = runtimeResult.evidence;
    checks.runtimeQualified = runtimeResult.passed;
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

  const bucketCleanup = await emptyExactR2Bucket(
    configuration.cloudflareAccountId,
    exactIds.bucket,
    process.env.CLOUDFLARE_API_TOKEN,
  );
  checks.bucketEmptied = bucketCleanup.ok;
  steps.push({
    command: "Cloudflare API empty exact probe R2 bucket",
    exitCode: bucketCleanup.ok ? 0 : 1,
    stderrSha256: sha256(""),
    stdoutSha256: sha256(JSON.stringify({
      deletedCount: bucketCleanup.deletedCount,
    })),
  });

  const databaseDelete = await wrangler([
    "d1",
    "delete",
    exactIds.database,
    "--skip-confirmation",
  ]);
  const bucketDelete = bucketCleanup.ok
    ? await wrangler(
      ["r2", "bucket", "delete", exactIds.bucket],
      "y\n",
    )
    : {
      command: `npx wrangler r2 bucket delete ${exactIds.bucket}`,
      exitCode: 1,
      stdout: "",
      stderr: "Exact bucket object cleanup failed.",
    };
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
    checks.bucketEmptied &&
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
