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

const usage = `Usage:
  pnpm probe:account \\
    --config ./probe.config.json \\
    --confirm-account <cloudflare-account-id> \\
    [--alchemy-profile default] \\
    [--wrangler-profile default] \\
    [--confirm-dns <dns-zone-id>]

The probe plans, deploys twice, proves a no-drift plan, destroys compute,
checks retained D1 and R2 resources, then permanently deletes those two
probe-only durable resources. It writes secret-free evidence under evidence/.
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
  const base = [
    "artifact-server",
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
          "confirm-dns": {
            type: "string",
          },
          help: {
            type: "boolean",
            default: false,
          },
          "wrangler-profile": {
            type: "string",
            default: "default",
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
  if (
    options["confirm-account"] !==
    configuration.cloudflareAccountId
  ) {
    failures.push(
      "--confirm-account must exactly match cloudflareAccountId",
    );
  }
  if (
    configuration.ingress === "public" &&
    options["confirm-dns"] !== configuration.dnsZoneId
  ) {
    failures.push(
      "public ingress requires --confirm-dns matching dnsZoneId",
    );
  }
  return failures;
};

const planSummary = (output) =>
  output.split("\n")
    .find((line) => line.includes("Plan:")) ?? "";

const hasNoDrift = (result) => {
  const summary = planSummary(result.stdout);
  return result.exitCode === 0 &&
    summary.includes("to noop") &&
    !/\bto (?:create|update|replace|delete)\b/u.test(summary);
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
      "pnpm",
      [
        "exec",
        "wrangler",
        ...args,
        "--profile",
        options["wrangler-profile"],
      ],
      environment,
      input,
    );
  const steps = [];

  const initialPlan = await alchemy(
    "plan",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(initialPlan));
  if (initialPlan.exitCode !== 0) {
    const finishedAt = new Date().toISOString();
    const evidencePath = await writeEvidence({
      schemaVersion: 1,
      startedAt,
      finishedAt,
      accountId: configuration.cloudflareAccountId,
      configurationSha256: sha256(parsedConfiguration.raw),
      stage: configuration.stage,
      resources: names,
      checks: {
        cleanupSucceeded: false,
        deploymentOutputValid: false,
        durableDataRetained: false,
        nativePlanNoWrites: false,
        repeatDeploymentNoDrift: false,
      },
      steps,
    });
    console.error(`Initial plan failed. Evidence: ${evidencePath}`);
    process.exitCode = 1;
    return;
  }

  const firstDeploy = await alchemy(
    "deploy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(firstDeploy));

  let repeatDeploy = {
    command: "repeat deploy skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  if (firstDeploy.exitCode === 0) {
    repeatDeploy = await alchemy(
      "deploy",
      "--yes",
      "--stage",
      configuration.stage,
    );
    steps.push(commandEvidence(repeatDeploy));
  }

  const destroy = await alchemy(
    "destroy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(destroy));

  let databaseInfo = {
    command: "D1 retention check skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  let bucketInfo = {
    command: "R2 retention check skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  let databaseDelete = {
    command: "D1 permanent cleanup skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  let bucketDelete = {
    command: "R2 permanent cleanup skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };

  if (firstDeploy.exitCode === 0 && destroy.exitCode === 0) {
    databaseInfo = await wrangler([
      "d1",
      "info",
      names.database,
      "--json",
    ]);
    bucketInfo = await wrangler([
      "r2",
      "bucket",
      "info",
      names.bucket,
      "--json",
    ]);
    steps.push(
      commandEvidence(databaseInfo),
      commandEvidence(bucketInfo),
    );

    if (databaseInfo.exitCode === 0 && bucketInfo.exitCode === 0) {
      databaseDelete = await wrangler([
        "d1",
        "delete",
        names.database,
        "--skip-confirmation",
      ]);
      bucketDelete = await wrangler(
        ["r2", "bucket", "delete", names.bucket],
        "y\n",
      );
      steps.push(
        commandEvidence(databaseDelete),
        commandEvidence(bucketDelete),
      );
    }
  }

  const durableDataRetained =
    databaseInfo.exitCode === 0 && bucketInfo.exitCode === 0;
  const cleanupSucceeded =
    destroy.exitCode === 0 &&
    databaseDelete.exitCode === 0 &&
    bucketDelete.exitCode === 0;
  const checks = {
    cleanupSucceeded,
    deploymentOutputValid: hasDeploymentOutput(
      repeatDeploy,
      configuration,
      names,
    ),
    durableDataRetained,
    nativePlanNoWrites: initialPlan.exitCode === 0,
    repeatDeploymentNoDrift: hasNoDrift(repeatDeploy),
  };
  const finishedAt = new Date().toISOString();
  const evidencePath = await writeEvidence({
    schemaVersion: 1,
    startedAt,
    finishedAt,
    accountId: configuration.cloudflareAccountId,
    configurationSha256: sha256(parsedConfiguration.raw),
    stage: configuration.stage,
    resources: names,
    checks,
    steps,
  });
  const passed = Object.values(checks).every(Boolean);
  const status = passed ? "passed" : "failed";
  console.log(`Cloudflare account probe ${status}: ${evidencePath}`);
  if (!passed) {
    process.exitCode = 1;
  }
};

await main();
