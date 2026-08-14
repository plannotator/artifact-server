import path from "node:path";

import {type Command, Option} from "commander";
import {Redacted} from "effect";

import {
  startExternalStorageServer,
  type ExternalStorageServerConfig,
} from "../external-storage/start-external-storage-server.js";
import {WorkOsIdentityProvider} from "../identity/workos-identity-provider.js";
import {
  checkCompactIntegrity,
  checkExternalStorageIntegrity,
} from "../lifecycle/integrity-check.js";
import {initializeCompactInstallation} from
  "../lifecycle/compact-installation.js";
import {
  parseCompactRuntimeConfiguration,
  parseExternalMigrationConfiguration,
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
  type CompactRuntimeConfiguration,
  type ExternalStorageRuntimeConfiguration,
} from "../lifecycle/runtime-configuration.js";
import {inspectRuntimeConfiguration} from
  "../lifecycle/runtime-inspection.js";
import {
  createSupportManifest,
  type ProductBuildInformation,
} from "../lifecycle/support-manifest.js";
import {
  startLocalServer,
  type LocalServerConfig,
} from "../local/start-local-server.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {runCliEffect} from "./run-cli-effect.js";
import {waitForProcessSignal} from "./wait-for-process-signal.js";
import {loadWorkOsConfiguration} from "./workos-configuration.js";

interface StartExternalStorageOptions {
  readonly host: string;
  readonly port: string;
}

interface CompactOptions extends StartExternalStorageOptions {
  readonly data: string;
}

interface LifecycleOptions extends CompactOptions {
  readonly mode: "compact" | "external-storage";
}

interface InitOptions {
  readonly adminEmail: string;
  readonly data: string;
}

/** Values injected from the release entrypoint into lifecycle commands. */
export interface LifecycleCommandOptions {
  readonly build: ProductBuildInformation;
}

/** Register the complete operator lifecycle surface on one CLI program. */
export function configureLifecycleCommands(
  program: Command,
  options: LifecycleCommandOptions,
): void {
  configureInitialization(program);
  configureCompactStart(program, options.build.productVersion);
  configureConfigurationInspection(program);
  configureMigrations(program);
  configureSupportManifest(program, options.build);
  configureIntegrity(program);
  configureExternalStorageStart(program, options.build.productVersion);
}

function configureInitialization(program: Command): void {
  program
    .command("init")
    .description("Initialize an empty compact Artifact Server data directory.")
    .requiredOption("--admin-email <email>", "initial administrator email")
    .addOption(dataOption())
    .action(async (options: InitOptions) => {
      const initialized = await runCliEffect(initializeCompactInstallation({
        bootstrapAdministratorEmail: options.adminEmail,
        dataDirectory: options.data,
      }));
      console.log(JSON.stringify({
        bootstrapCredential: initialized.bootstrapCredential,
        dataDirectory: path.resolve(options.data),
        installationId: initialized.installationId,
      }, null, 2));
    });
}

function configureCompactStart(program: Command, productVersion: string): void {
  program
    .command("start-compact")
    .description("Start an initialized compact team server.")
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: CompactOptions) => {
      const configuration = await runCliEffect(
        parseCompactRuntimeConfiguration({
          dataDirectory: options.data,
          environment: process.env,
          hostname: options.host,
          port: options.port,
        }),
      );
      const server = await startCompactServer(configuration, productVersion);
      console.log(JSON.stringify({
        deploymentMode: "compact",
        hostname: server.hostname,
        port: server.port,
        status: "ready",
      }));
      await waitForProcessSignal(() => server.close());
    });
}

function configureConfigurationInspection(program: Command): void {
  const configCommand = program
    .command("config")
    .description("Inspect runtime configuration without serving.");
  configCommand
    .command("check")
    .description("Parse and inspect one exact runtime configuration.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const providers = await inspectRuntimeConfiguration(configuration);
      console.log(JSON.stringify({
        configuration: await summarizeConfiguration(configuration),
        providers,
      }, null, 2));
      if (providers.status !== "ready") process.exitCode = 2;
    });
}

function configureMigrations(program: Command): void {
  const migrateCommand = program
    .command("migrate")
    .description("Inspect or apply external-storage database migrations.");
  migrateCommand
    .command("status")
    .description("Report schema compatibility without changing Postgres.")
    .action(async () => {
      const configuration = await runCliEffect(
        parseExternalMigrationConfiguration(process.env),
      );
      const database = await PostgresDatabase.inspect({
        applicationName: `artifact-server-migration-status:${configuration.installationId}`,
        maxConnections: 1,
        url: configuration.databaseUrl,
      });
      try {
        console.log(JSON.stringify(await database.migrationStatus(), null, 2));
      } finally {
        await database.close();
      }
    });
  migrateCommand
    .command("apply")
    .description("Apply external-storage migrations under the advisory lock.")
    .action(async () => {
      const configuration = await runCliEffect(
        parseExternalMigrationConfiguration(process.env),
      );
      const database = await PostgresDatabase.open({
        applicationName: `artifact-server-migration-apply:${configuration.installationId}`,
        maxConnections: 1,
        url: configuration.databaseUrl,
      }, "apply");
      try {
        console.log(JSON.stringify(await database.migrationStatus(), null, 2));
      } finally {
        await database.close();
      }
    });
}

function configureSupportManifest(
  program: Command,
  build: ProductBuildInformation,
): void {
  const supportCommand = program
    .command("support")
    .description("Produce credential-free operator diagnostics.");
  supportCommand
    .command("manifest")
    .description("Print product, schema, provider, and configuration versions.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const providers = await inspectRuntimeConfiguration(configuration);
      console.log(JSON.stringify(createSupportManifest(
        build,
        await summarizeConfiguration(configuration),
        providers,
      ), null, 2));
    });
}

function configureIntegrity(program: Command): void {
  const integrityCommand = program
    .command("integrity")
    .description("Inspect committed records and bytes without repairing them.");
  integrityCommand
    .command("check")
    .description("Verify one compact or external-storage installation.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const report = options.mode === "compact"
        ? await runCliEffect(checkCompactIntegrity(path.resolve(options.data)))
        : await checkExternalStorageIntegrity(await parseExternalConfiguration(
          options.host,
          options.port,
        ));
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "healthy") process.exitCode = 2;
    });
}

function configureExternalStorageStart(
  program: Command,
  productVersion: string,
): void {
  program
    .command("start-external-storage")
    .description("Start one stateless Postgres and object-storage server process.")
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: StartExternalStorageOptions) => {
      const parsed = await parseExternalConfiguration(options.host, options.port);
      const workOs = await loadWorkOsConfiguration(process.env);
      let serverConfig: ExternalStorageServerConfig = {
        apiToken: parsed.apiToken,
        applicationOrigin: parsed.applicationOrigin,
        bootstrapAdministratorEmail: parsed.bootstrapAdministratorEmail,
        completedRequestLogSampleRate: parsed.completedRequestLogSampleRate,
        contentDomain: parsed.contentDomain,
        databaseUrl: parsed.databaseUrl,
        hostname: parsed.hostname,
        installationId: parsed.installationId,
        objectStorage: parsed.objectStorage,
        port: parsed.port,
        readinessWithdrawalMilliseconds: parsed.readinessWithdrawalMilliseconds,
        serviceVersion: productVersion,
        shutdownDeadlineMilliseconds: parsed.shutdownDeadlineMilliseconds,
      };
      if (workOs !== null) {
        serverConfig = {
          ...serverConfig,
          interactiveIdentityProvider: new WorkOsIdentityProvider({
            apiKey: workOs.apiKey,
            clientId: workOs.clientId,
            redirectUri: new URL(
              "/auth/callback",
              workOs.applicationOrigin,
            ).toString(),
          }),
        };
      }
      if (parsed.localBootstrapCredential !== null) {
        serverConfig = {
          ...serverConfig,
          localBootstrapCredential: parsed.localBootstrapCredential,
        };
      }
      const server = await startExternalStorageServer(serverConfig);
      const displayHostname = options.host === "0.0.0.0"
        ? "localhost"
        : server.hostname;
      console.log(
        `Artifact Server (external-storage): http://${displayHostname}:${server.port}`,
      );
      await waitForProcessSignal(() => server.close());
    });
}

async function startCompactServer(
  configuration: CompactRuntimeConfiguration,
  productVersion: string,
) {
  const workOs = await loadWorkOsConfiguration({
    ...process.env,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
      configuration.bootstrapAdministratorEmail,
    ARTIFACT_SERVER_ORIGIN: configuration.applicationOrigin,
  });
  let serverConfig: LocalServerConfig = {
    apiToken: Redacted.value(configuration.apiToken),
    applicationOrigin: configuration.applicationOrigin,
    bootstrapAdministratorEmail: configuration.bootstrapAdministratorEmail,
    completedRequestLogSampleRate: configuration.completedRequestLogSampleRate,
    contentDomain: configuration.contentDomain,
    dataDirectory: configuration.dataDirectory,
    hostname: configuration.hostname,
    installationId: configuration.installation.installationId,
    localBootstrapToken: Redacted.value(configuration.browserBootstrapToken),
    port: configuration.port,
    readinessWithdrawalMilliseconds:
      configuration.readinessWithdrawalMilliseconds,
    serviceVersion: productVersion,
    shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
  };
  if (workOs !== null) {
    serverConfig = {
      ...serverConfig,
      interactiveIdentityProvider: new WorkOsIdentityProvider({
        apiKey: workOs.apiKey,
        clientId: workOs.clientId,
        redirectUri: new URL(
          "/auth/callback",
          workOs.applicationOrigin,
        ).toString(),
      }),
    };
  }
  return startLocalServer(serverConfig);
}

async function lifecycleConfiguration(
  options: LifecycleOptions,
): Promise<CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration> {
  return options.mode === "compact"
    ? runCliEffect(parseCompactRuntimeConfiguration({
      dataDirectory: options.data,
      environment: process.env,
      hostname: options.host,
      port: options.port,
    }))
    : parseExternalConfiguration(options.host, options.port);
}

async function summarizeConfiguration(
  configuration: CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration,
) {
  const workOs = await loadWorkOsConfiguration({
    ...process.env,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
      configuration.bootstrapAdministratorEmail,
    ARTIFACT_SERVER_ORIGIN: configuration.applicationOrigin,
  });
  return summarizeRuntimeConfiguration(
    configuration,
    workOs === null ? "local" : "workos",
  );
}

function parseExternalConfiguration(
  hostname = process.env["ARTIFACT_SERVER_HOST"] ?? "127.0.0.1",
  port = process.env["ARTIFACT_SERVER_PORT"] ?? "8787",
): Promise<ExternalStorageRuntimeConfiguration> {
  return runCliEffect(parseExternalStorageRuntimeConfiguration({
    environment: process.env,
    hostname,
    port,
  }));
}

function modeOption(): Option {
  return new Option("--mode <mode>", "compact or external-storage")
    .choices(["compact", "external-storage"])
    .default("compact");
}

function dataOption(): Option {
  return new Option("--data <directory>", "compact data directory")
    .default(".artifact-server");
}

function hostOption(): Option {
  return new Option("--host <hostname>", "HTTP bind hostname")
    .default("127.0.0.1")
    .env("ARTIFACT_SERVER_HOST");
}

function portOption(): Option {
  return new Option("--port <number>", "HTTP port")
    .default("8787")
    .env("ARTIFACT_SERVER_PORT");
}
