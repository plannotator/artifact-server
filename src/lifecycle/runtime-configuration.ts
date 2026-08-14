import {constants} from "node:fs";
import {access, readFile, stat} from "node:fs/promises";
import path from "node:path";

import {Effect, Option, Redacted, Schema} from "effect";
import {getDomain} from "tldts";

import type {ExternalObjectStorageConfig} from
  "../external-storage/create-external-storage-runtime.js";
import {
  compactInstallationLayout,
  readCompactInstallation,
  type CompactInstallationMetadata,
} from "./compact-installation.js";

const bearerCredentialSchema = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/u),
);
const emailSchema = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  Schema.isMaxLength(320),
);
const hostnameSchema = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u),
);
const installationIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
);
const requestLogSampleRateSchema = Schema.NumberFromString.check(
  Schema.isBetween({minimum: 0, maximum: 1}),
);
const postgresUrlSchema = Schema.String.check(
  Schema.isPattern(/^postgres(?:ql)?:\/\/[^\s]+$/u),
);
const urlStringSchema = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s]+$/u),
);
const systemErrorSchema = Schema.Struct({code: Schema.optional(Schema.String)});

/** Runtime mode selected by one lifecycle command. */
export type DeploymentMode = "compact" | "external-storage";

/** Where a configured credential was loaded without exposing its value. */
export type CredentialSource =
  | "environment"
  | "file"
  | "generated_file"
  | "provider_chain";
type ConfiguredCredentialSource = "environment" | "file";

/** Parsed compact configuration used by serving and lifecycle commands. */
export interface CompactRuntimeConfiguration {
  readonly apiToken: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly browserBootstrapToken: Redacted.Redacted;
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string;
  readonly dataDirectory: string;
  readonly deploymentMode: "compact";
  readonly hostname: string;
  readonly installation: CompactInstallationMetadata;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
}

/** Parsed external-storage configuration used by serving and lifecycle commands. */
export interface ExternalStorageRuntimeConfiguration {
  readonly apiToken: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string;
  readonly credentialSources: Readonly<Record<
    "apiToken" | "database" | "objectStorageAccessKey" | "objectStorageSecret",
    CredentialSource
  >>;
  readonly databaseUrl: Redacted.Redacted;
  readonly deploymentMode: "external-storage";
  readonly hostname: string;
  readonly installationId: string;
  readonly localBootstrapCredential: Redacted.Redacted | null;
  readonly objectStorage: ExternalObjectStorageConfig;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
}

/** Minimum external-storage configuration required by migration commands. */
export interface ExternalMigrationConfiguration {
  readonly databaseCredentialSource: ConfiguredCredentialSource;
  readonly databaseUrl: Redacted.Redacted;
  readonly installationId: string;
}

/** Public, credential-free summary emitted by `config check`. */
export interface RuntimeConfigurationSummary {
  readonly applicationOrigin: string;
  readonly contentDomain: string;
  readonly credentialSources: Readonly<Record<string, CredentialSource>>;
  readonly dataDirectory: string | null;
  readonly deploymentMode: DeploymentMode;
  readonly hostname: string;
  readonly installationId: string;
  readonly interactiveIdentityProvider: "local" | "workos";
  readonly objectStorageProvider: "filesystem" | "s3";
  readonly port: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
  readonly status: "valid";
}

/** One expected runtime configuration or secret-loading failure. */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "RuntimeConfigurationError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "conflicting_secret_sources",
      "incomplete_configuration",
      "invalid_origin",
      "invalid_value",
      "missing_value",
      "path_unavailable",
      "secret_unreadable",
    ]),
  },
) {}

/** Parse only the values required to inspect or migrate Postgres. */
export const parseExternalMigrationConfiguration = Effect.fn(
  "parseExternalMigrationConfiguration",
)(function*(
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ExternalMigrationConfiguration, RuntimeConfigurationError> {
  const databaseUrl = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_DATABASE_URL",
    postgresUrlSchema,
  );
  yield* assertPostgresUrl(Redacted.value(databaseUrl.value));
  return {
    databaseCredentialSource: databaseUrl.source,
    databaseUrl: databaseUrl.value,
    installationId: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_INSTALLATION_ID",
      environment["ARTIFACT_SERVER_INSTALLATION_ID"],
      installationIdSchema,
    ),
  };
});

/** Parse and inspect the compact runtime before it opens a listener. */
export const parseCompactRuntimeConfiguration = Effect.fn(
  "parseCompactRuntimeConfiguration",
)(function*(input: {
  readonly dataDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
  readonly port: string;
}): Effect.fn.Return<CompactRuntimeConfiguration, RuntimeConfigurationError> {
  const installation = yield* readCompactInstallation(input.dataDirectory).pipe(
    Effect.mapError((error) => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: error.message,
      reason: "path_unavailable",
    })),
  );
  const layout = compactInstallationLayout(input.dataDirectory);
  yield* ensureRestoreIsComplete(layout.restoreIncompletePath);
  const apiToken = yield* readGeneratedSecret(
    layout.apiTokenPath,
    "ARTIFACT_SERVER_API_TOKEN",
    bearerCredentialSchema,
  );
  const browserBootstrapToken = yield* readGeneratedSecret(
    layout.browserBootstrapTokenPath,
    "ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN",
    bearerCredentialSchema,
  );
  const applicationOrigin = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_ORIGIN",
    input.environment["ARTIFACT_SERVER_ORIGIN"],
    urlStringSchema,
  );
  const contentDomain = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_CONTENT_DOMAIN",
    input.environment["ARTIFACT_SERVER_CONTENT_DOMAIN"],
    hostnameSchema,
  );
  yield* assertBrowserIsolation(applicationOrigin, contentDomain);
  yield* ensureWritableDirectory(layout.dataDirectory);
  return {
    apiToken,
    applicationOrigin,
    bootstrapAdministratorEmail: installation.bootstrapAdministratorEmail,
    browserBootstrapToken,
    completedRequestLogSampleRate: yield* parseSampleRate(input.environment),
    contentDomain,
    dataDirectory: layout.dataDirectory,
    deploymentMode: "compact",
    hostname: yield* parseHostname(input.hostname),
    installation,
    port: yield* parsePort(input.port),
    readinessWithdrawalMilliseconds: yield* parseMilliseconds(
      input.environment,
      "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS",
      1_000,
    ),
    shutdownDeadlineMilliseconds: yield* parseMilliseconds(
      input.environment,
      "ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS",
      10_000,
    ),
  };
});

/** Parse external-storage configuration and secret files without connecting. */
export const parseExternalStorageRuntimeConfiguration = Effect.fn(
  "parseExternalStorageRuntimeConfiguration",
)(function*(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
  readonly port: string;
}): Effect.fn.Return<
  ExternalStorageRuntimeConfiguration,
  RuntimeConfigurationError
> {
  const environment = input.environment;
  const applicationOrigin = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_ORIGIN",
    environment["ARTIFACT_SERVER_ORIGIN"],
    urlStringSchema,
  );
  const contentDomain = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_CONTENT_DOMAIN",
    environment["ARTIFACT_SERVER_CONTENT_DOMAIN"],
    hostnameSchema,
  );
  yield* assertBrowserIsolation(applicationOrigin, contentDomain);
  const forcePathStyle = environment["ARTIFACT_SERVER_S3_FORCE_PATH_STYLE"] ?? "false";
  if (forcePathStyle !== "true" && forcePathStyle !== "false") {
    return yield* invalidValue(
      "ARTIFACT_SERVER_S3_FORCE_PATH_STYLE",
      "The S3 path-style setting must be true or false.",
    );
  }
  const endpoint = environment["ARTIFACT_SERVER_S3_ENDPOINT"];
  const accessKeyId = yield* loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
    Schema.NonEmptyString,
  );
  const secretAccessKey = yield* loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY",
    Schema.NonEmptyString,
  );
  if ((accessKeyId === null) !== (secretAccessKey === null)) {
    return yield* new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
      message: "The S3 access key ID and secret access key must be configured together.",
      reason: "incomplete_configuration",
    });
  }
  const objectStorageBase = {
    bucket: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_S3_BUCKET",
      environment["ARTIFACT_SERVER_S3_BUCKET"],
      Schema.String.check(Schema.isMinLength(3)),
    ),
    forcePathStyle: forcePathStyle === "true",
    region: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_S3_REGION",
      environment["ARTIFACT_SERVER_S3_REGION"],
      Schema.NonEmptyString,
    ),
  };
  const staticCredentials = accessKeyId === null || secretAccessKey === null
    ? {}
    : {
      accessKeyId: Redacted.value(accessKeyId.value),
      secretAccessKey: secretAccessKey.value,
    };
  const configuredEndpoint = endpoint === undefined
    ? {}
    : {
      endpoint: yield* parseRequiredEnvironment(
        "ARTIFACT_SERVER_S3_ENDPOINT",
        endpoint,
        urlStringSchema,
      ),
    };
  const objectStorage: ExternalObjectStorageConfig = {
    ...objectStorageBase,
    ...staticCredentials,
    ...configuredEndpoint,
  };
  if (objectStorage.endpoint !== undefined) {
    yield* assertHttpServiceUrl(
      "ARTIFACT_SERVER_S3_ENDPOINT",
      objectStorage.endpoint,
    );
  }
  const localBootstrapCredential = yield* loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN",
    bearerCredentialSchema,
  );
  const apiToken = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_API_TOKEN",
    bearerCredentialSchema,
  );
  const databaseUrl = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_DATABASE_URL",
    postgresUrlSchema,
  );
  yield* assertPostgresUrl(Redacted.value(databaseUrl.value));
  return {
    apiToken: apiToken.value,
    applicationOrigin,
    bootstrapAdministratorEmail: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL",
      environment["ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL"],
      emailSchema,
    ),
    completedRequestLogSampleRate: yield* parseSampleRate(environment),
    contentDomain,
    credentialSources: {
      apiToken: apiToken.source,
      database: databaseUrl.source,
      objectStorageAccessKey: accessKeyId?.source ?? "provider_chain",
      objectStorageSecret: secretAccessKey?.source ?? "provider_chain",
    },
    databaseUrl: databaseUrl.value,
    deploymentMode: "external-storage",
    hostname: yield* parseHostname(input.hostname),
    installationId: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_INSTALLATION_ID",
      environment["ARTIFACT_SERVER_INSTALLATION_ID"],
      installationIdSchema,
    ),
    localBootstrapCredential: localBootstrapCredential?.value ?? null,
    objectStorage,
    port: yield* parsePort(input.port),
    readinessWithdrawalMilliseconds: yield* parseMilliseconds(
      environment,
      "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS",
      1_000,
    ),
    shutdownDeadlineMilliseconds: yield* parseMilliseconds(
      environment,
      "ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS",
      10_000,
    ),
  };
});

/** Render the safe, stable subset of one parsed runtime configuration. */
export function summarizeRuntimeConfiguration(
  configuration: CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration,
  interactiveIdentityProvider: "local" | "workos" = "local",
): RuntimeConfigurationSummary {
  if (configuration.deploymentMode === "compact") {
    return {
      applicationOrigin: configuration.applicationOrigin,
      contentDomain: configuration.contentDomain,
      credentialSources: {
        apiToken: "generated_file",
        browserBootstrapToken: "generated_file",
      },
      dataDirectory: configuration.dataDirectory,
      deploymentMode: configuration.deploymentMode,
      hostname: configuration.hostname,
      installationId: configuration.installation.installationId,
      interactiveIdentityProvider,
      objectStorageProvider: "filesystem",
      port: configuration.port,
      readinessWithdrawalMilliseconds:
        configuration.readinessWithdrawalMilliseconds,
      shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
      status: "valid",
    };
  }
  return {
    applicationOrigin: configuration.applicationOrigin,
    contentDomain: configuration.contentDomain,
    credentialSources: {
      ...configuration.credentialSources,
    },
    dataDirectory: null,
    deploymentMode: configuration.deploymentMode,
    hostname: configuration.hostname,
    installationId: configuration.installationId,
    interactiveIdentityProvider,
    objectStorageProvider: "s3",
    port: configuration.port,
    readinessWithdrawalMilliseconds:
      configuration.readinessWithdrawalMilliseconds,
    shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
    status: "valid",
  };
}

/** A credential plus its safe configuration-source label. */
export interface LoadedSecret {
  readonly source: ConfiguredCredentialSource;
  readonly value: Redacted.Redacted;
}

function readSecret<T>(
  environment: NodeJS.ProcessEnv,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<LoadedSecret, RuntimeConfigurationError> {
  return loadOptionalCredential(environment, name, schema).pipe(
    Effect.flatMap((value) => value === null
      ? missingValue(name)
      : Effect.succeed(value)),
  );
}

/** Load one optional direct or file-backed credential with conflict checks. */
export function loadOptionalCredential<T>(
  environment: NodeJS.ProcessEnv,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<LoadedSecret | null, RuntimeConfigurationError> {
  const direct = environment[name];
  const fileName = `${name}_FILE`;
  const filePath = environment[fileName];
  if (direct !== undefined && filePath !== undefined) {
    return new RuntimeConfigurationError({
      field: name,
      message: `${name} and ${fileName} cannot both be configured.`,
      reason: "conflicting_secret_sources",
    });
  }
  if (direct === undefined && filePath === undefined) return Effect.succeed(null);
  if (direct !== undefined) {
    return parseRequiredEnvironment(name, direct, schema).pipe(
      Effect.map((value) => ({
        source: "environment" as const,
        value: Redacted.make(String(value), {label: name}),
      })),
    );
  }
  if (filePath === undefined) return Effect.succeed(null);
  return Effect.tryPromise({
    try: () => readFile(path.resolve(filePath), "utf8"),
    catch: () => new RuntimeConfigurationError({
      field: fileName,
      message: `The secret file for ${name} cannot be read.`,
      reason: "secret_unreadable",
    }),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap((value) => parseRequiredEnvironment(name, value, schema)),
    Effect.map((value) => ({
      source: "file" as const,
      value: Redacted.make(String(value), {label: name}),
    })),
  );
}

function readGeneratedSecret<T>(
  filePath: string,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<Redacted.Redacted, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      const metadata = await stat(filePath);
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error("generated secret permissions are too broad");
      }
      return readFile(filePath, "utf8");
    },
    catch: () => new RuntimeConfigurationError({
      field: name,
      message: `The generated secret file for ${name} cannot be read.`,
      reason: "secret_unreadable",
    }),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap((value) => parseRequiredEnvironment(name, value, schema)),
    Effect.map((value) => Redacted.make(String(value), {label: name})),
  );
}

function parseRequiredEnvironment<T>(
  field: string,
  value: string | undefined,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<T, RuntimeConfigurationError> {
  if (value === undefined || value === "") {
    return missingValue(field);
  }
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new RuntimeConfigurationError({
      field,
      message: `${field} has an invalid value.`,
      reason: "invalid_value",
    })),
  );
}

function parseSampleRate(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<number, RuntimeConfigurationError> {
  return parseRequiredEnvironment(
    "ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE",
    environment["ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE"] ?? "0.05",
    requestLogSampleRateSchema,
  );
}

function parseMilliseconds(
  environment: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
): Effect.Effect<number, RuntimeConfigurationError> {
  const value = environment[field] ?? String(fallback);
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return invalidValue(
      field,
      `${field} must be a non-negative integer number of milliseconds.`,
    );
  }
  return Effect.succeed(milliseconds);
}

function parseHostname(
  value: string,
): Effect.Effect<string, RuntimeConfigurationError> {
  if (value === "0.0.0.0" || value === "127.0.0.1" || value === "::1") {
    return Effect.succeed(value);
  }
  return parseRequiredEnvironment("ARTIFACT_SERVER_HOST", value, hostnameSchema);
}

function parsePort(
  value: string,
): Effect.Effect<number, RuntimeConfigurationError> {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return invalidValue(
      "ARTIFACT_SERVER_PORT",
      "The port must be an integer between 0 and 65535.",
    );
  }
  return Effect.succeed(port);
}

function assertPostgresUrl(
  value: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(value);
  } catch {
    return invalidValue(
      "ARTIFACT_SERVER_DATABASE_URL",
      "The database URL must be a valid postgres:// or postgresql:// URL.",
    );
  }
  return databaseUrl.protocol === "postgres:" ||
    databaseUrl.protocol === "postgresql:"
    ? Effect.void
    : invalidValue(
      "ARTIFACT_SERVER_DATABASE_URL",
      "The database URL must use postgres:// or postgresql://.",
    );
}

function assertHttpServiceUrl(
  field: string,
  value: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(value);
  } catch {
    return invalidValue(field, `${field} must be a valid HTTP or HTTPS URL.`);
  }
  if (
    (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") ||
    serviceUrl.username !== "" || serviceUrl.password !== ""
  ) {
    return invalidValue(
      field,
      `${field} must use HTTP or HTTPS and cannot contain credentials.`,
    );
  }
  return Effect.void;
}

function assertBrowserIsolation(
  applicationOrigin: string,
  contentDomain: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  let origin: URL;
  try {
    origin = new URL(applicationOrigin);
  } catch {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "The application origin must be an absolute HTTP or HTTPS URL.",
      "invalid_origin",
    );
  }
  if (
    origin.username !== "" || origin.password !== "" ||
    origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
  ) {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "The application origin cannot contain credentials, a path, query, or fragment.",
      "invalid_origin",
    );
  }
  if (origin.protocol !== "https:") {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "Compact and external-storage application origins must use HTTPS.",
      "invalid_origin",
    );
  }
  const applicationDomain = getDomain(origin.hostname, {allowPrivateDomains: true});
  const publishedDomain = getDomain(contentDomain, {allowPrivateDomains: true});
  if (
    applicationDomain === null || publishedDomain === null ||
    applicationDomain === publishedDomain
  ) {
    return invalidValue(
      "ARTIFACT_SERVER_CONTENT_DOMAIN",
      "The application and published content must use different registrable domains.",
      "invalid_origin",
    );
  }
  return Effect.void;
}

function ensureWritableDirectory(
  dataDirectory: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      const metadata = await stat(dataDirectory);
      if (!metadata.isDirectory()) throw new Error("not a directory");
      await access(dataDirectory, constants.R_OK | constants.W_OK);
    },
    catch: () => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: "The compact data directory is not a writable directory.",
      reason: "path_unavailable",
    }),
  });
}

function ensureRestoreIsComplete(
  markerPath: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await access(markerPath, constants.F_OK);
      } catch (error) {
        const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
        if (Option.isSome(parsed) && parsed.value.code === "ENOENT") return;
        throw error;
      }
      throw new Error("compact restore is incomplete");
    },
    catch: () => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: "The compact data directory contains an incomplete restore.",
      reason: "path_unavailable",
    }),
  });
}

function missingValue(
  field: string,
): Effect.Effect<never, RuntimeConfigurationError> {
  return new RuntimeConfigurationError({
    field,
    message: `${field} is required.`,
    reason: "missing_value",
  });
}

function invalidValue(
  field: string,
  message: string,
  reason: "invalid_origin" | "invalid_value" = "invalid_value",
): Effect.Effect<never, RuntimeConfigurationError> {
  return new RuntimeConfigurationError({field, message, reason});
}
