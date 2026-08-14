#!/usr/bin/env node

import {randomBytes} from "node:crypto";
import {chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command, Option} from "commander";
import {z} from "zod";

import {WorkOsIdentityProvider} from "../identity/workos-identity-provider.js";
import {startLocalServer} from "../local/start-local-server.js";
import {defaultCompletedRequestLogSampleRate} from
  "../observability/application-observability.js";
import {configureLifecycleCommands} from "./lifecycle-commands.js";
import {configurePublishCommand} from "./publish-command.js";
import {waitForProcessSignal} from "./wait-for-process-signal.js";
import {loadWorkOsConfiguration} from "./workos-configuration.js";

interface StartOptions {
  readonly data: string;
  readonly port: string;
}

const systemErrorSchema = z.object({code: z.string().optional()});
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

configurePublishCommand(program);
configureDirectLocalStart(program);
configureLifecycleCommands(program, {build: productBuild});

await program.parseAsync();

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
      const workOs = await loadWorkOsConfiguration(process.env);
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
              apiKey: workOs.apiKey,
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
        serviceVersion: packageMetadata.version,
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

      await waitForProcessSignal(() => server.close());
    });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The port must be an integer between 1 and 65535.");
  }
  return port;
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
  await writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(tokenPath, 0o600);
  return token;
}
