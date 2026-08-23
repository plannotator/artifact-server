#!/usr/bin/env node

import {homedir} from "node:os";
import {readFile} from "node:fs/promises";
import path from "node:path";

import {Command, Option} from "commander";
import {z} from "zod";

import {
  loadOrCreateLocalCredential,
  localCredentialFiles,
} from "../local/local-credentials.js";
import {
  removeOwnedLocalServiceRecord,
  writeLocalServiceRecord,
} from "../local/local-service-record.js";
import {startLocalServer} from "../local/start-local-server.js";
import {
  parseLinkRoots,
  parseLinkedFilesMode,
} from "../lifecycle/runtime-configuration.js";
import {loadNodeGitHistoryConfiguration} from
  "../git-history/node-git-history-configuration.js";
import {defaultCompletedRequestLogSampleRate} from
  "../observability/application-observability.js";
import {runCliEffect} from "./run-cli-effect.js";
import {localOwnerBrowserAccess} from "../core/browser-access.js";
import {configureLifecycleCommands} from "./lifecycle-commands.js";
import {configureCliAuthCommands} from "./cli-auth-commands.js";
import {configureLinkCommand} from "./link-command.js";
import {configureMcpOnboardingCommands} from "./mcp-onboarding-commands.js";
import {configurePublishCommand} from "./publish-command.js";
import {waitForProcessSignal} from "./wait-for-process-signal.js";
import {configureOpenManagementCommand} from "./open-management-command.js";
import {writeGitHistoryConfigurationWarnings} from
  "./git-history-configuration-warnings.js";

interface StartOptions {
  readonly data: string;
  readonly managed: boolean;
  readonly port: string;
}

const observabilityEnvironmentSchema = z.object({
  ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1)
    .default(defaultCompletedRequestLogSampleRate),
});
const packageMetadataSchema = z.object({version: z.string().min(1)});
const packageMetadata = packageMetadataSchema.parse(
  JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")),
);
const productBuild = {
  imageRevision: process.env["ARTIFACT_SERVER_IMAGE_REVISION"] ?? null,
  product: "artifact-server" as const,
  productVersion: packageMetadata.version,
  schemaVersion: 1,
};

const program = new Command()
  .name("artifactserver")
  .description("Run Artifact Server.")
  .version(packageMetadata.version)
  .showHelpAfterError();

const defaultUserDataDirectory = path.join(homedir(), ".artifact-server");

configureCliAuthCommands(program, {
  defaultProfileDirectory: defaultUserDataDirectory,
});
configurePublishCommand(program, {
  defaultProfileDirectory: defaultUserDataDirectory,
});
configureLinkCommand(program, {
  defaultProfileDirectory: defaultUserDataDirectory,
});
configureOpenManagementCommand(program, defaultUserDataDirectory);
configureDirectLocalStart(program);
configureLifecycleCommands(program, {build: productBuild});
configureMcpOnboardingCommands(program, {
  defaultDataDirectory: defaultUserDataDirectory,
  productVersion: packageMetadata.version,
});

try {
  await program.parseAsync();
} catch (cause) {
  process.exitCode = 1;
  process.stderr.write(`${renderCliFailure(cause)}\n`);
}

function configureDirectLocalStart(programToConfigure: Command): void {
  programToConfigure
    .command("start")
    .description("Start one direct local Artifact Server process.")
    .addOption(
      new Option("--data <directory>", "persistent data directory")
        .default(".artifact-server"),
    )
    .addOption(
      new Option("--port <number>", "HTTP port")
        .default("8787")
        .env("ARTIFACT_SERVER_PORT"),
    )
    .addOption(new Option("--managed").hideHelp().default(false))
    .action(async (options: StartOptions) => {
      const port = parsePort(options.port, options.managed);
      const dataDirectory = path.resolve(options.data);
      const apiToken = await loadOrCreateLocalCredential(
        dataDirectory,
        localCredentialFiles.api,
      );
      const browserBootstrapToken = await loadOrCreateLocalCredential(
        dataDirectory,
        localCredentialFiles.browser,
      );
      requireLocalOwnerEnvironment(process.env);
      const observability = observabilityEnvironmentSchema.parse(process.env);
      const gitHistory = await runCliEffect(
        loadNodeGitHistoryConfiguration(process.env),
      );
      writeGitHistoryConfigurationWarnings(gitHistory);
      const linkedFiles = await runCliEffect(parseLinkedFilesMode(process.env));
      const linkRoots = await runCliEffect(parseLinkRoots(process.env));
      const developmentProxyCredential =
        process.env["ARTIFACT_SERVER_DEVELOPMENT_PROXY_CREDENTIAL"];
      const localServerConfig = {
        apiToken,
        bootstrapAdministratorEmail:
          "local-administrator@artifactserver.invalid",
        browserAccess: localOwnerBrowserAccess,
        contentDomain: "localhost",
        completedRequestLogSampleRate:
          observability.ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE,
        dataDirectory,
        gitHistory,
        linkedFiles,
        linkRoots,
        localBootstrapToken: browserBootstrapToken,
        port,
        serviceVersion: packageMetadata.version,
      };
      const server = await startLocalServer(
        developmentProxyCredential === undefined
          ? localServerConfig
          : {...localServerConfig, developmentProxyCredential},
      );

      const origin = `http://localhost:${server.port}`;
      const serviceOrigin = `http://${server.hostname}:${server.port}`;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await server.close();
        } finally {
          if (options.managed) {
            await removeOwnedLocalServiceRecord(dataDirectory, process.pid);
          }
        }
      };
      try {
        if (options.managed) {
          await writeLocalServiceRecord(dataDirectory, {
            dataDirectory,
            origin: serviceOrigin,
            pid: process.pid,
            productVersion: packageMetadata.version,
            schemaVersion: 1,
            startedAt: new Date().toISOString(),
          });
        }
        console.log(`Artifact Server: ${origin}`);
        console.log(`Data directory: ${dataDirectory}`);
        await waitForProcessSignal(close);
      } catch (error) {
        await close();
        throw error;
      }
    });
}

function requireLocalOwnerEnvironment(environment: NodeJS.ProcessEnv): void {
  const remoteIdentityConfigured = Object.entries(environment).some(
    ([name, value]) => (
      name.startsWith("ARTIFACT_SERVER_OIDC_")
      || name.startsWith("ARTIFACT_SERVER_WORKOS_")
    ) && value !== undefined && value.trim() !== "",
  );
  if (remoteIdentityConfigured) {
    throw new Error(
      "artifactserver start is local-owner only; use a private-team deployment entrypoint for OIDC or WorkOS.",
    );
  }
}

function parsePort(value: string, allowAutomatic: boolean): number {
  const port = Number(value);
  const minimumPort = allowAutomatic ? 0 : 1;
  if (!Number.isInteger(port) || port < minimumPort || port > 65_535) {
    throw new Error("The port must be an integer between 1 and 65535.");
  }
  return port;
}

function renderCliFailure(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    return "Artifact Server: The command input or environment does not match the required format.";
  }
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return `Artifact Server: ${cause.message}`;
  }
  return "Artifact Server: The command failed.";
}
