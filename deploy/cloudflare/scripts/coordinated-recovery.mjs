import {spawn} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import * as Schema from "effect/Schema";

import {
  decodeRecoveryConfiguration,
  normalizeRecoveryCommandArguments,
  validateEmptyRestoreTargets,
  validateRecoveryPolicy,
} from "../src/recovery-command-policy.ts";

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECOVERY_WORKER_PATH = resolve(
  PACKAGE_DIRECTORY,
  "src/recovery-worker.ts",
);
const APPLICATION_WORKER_PATH = resolve(PACKAGE_DIRECTORY, "src/worker.ts");
const COMPATIBILITY_DATE = "2026-08-15";
const MAX_CAPTURE_BYTES = 1_000_000;
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const R2ObjectInventory = Schema.Array(Schema.Struct({key: Schema.String}));
const WorkersSubdomain = Schema.Struct({subdomain: NonEmptyString});
const Inspection = Schema.Struct({
  foreignKeyViolations: Schema.Literal(0),
  identitySha256: NonEmptyString,
  integrity: Schema.Struct({
    artifactsChecked: Schema.Int,
    blobsChecked: Schema.Int,
    bytesChecked: Schema.Int,
    manifestsChecked: Schema.Int,
    problemCount: Schema.Literal(0),
    status: Schema.Literal("healthy"),
    versionsChecked: Schema.Int,
  }),
  objectCount: Schema.Int.check(Schema.isGreaterThan(0)),
  objectInventorySha256: NonEmptyString,
  schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  stateSha256: NonEmptyString,
  tableRows: Schema.Record(Schema.String, Schema.Int),
});
const CopyResult = Schema.Struct({
  byteExact: Schema.Int.check(Schema.isGreaterThan(0)),
  copied: Schema.Int.check(Schema.isGreaterThan(0)),
  customMetadataExact: Schema.Int.check(Schema.isGreaterThan(0)),
  httpMetadataExact: Schema.Int.check(Schema.isGreaterThan(0)),
});
const AuthToken = Schema.Struct({
  token: NonEmptyString,
  type: Schema.Literals(["api_token", "oauth"]),
});
const RecoveryFailure = Schema.Struct({
  error: Schema.Literal("recovery_operation_failed"),
  operation: Schema.Literals([
    "copy_source_objects",
    "inspect_restore_target",
    "list_restored_objects",
    "list_source_objects",
    "restore_target_not_empty",
    "restored_object_count_mismatch",
    "source_objects_empty",
    "source_scope_mismatch",
    "unknown",
    "validate_source_scope",
    "verify_restored_objects",
  ]),
});
const RecoveryReadiness = Schema.Struct({
  mode: Schema.Literals(["copy", "restore", "source"]),
});
const decodeR2ObjectInventory = Schema.decodeUnknownSync(R2ObjectInventory);
const decodeWorkersSubdomain = Schema.decodeUnknownSync(WorkersSubdomain);
const decodeInspection = Schema.decodeUnknownSync(Inspection);
const decodeCopyResult = Schema.decodeUnknownSync(CopyResult);
const decodeAuthToken = Schema.decodeUnknownSync(Schema.fromJsonString(AuthToken));
const decodeRecoveryFailure = Schema.decodeUnknownOption(RecoveryFailure);
const decodeRecoveryReadiness = Schema.decodeUnknownOption(RecoveryReadiness);

const usage = `Usage:
  pnpm recovery:coordinated -- \\
    --config /absolute/path/to/recovery.json \\
    --confirm-account <account-id> \\
    --confirm-source-database <database-name> \\
    --confirm-source-bucket <bucket-name> \\
    --confirm-restore-database <database-name> \\
    --confirm-restore-bucket <bucket-name> \\
    --confirm-source-writes-quiesced <offline-worker-name> \\
    --evidence /absolute/path/to/redacted-evidence.json

Qualification cleanup additionally requires:
    --cleanup-qualification-resources \\
    --confirm-qualification-cleanup <installation-id>
`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const capture = (current, chunk) =>
  `${current}${chunk}`.slice(-MAX_CAPTURE_BYTES);

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
        exitCode: 1,
        stderr: capture(stderr, error.message),
        stdout,
      });
    });
    child.on("close", (code) => {
      resolveResult({exitCode: code ?? 1, stderr, stdout});
    });
    child.stdin.end(input);
  });

const commandEvidence = (operation, result) => ({
  operation,
  exitCode: result.exitCode,
  stderrSha256: sha256(result.stderr),
  stdoutSha256: sha256(result.stdout),
});

const requireSuccessfulCommand = (operation, result, steps) => {
  steps.push(commandEvidence(operation, result));
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed; raw provider output was suppressed.`);
  }
};

const resolveCloudflareApiToken = async () => {
  const configured = process.env.CLOUDFLARE_API_TOKEN;
  if (Schema.is(NonEmptyString)(configured)) return configured;
  const result = await runCommand(
    "pnpm",
    ["exec", "wrangler", "auth", "token", "--json"],
    {
      ...process.env,
      FORCE_COLOR: "0",
      WRANGLER_SEND_METRICS: "false",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "No Cloudflare API token or authenticated Wrangler session is available.",
    );
  }
  try {
    return decodeAuthToken(result.stdout).token;
  } catch {
    throw new Error("Wrangler returned unsupported Cloudflare credentials.");
  }
};

const parseOptions = () => parseArgs({
  args: normalizeRecoveryCommandArguments(process.argv.slice(2)),
  options: {
    "cleanup-qualification-resources": {
      default: false,
      type: "boolean",
    },
    config: {type: "string"},
    "confirm-account": {type: "string"},
    "confirm-qualification-cleanup": {type: "string"},
    "confirm-restore-bucket": {type: "string"},
    "confirm-restore-database": {type: "string"},
    "confirm-source-bucket": {type: "string"},
    "confirm-source-database": {type: "string"},
    "confirm-source-writes-quiesced": {type: "string"},
    evidence: {type: "string"},
    help: {default: false, type: "boolean"},
  },
  strict: true,
}).values;

const requiredOption = (options, name) => {
  const value = options[name];
  if (!Schema.is(NonEmptyString)(value)) {
    throw new Error(`--${name} is required.`);
  }
  return value;
};

const parseConfiguration = async (path) =>
  decodeRecoveryConfiguration(await readFile(path, "utf8"));

const apiUrl = (accountId, path) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;

const cloudflareApi = async (
  accountId,
  apiToken,
  path,
  requestOptions = {},
) => {
  const headers = new Headers(requestOptions.headers);
  headers.set("Authorization", `Bearer ${apiToken}`);
  if (requestOptions.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiUrl(accountId, path), {
    ...requestOptions,
    headers,
  });
  let document;
  try {
    document = await response.json();
  } catch {
    document = undefined;
  }
  return {document, ok: response.ok, status: response.status};
};

const requireApiResult = (operation, response) => {
  if (!response.ok || response.document?.success !== true) {
    throw new Error(`${operation} failed with provider status ${response.status}.`);
  }
  return response.document.result;
};

const resolveDatabase = async (configuration, target, label) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/d1/database/${target.databaseId}`,
  );
  const result = requireApiResult(`resolve ${label} D1`, response);
  if (result?.uuid !== target.databaseId || result?.name !== target.databaseName) {
    throw new Error(`${label} D1 ID and name do not resolve to the same target.`);
  }
};

const resolveBucket = async (configuration, bucketName, label) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/r2/buckets/${encodeURIComponent(bucketName)}`,
  );
  const result = requireApiResult(`resolve ${label} R2`, response);
  if (result?.name !== bucketName) {
    throw new Error(`${label} R2 name did not resolve exactly.`);
  }
};

const workerExists = async (configuration, workerName) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/workers/scripts/${encodeURIComponent(workerName)}`,
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Worker resolution failed with provider status ${response.status}.`);
  }
  return true;
};

const listR2Objects = async (configuration, bucketName, cursor) => {
  const query = new URLSearchParams({per_page: "1000"});
  if (cursor !== undefined) query.set("cursor", cursor);
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query}`,
  );
  const result = requireApiResult("list exact R2 bucket", response);
  let inventory;
  try {
    inventory = decodeR2ObjectInventory(result);
  } catch {
    throw new Error("Cloudflare returned an invalid R2 object inventory.");
  }
  const keys = inventory.map(({key}) => key);
  const truncated = response.document.result_info?.is_truncated === true;
  const nextCursor = response.document.result_info?.cursor;
  if (truncated && !Schema.is(NonEmptyString)(nextCursor)) {
    throw new Error("Cloudflare omitted the next R2 inventory cursor.");
  }
  if (!truncated) return keys;
  return [
    ...keys,
    ...await listR2Objects(configuration, bucketName, nextCursor),
  ];
};

const countApplicationTables = async (configuration) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/d1/database/${configuration.restore.databaseId}/query`,
    {
      body: JSON.stringify({
        sql: `SELECT COUNT(*) AS tableCount FROM sqlite_master
          WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'`,
      }),
      method: "POST",
    },
  );
  const result = requireApiResult("inspect restore D1", response);
  const tableCount = result?.[0]?.results?.[0]?.tableCount;
  if (!Number.isInteger(tableCount) || tableCount < 0) {
    throw new Error("Cloudflare returned an invalid D1 table count.");
  }
  return tableCount;
};

const workersSubdomain = async (configuration) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    "/workers/subdomain",
  );
  const result = requireApiResult("resolve workers.dev subdomain", response);
  let decoded;
  try {
    decoded = decodeWorkersSubdomain(result);
  } catch {
    throw new Error("Cloudflare did not return a workers.dev subdomain.");
  }
  return decoded.subdomain;
};

const wranglerEnvironment = (configuration) => ({
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: configuration.cloudflareAccountId,
  FORCE_COLOR: "0",
  WRANGLER_SEND_METRICS: "false",
});

const writeJson = async (path, value, mode = 0o600) => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {mode});
};

const databaseBinding = (binding, target) => ({
  binding,
  database_id: target.databaseId,
  database_name: target.databaseName,
});

const bucketBinding = (binding, bucketName) => ({
  binding,
  bucket_name: bucketName,
});

const baseWorkerConfiguration = (configuration, name, main) => ({
  account_id: configuration.cloudflareAccountId,
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat"],
  main,
  name,
  workers_dev: true,
});

const deployWorker = async (
  operation,
  wranglerConfiguration,
  secrets,
  temporaryDirectory,
  environment,
  steps,
) => {
  const configPath = resolve(temporaryDirectory, `${operation}.wrangler.json`);
  const secretsPath = resolve(temporaryDirectory, `${operation}.secrets.json`);
  await writeJson(configPath, wranglerConfiguration);
  await writeJson(secretsPath, secrets);
  const result = await runCommand(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", configPath, "--secrets-file", secretsPath],
    environment,
  );
  requireSuccessfulCommand(operation, result, steps);
};

const deployRecoveryWorker = async (
  configuration,
  mode,
  recoveryToken,
  temporaryDirectory,
  environment,
  steps,
) => {
  const worker = baseWorkerConfiguration(
    configuration,
    configuration.recoveryWorkerName,
    RECOVERY_WORKER_PATH,
  );
  worker.vars = {
    ARTIFACT_SERVER_INSTALLATION_ID: configuration.installationId,
    ARTIFACT_SERVER_RECOVERY_MODE: mode,
  };
  if (mode === "copy") {
    worker.r2_buckets = [
      bucketBinding("SOURCE_R2", configuration.source.bucketName),
      bucketBinding("TARGET_R2", configuration.restore.bucketName),
    ];
  } else {
    const target = mode === "source"
      ? configuration.source
      : configuration.restore;
    worker.d1_databases = [databaseBinding("RECOVERY_D1", target)];
    worker.r2_buckets = [bucketBinding("RECOVERY_R2", target.bucketName)];
  }
  await deployWorker(
    `deploy-recovery-${mode}`,
    worker,
    {ARTIFACT_SERVER_RECOVERY_TOKEN: recoveryToken},
    temporaryDirectory,
    environment,
    steps,
  );
};

const requestRecoveryWorker = async (
  workerUrl,
  recoveryToken,
  pathname,
  method,
  operation,
  attempts = 60,
) => {
  let response;
  try {
    response = await fetch(new URL(pathname, workerUrl), {
      headers: {Authorization: `Bearer ${recoveryToken}`},
      method,
    });
  } catch {
    if (method !== "GET" || attempts <= 1) {
      throw new Error(`Recovery Worker ${pathname} could not be reached.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    return requestRecoveryWorker(
      workerUrl,
      recoveryToken,
      pathname,
      method,
      operation,
      attempts - 1,
    );
  }
  if (response.status === 404 && attempts > 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    return requestRecoveryWorker(
      workerUrl,
      recoveryToken,
      pathname,
      method,
      operation,
      attempts - 1,
    );
  }
  let document;
  try {
    document = await response.json();
  } catch {
    document = undefined;
  }
  if (!response.ok) {
    const failure = decodeRecoveryFailure(document);
    const operationSuffix = failure._tag === "Some"
      ? ` during ${failure.value.operation}`
      : "";
    throw new Error(
      `Recovery Worker ${operation} failed${operationSuffix} with status ${response.status}.`,
    );
  }
  return document;
};

const awaitRecoveryMode = async (
  workerUrl,
  recoveryToken,
  expectedMode,
  attempts = 40,
) => {
  let document;
  try {
    const response = await fetch(new URL("/ready", workerUrl), {
      headers: {Authorization: `Bearer ${recoveryToken}`},
    });
    if (response.ok) document = await response.json();
  } catch {
    document = undefined;
  }
  const readiness = decodeRecoveryReadiness(document);
  if (
    readiness._tag === "Some" &&
    readiness.value.mode === expectedMode
  ) return;
  if (attempts <= 1) {
    throw new Error(
      `Recovery Worker did not activate ${expectedMode} mode.`,
    );
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  return awaitRecoveryMode(
    workerUrl,
    recoveryToken,
    expectedMode,
    attempts - 1,
  );
};

const validateInspection = (inspection, label) => {
  try {
    return decodeInspection(inspection);
  } catch {
    throw new Error(`${label} integrity inspection failed.`);
  }
};

const validateCopy = (copy) => {
  let decoded;
  try {
    decoded = decodeCopyResult(copy);
  } catch {
    throw new Error("R2 copy verification failed.");
  }
  if (
    decoded.byteExact !== decoded.copied ||
    decoded.customMetadataExact !== decoded.copied ||
    decoded.httpMetadataExact !== decoded.copied
  ) throw new Error("R2 copy verification failed.");
  return decoded;
};

const sanitizedInspection = (inspection) => ({
  foreignKeyViolations: inspection.foreignKeyViolations,
  identitySha256: inspection.identitySha256,
  integrity: inspection.integrity,
  objectCount: inspection.objectCount,
  objectInventorySha256: inspection.objectInventorySha256,
  schemaVersion: inspection.schemaVersion,
  stateSha256: inspection.stateSha256,
  tableRows: inspection.tableRows,
});

const deleteWorker = async (configuration, workerName) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/workers/scripts/${encodeURIComponent(workerName)}`,
    {method: "DELETE"},
  );
  if (response.status !== 404 && !response.ok) {
    throw new Error(`Could not delete exact Worker ${workerName}.`);
  }
};

const emptyBucket = async (configuration, bucketName) => {
  const keys = await listR2Objects(configuration, bucketName);
  const deleted = await Promise.all(keys.map(async (key) => {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const response = await cloudflareApi(
      configuration.cloudflareAccountId,
      process.env.CLOUDFLARE_API_TOKEN,
      `/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedKey}`,
      {method: "DELETE"},
    );
    return response.ok;
  }));
  if (deleted.some((value) => !value)) {
    throw new Error(`Could not empty exact R2 bucket ${bucketName}.`);
  }
  return keys.length;
};

const deleteBucket = async (configuration, bucketName) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/r2/buckets/${encodeURIComponent(bucketName)}`,
    {method: "DELETE"},
  );
  if (!response.ok) throw new Error(`Could not delete exact R2 bucket ${bucketName}.`);
};

const deleteDatabase = async (configuration, databaseId) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    `/d1/database/${databaseId}`,
    {method: "DELETE"},
  );
  if (!response.ok) throw new Error(`Could not delete exact D1 database ${databaseId}.`);
};

const resourceIsAbsent = async (configuration, path) => {
  const response = await cloudflareApi(
    configuration.cloudflareAccountId,
    process.env.CLOUDFLARE_API_TOKEN,
    path,
  );
  if (response.status === 404) return true;
  if (!response.ok) {
    throw new Error("Could not verify qualification resource cleanup.");
  }
  return false;
};

const deployApplicationWorker = async (
  configuration,
  temporaryDirectory,
  environment,
  steps,
) => {
  const worker = baseWorkerConfiguration(
    configuration,
    configuration.restore.workerName,
    APPLICATION_WORKER_PATH,
  );
  worker.d1_databases = [
    databaseBinding("ARTIFACT_SERVER_D1_DATABASE", configuration.restore),
  ];
  worker.r2_buckets = [
    bucketBinding("ARTIFACT_SERVER_R2_BUCKET", configuration.restore.bucketName),
  ];
  worker.vars = {
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "recovery-operator@invalid.example",
    ARTIFACT_SERVER_CONTENT_DOMAIN: "recovered.invalid",
    ARTIFACT_SERVER_INSTALLATION_ID: configuration.installationId,
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "recovery-qualification",
    ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.invalid",
    ARTIFACT_SERVER_ORIGIN: "https://recovered.invalid",
    ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
  };
  await deployWorker(
    "deploy-restored-application",
    worker,
    {ARTIFACT_SERVER_API_TOKEN: randomBytes(32).toString("base64url")},
    temporaryDirectory,
    environment,
    steps,
  );
};

const awaitStatus = async (url, expectedStatus, attempts) => {
  try {
    const response = await fetch(url);
    if (response.status === expectedStatus) return response.status;
  } catch {
    // A newly deployed workers.dev route can take a short time to become visible.
  }
  if (attempts <= 1) throw new Error(`Expected HTTP ${expectedStatus} from restored Worker.`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  return awaitStatus(url, expectedStatus, attempts - 1);
};

const cleanupQualification = async (configuration) => {
  await Promise.all([
    deleteWorker(configuration, configuration.recoveryWorkerName),
    deleteWorker(configuration, configuration.restore.workerName),
  ]);
  const [sourceObjectsDeleted, restoreObjectsDeleted] = await Promise.all([
    emptyBucket(configuration, configuration.source.bucketName),
    emptyBucket(configuration, configuration.restore.bucketName),
  ]);
  await Promise.all([
    deleteBucket(configuration, configuration.source.bucketName),
    deleteBucket(configuration, configuration.restore.bucketName),
  ]);
  await Promise.all([
    deleteDatabase(configuration, configuration.source.databaseId),
    deleteDatabase(configuration, configuration.restore.databaseId),
  ]);
  const absent = await Promise.all([
    workerExists(configuration, configuration.recoveryWorkerName),
    workerExists(configuration, configuration.restore.workerName),
    resourceIsAbsent(
      configuration,
      `/d1/database/${configuration.source.databaseId}`,
    ),
    resourceIsAbsent(
      configuration,
      `/d1/database/${configuration.restore.databaseId}`,
    ),
    resourceIsAbsent(
      configuration,
      `/r2/buckets/${encodeURIComponent(configuration.source.bucketName)}`,
    ),
    resourceIsAbsent(
      configuration,
      `/r2/buckets/${encodeURIComponent(configuration.restore.bucketName)}`,
    ),
  ]);
  const [recoveryWorkerPresent, restoreWorkerPresent, ...durableAbsent] = absent;
  if (
    recoveryWorkerPresent || restoreWorkerPresent ||
    durableAbsent.some((value) => !value)
  ) {
    throw new Error("Qualification Worker cleanup verification failed.");
  }
  return {
    confirmed: true,
    databasesRemaining: false,
    restoreObjectsDeleted,
    r2BucketsRemaining: false,
    sourceObjectsDeleted,
    workersRemaining: false,
  };
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const options = parseOptions();
  if (options.help) {
    console.log(usage);
    return;
  }
  const configuration = await parseConfiguration(resolve(requiredOption(options, "config")));
  const evidencePath = resolve(requiredOption(options, "evidence"));
  const cleanupRequested = options["cleanup-qualification-resources"];
  const confirmations = {
    accountId: requiredOption(options, "confirm-account"),
    cleanupInstallationId: options["confirm-qualification-cleanup"],
    restoreBucketName: requiredOption(options, "confirm-restore-bucket"),
    restoreDatabaseName: requiredOption(options, "confirm-restore-database"),
    sourceBucketName: requiredOption(options, "confirm-source-bucket"),
    sourceDatabaseName: requiredOption(options, "confirm-source-database"),
    sourceWriterWorkerName: requiredOption(
      options,
      "confirm-source-writes-quiesced",
    ),
  };
  const policyFailures = validateRecoveryPolicy(
    configuration,
    confirmations,
    cleanupRequested,
  );
  if (policyFailures.length > 0) {
    throw new Error(`Recovery policy rejected the request:\n- ${policyFailures.join("\n- ")}`);
  }
  process.env.CLOUDFLARE_API_TOKEN = await resolveCloudflareApiToken();
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "artifact-server-cloudflare-recovery-"),
  );
  const steps = [];
  let recoveryWorkerDeployed = false;
  let restoredWorkerDeployed = false;
  let completed = false;
  try {
    await Promise.all([
      resolveDatabase(configuration, configuration.source, "source"),
      resolveDatabase(configuration, configuration.restore, "restore"),
      resolveBucket(configuration, configuration.source.bucketName, "source"),
      resolveBucket(configuration, configuration.restore.bucketName, "restore"),
    ]);
    const [sourceWriterPresent, recoveryWorkerPresent, restoredWorkerPresent] =
      await Promise.all([
        workerExists(configuration, configuration.source.writerWorkerName),
        workerExists(configuration, configuration.recoveryWorkerName),
        workerExists(configuration, configuration.restore.workerName),
      ]);
    if (sourceWriterPresent) {
      throw new Error("Source writes are not quiesced: the named writer Worker exists.");
    }
    if (recoveryWorkerPresent || restoredWorkerPresent) {
      throw new Error("A recovery target Worker name is already in use.");
    }
    const [applicationTableCount, restoreObjectKeys, subdomain] = await Promise.all([
      countApplicationTables(configuration),
      listR2Objects(configuration, configuration.restore.bucketName),
      workersSubdomain(configuration),
    ]);
    const emptyFailures = validateEmptyRestoreTargets(
      applicationTableCount,
      restoreObjectKeys.length,
    );
    if (emptyFailures.length > 0) {
      throw new Error(`Recovery target rejected:\n- ${emptyFailures.join("\n- ")}`);
    }
    const environment = wranglerEnvironment(configuration);
    const recoveryToken = randomBytes(32).toString("base64url");
    const recoveryUrl = new URL(
      `https://${configuration.recoveryWorkerName}.${subdomain}.workers.dev`,
    );
    await deployRecoveryWorker(
      configuration,
      "source",
      recoveryToken,
      temporaryDirectory,
      environment,
      steps,
    );
    recoveryWorkerDeployed = true;
    await awaitRecoveryMode(recoveryUrl, recoveryToken, "source");
    const sourceBefore = validateInspection(
      await requestRecoveryWorker(
        recoveryUrl,
        recoveryToken,
        "/inspect",
        "GET",
        "source-before",
      ),
      "source before export",
    );
    const exportPath = resolve(temporaryDirectory, "d1-export.sql");
    const sourceD1Config = resolve(temporaryDirectory, "source-d1.wrangler.json");
    await writeJson(sourceD1Config, {
      ...baseWorkerConfiguration(configuration, configuration.recoveryWorkerName, RECOVERY_WORKER_PATH),
      d1_databases: [databaseBinding("RECOVERY_D1", configuration.source)],
    });
    const exportResult = await runCommand(
      "pnpm",
      [
        "exec", "wrangler", "d1", "export", configuration.source.databaseName,
        "--remote", "--output", exportPath, "--skip-confirmation",
        "--config", sourceD1Config,
      ],
      environment,
    );
    requireSuccessfulCommand("export-source-d1", exportResult, steps);
    await chmod(exportPath, 0o600);
    const exportBytes = await readFile(exportPath);
    const exportStat = await stat(exportPath);
    await deployRecoveryWorker(
      configuration,
      "copy",
      recoveryToken,
      temporaryDirectory,
      environment,
      steps,
    );
    await awaitRecoveryMode(recoveryUrl, recoveryToken, "copy");
    const copy = validateCopy(
      await requestRecoveryWorker(
        recoveryUrl,
        recoveryToken,
        "/copy",
        "POST",
        "r2-copy",
      ),
    );
    const restoreD1Config = resolve(temporaryDirectory, "restore-d1.wrangler.json");
    await writeJson(restoreD1Config, {
      ...baseWorkerConfiguration(configuration, configuration.recoveryWorkerName, RECOVERY_WORKER_PATH),
      d1_databases: [databaseBinding("RECOVERY_D1", configuration.restore)],
    });
    const importResult = await runCommand(
      "pnpm",
      [
        "exec", "wrangler", "d1", "execute", configuration.restore.databaseName,
        "--remote", "--file", exportPath, "--yes", "--config", restoreD1Config,
      ],
      environment,
    );
    requireSuccessfulCommand("import-restore-d1", importResult, steps);
    await deployRecoveryWorker(
      configuration,
      "source",
      recoveryToken,
      temporaryDirectory,
      environment,
      steps,
    );
    await awaitRecoveryMode(recoveryUrl, recoveryToken, "source");
    const sourceAfter = validateInspection(
      await requestRecoveryWorker(
        recoveryUrl,
        recoveryToken,
        "/inspect",
        "GET",
        "source-after",
      ),
      "source after export",
    );
    if (
      sourceAfter.stateSha256 !== sourceBefore.stateSha256 ||
      sourceAfter.objectInventorySha256 !== sourceBefore.objectInventorySha256 ||
      sourceAfter.identitySha256 !== sourceBefore.identitySha256
    ) {
      throw new Error("Source changed after the recovery snapshot began.");
    }
    await deployRecoveryWorker(
      configuration,
      "restore",
      recoveryToken,
      temporaryDirectory,
      environment,
      steps,
    );
    await awaitRecoveryMode(recoveryUrl, recoveryToken, "restore");
    const restored = validateInspection(
      await requestRecoveryWorker(
        recoveryUrl,
        recoveryToken,
        "/inspect",
        "GET",
        "restored-targets",
      ),
      "restored targets",
    );
    if (
      restored.stateSha256 !== sourceBefore.stateSha256 ||
      restored.objectInventorySha256 !== sourceBefore.objectInventorySha256 ||
      restored.identitySha256 !== sourceBefore.identitySha256
    ) {
      throw new Error("Restored D1 or R2 state differs from the source snapshot.");
    }
    await deployApplicationWorker(
      configuration,
      temporaryDirectory,
      environment,
      steps,
    );
    restoredWorkerDeployed = true;
    const restoredUrl = new URL(
      `https://${configuration.restore.workerName}.${subdomain}.workers.dev`,
    );
    const [healthStatus, readinessStatus] = await Promise.all([
      awaitStatus(new URL("/health", restoredUrl), 200, 20),
      awaitStatus(new URL("/ready", restoredUrl), 200, 20),
    ]);
    const destruction = cleanupRequested
      ? await cleanupQualification(configuration)
      : {confirmed: false};
    if (cleanupRequested) {
      recoveryWorkerDeployed = false;
      restoredWorkerDeployed = false;
    } else {
      await deleteWorker(configuration, configuration.recoveryWorkerName);
      recoveryWorkerDeployed = false;
    }
    const evidence = {
      accountId: configuration.cloudflareAccountId,
      backup: {
        d1ExportBytes: exportStat.size,
        d1ExportSha256: createHash("sha256").update(exportBytes).digest("hex"),
        providerOperation: "wrangler d1 export/import --remote",
      },
      checks: {
        exactBytes: restored.objectInventorySha256 === sourceBefore.objectInventorySha256,
        healthStatus,
        normalIntegrity: restored.integrity.status,
        readinessStatus,
        sourceStayedQuiesced: sourceAfter.stateSha256 === sourceBefore.stateSha256 &&
          sourceAfter.objectInventorySha256 === sourceBefore.objectInventorySha256,
        stableIdentifiers: restored.identitySha256 === sourceBefore.identitySha256,
      },
      destruction,
      finishedAt: new Date().toISOString(),
      installationId: configuration.installationId,
      qualification: "Cloudflare coordinated D1 and R2 recovery",
      resources: {
        recoveryWorkerName: configuration.recoveryWorkerName,
        restore: configuration.restore,
        source: configuration.source,
      },
      result: "pass",
      r2Copy: copy,
      schemaVersion: 1,
      restored: sanitizedInspection(restored),
      source: sanitizedInspection(sourceBefore),
      startedAt,
      steps,
    };
    await mkdir(dirname(evidencePath), {recursive: true});
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {mode: 0o600});
    completed = true;
    console.log(`Recovery qualification passed. Redacted evidence: ${evidencePath}`);
  } finally {
    if (!completed) {
      if (restoredWorkerDeployed) {
        await deleteWorker(configuration, configuration.restore.workerName).catch(() => undefined);
      }
      if (recoveryWorkerDeployed) {
        await deleteWorker(configuration, configuration.recoveryWorkerName).catch(() => undefined);
      }
    }
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Recovery failed.");
  process.exitCode = 1;
});
