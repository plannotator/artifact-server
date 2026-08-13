import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command, Option } from "commander";
import { Redacted } from "effect";
import { z } from "zod";

import { WorkOsIdentityProvider } from "../identity/workos-identity-provider.js";
import {startLocalServer} from "../local/start-local-server.js";
import {
  startExternalStorageServer,
  type ExternalStorageServerConfig,
} from "../external-storage/start-external-storage-server.js";
import type {ExternalObjectStorageConfig} from
  "../external-storage/create-external-storage-runtime.js";
import {defaultCompletedRequestLogSampleRate} from
  "../observability/application-observability.js";
import {configurePublishCommand} from "./publish-command.js";

interface StartOptions {
  readonly data: string;
  readonly port: string;
}

interface StartExternalStorageOptions {
  readonly host: string;
  readonly port: string;
}

const systemErrorSchema = z.object({code: z.string().optional()});
const bearerCredentialSchema = z.string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const postgresUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, {message: "The database URL must use postgres:// or postgresql://."});
const installationIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const requestLogSampleRateSchema = z.coerce.number().min(0).max(1)
  .default(defaultCompletedRequestLogSampleRate);
const observabilityEnvironmentSchema = z.object({
  ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: requestLogSampleRateSchema,
});
const workOsEnvironmentSchema = z.object({
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  ARTIFACT_SERVER_ORIGIN: z.url().optional(),
  ARTIFACT_SERVER_WORKOS_API_KEY: z.string().min(1).optional(),
  ARTIFACT_SERVER_WORKOS_CLIENT_ID: z.string().min(1).optional(),
});
const externalStorageEnvironmentSchema = z.object({
  ARTIFACT_SERVER_API_TOKEN: bearerCredentialSchema,
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: z.email(),
  ARTIFACT_SERVER_CONTENT_DOMAIN: z.hostname().default("localhost"),
  ARTIFACT_SERVER_DATABASE_URL: postgresUrlSchema,
  ARTIFACT_SERVER_INSTALLATION_ID: installationIdSchema,
  ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: bearerCredentialSchema.optional(),
  ARTIFACT_SERVER_ORIGIN: z.url().optional(),
  ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: requestLogSampleRateSchema,
  ARTIFACT_SERVER_S3_ACCESS_KEY_ID: z.string().min(1),
  ARTIFACT_SERVER_S3_BUCKET: z.string().min(3),
  ARTIFACT_SERVER_S3_ENDPOINT: z.url().optional(),
  ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: z.enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  ARTIFACT_SERVER_S3_REGION: z.string().min(1),
  ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: z.string().min(1),
  ARTIFACT_SERVER_WORKOS_API_KEY: z.string().min(1).optional(),
  ARTIFACT_SERVER_WORKOS_CLIENT_ID: z.string().min(1).optional(),
});

const program = new Command()
  .name("artifactserver")
  .description("Run Artifact Server.")
  .showHelpAfterError();

configurePublishCommand(program);

program
  .command("start")
  .description("Start one local Artifact Server process.")
  .addOption(
    new Option("--data <directory>", "persistent data directory")
      .default(".artifact-server"),
  )
  .addOption(
    new Option("--port <number>", "HTTP port")
      .default("8787")
      .env("ARTIFACT_SERVER_PORT"),
  )
  .action(async (options: StartOptions) => {
    const port = parsePort(options.port);
    const dataDirectory = path.resolve(options.data);
    const apiToken = await loadOrCreateLocalToken(
      dataDirectory,
      "local-api-token",
    );
    const browserBootstrapToken = await loadOrCreateLocalToken(
      dataDirectory,
      "local-browser-token",
    );
    const workOs = workOsConfiguration(process.env);
    const observability = observabilityEnvironmentSchema.parse(process.env);
    const server = await startLocalServer({
      apiToken,
      ...(workOs === null
        ? {
          bootstrapAdministratorEmail:
            "local-administrator@artifactserver.invalid",
        }
        : {
          applicationOrigin: workOs.applicationOrigin,
          bootstrapAdministratorEmail: workOs.bootstrapAdministratorEmail,
          interactiveIdentityProvider: new WorkOsIdentityProvider({
            apiKey: Redacted.make(workOs.apiKey, {label: "workos-api-key"}),
            clientId: workOs.clientId,
            redirectUri: new URL(
              "/auth/callback",
              workOs.applicationOrigin,
            ).toString(),
          }),
      }),
      contentDomain: "localhost",
      completedRequestLogSampleRate:
        observability.ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE,
      dataDirectory,
      localBootstrapToken: browserBootstrapToken,
      port,
    });

    console.log(`Artifact Server: http://localhost:${port}`);
    console.log(`Local API token: ${apiToken}`);
    const browserLoginUrl = new URL(`http://localhost:${port}/auth/local`);
    browserLoginUrl.searchParams.set("token", browserBootstrapToken);
    console.log(`Browser login: ${browserLoginUrl.toString()}`);
    if (workOs !== null) {
      console.log(`WorkOS login: ${new URL("/auth/login", workOs.applicationOrigin)}`);
    }
    console.log(`Data directory: ${dataDirectory}`);

    await new Promise<void>((resolve, reject) => {
      const shutdown = () => {
        void server.close().then(resolve, reject);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  });

program
  .command("start-external-storage")
  .description("Start one stateless Postgres and object-storage server process.")
  .addOption(
    new Option("--host <hostname>", "HTTP bind hostname")
      .default("127.0.0.1")
      .env("ARTIFACT_SERVER_HOST"),
  )
  .addOption(
    new Option("--port <number>", "HTTP port")
      .default("8787")
      .env("ARTIFACT_SERVER_PORT"),
  )
  .action(async (options: StartExternalStorageOptions) => {
    const environment = externalStorageEnvironmentSchema.parse(process.env);
    const workOs = workOsConfiguration(process.env);
    let objectStorage: ExternalObjectStorageConfig = {
      accessKeyId: environment.ARTIFACT_SERVER_S3_ACCESS_KEY_ID,
      bucket: environment.ARTIFACT_SERVER_S3_BUCKET,
      forcePathStyle: environment.ARTIFACT_SERVER_S3_FORCE_PATH_STYLE,
      region: environment.ARTIFACT_SERVER_S3_REGION,
      secretAccessKey: Redacted.make(
        environment.ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY,
        {label: "s3-secret-access-key"},
      ),
    };
    if (environment.ARTIFACT_SERVER_S3_ENDPOINT !== undefined) {
      objectStorage = {
        ...objectStorage,
        endpoint: environment.ARTIFACT_SERVER_S3_ENDPOINT,
      };
    }
    let serverConfig: ExternalStorageServerConfig = {
      apiToken: Redacted.make(environment.ARTIFACT_SERVER_API_TOKEN, {
        label: "external-storage-api-token",
      }),
      bootstrapAdministratorEmail:
        environment.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
      completedRequestLogSampleRate:
        environment.ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE,
      contentDomain: environment.ARTIFACT_SERVER_CONTENT_DOMAIN,
      databaseUrl: Redacted.make(environment.ARTIFACT_SERVER_DATABASE_URL, {
        label: "postgres-url",
      }),
      hostname: options.host,
      installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
      objectStorage,
      port: parsePort(options.port, true),
    };
    if (environment.ARTIFACT_SERVER_ORIGIN !== undefined) {
      serverConfig = {
        ...serverConfig,
        applicationOrigin: environment.ARTIFACT_SERVER_ORIGIN,
      };
    }
    if (workOs !== null) {
      serverConfig = {
        ...serverConfig,
        interactiveIdentityProvider: new WorkOsIdentityProvider({
          apiKey: Redacted.make(workOs.apiKey, {label: "workos-api-key"}),
          clientId: workOs.clientId,
          redirectUri: new URL(
            "/auth/callback",
            workOs.applicationOrigin,
          ).toString(),
        }),
      };
    }
    if (environment.ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN !== undefined) {
      serverConfig = {
        ...serverConfig,
        localBootstrapCredential: Redacted.make(
          environment.ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN,
          {label: "external-storage-browser-bootstrap"},
        ),
      };
    }
    const server = await startExternalStorageServer(serverConfig);
    const displayHostname = options.host === "0.0.0.0"
      ? "localhost"
      : server.hostname;
    console.log(
      `Artifact Server (external-storage): http://${displayHostname}:${server.port}`,
    );

    await new Promise<void>((resolve, reject) => {
      const shutdown = () => {
        void server.close().then(resolve, reject);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  });

await program.parseAsync();

function parsePort(value: string, allowEphemeral = false): number {
  const port = Number(value);
  const minimum = allowEphemeral ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(
      `The port must be an integer between ${minimum} and 65535.`,
    );
  }
  return port;
}

interface WorkOsConfiguration {
  readonly apiKey: string;
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clientId: string;
}

function workOsConfiguration(
  environment: NodeJS.ProcessEnv,
): WorkOsConfiguration | null {
  const parsed = workOsEnvironmentSchema.parse(environment);
  const providerValues = [
    parsed.ARTIFACT_SERVER_ORIGIN,
    parsed.ARTIFACT_SERVER_WORKOS_API_KEY,
    parsed.ARTIFACT_SERVER_WORKOS_CLIENT_ID,
  ];
  if (providerValues.every((value) => value === undefined)) return null;
  const requiredValues = [
    parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    ...providerValues,
  ];
  if (requiredValues.some((value) => value === undefined)) {
    throw new Error(
      "WorkOS login requires ARTIFACT_SERVER_ORIGIN, ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL, ARTIFACT_SERVER_WORKOS_API_KEY, and ARTIFACT_SERVER_WORKOS_CLIENT_ID.",
    );
  }
  return {
    apiKey: requireConfigured(parsed.ARTIFACT_SERVER_WORKOS_API_KEY),
    applicationOrigin: requireConfigured(parsed.ARTIFACT_SERVER_ORIGIN),
    bootstrapAdministratorEmail: requireConfigured(
      parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    ),
    clientId: requireConfigured(parsed.ARTIFACT_SERVER_WORKOS_CLIENT_ID),
  };
}

function requireConfigured(value: string | undefined): string {
  if (value === undefined) throw new Error("A required WorkOS value is missing.");
  return value;
}

async function loadOrCreateLocalToken(
  dataDirectory: string,
  filename: string,
): Promise<string> {
  const tokenPath = path.join(dataDirectory, filename);
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    await chmod(tokenPath, 0o600);
    return token;
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
  await chmod(tokenPath, 0o600);
  return token;
}
