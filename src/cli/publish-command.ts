import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Option, type Command} from "commander";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {
  type FilePublicationCommand,
  type FilePublicationFailure,
  type FilePublicationResult,
  publishPath,
} from "../client/file-publication-client.js";
import {resolveVerifiedProfileCredential} from "./cli-auth-commands.js";
import {
  readCliProfileState,
  resolveCliProfile,
  type CliProfile,
} from "./cli-profile-store.js";
import {runCliEffect} from "./run-cli-effect.js";
import {createSystemCredentialStore} from "./system-credential-store.js";

interface PublishOptions {
  readonly artifact?: string;
  readonly data: string;
  readonly entry?: string;
  readonly expectedVersion?: string;
  readonly name?: string;
  readonly public: boolean;
  readonly project?: string;
  readonly profile?: string;
  readonly profileData: string;
  readonly routing: "spa" | "static";
  readonly server?: string;
  readonly tag: readonly string[];
  readonly tokenFile?: string;
}

/** User-local configuration shared by auth and publishing commands. */
export interface PublishCommandOptions {
  readonly defaultProfileDirectory: string;
}

interface PublicationConnection {
  readonly apiToken: Redacted.Redacted;
  readonly origin: string;
  readonly profile?: CliProfile;
}

const bearerCredentialSchema = z.string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/u);

/** Add the file-first publication command to the Artifact Server CLI. */
export function configurePublishCommand(
  program: Command,
  commandOptions: PublishCommandOptions,
): void {
  program
    .command("publish")
    .description("Publish one file or finished directory.")
    .argument("<path>", "file or finished directory to publish")
    .addOption(
      new Option("--server <origin>", "Artifact Server origin")
        .env("ARTIFACT_SERVER_URL"),
    )
    .addOption(
      new Option("--data <directory>", "local Artifact Server data directory")
        .default(".artifact-server"),
    )
    .addOption(
      new Option("--token-file <path>", "file containing an Artifact Server API token"),
    )
    .addOption(new Option("--profile <name>", "saved Artifact Server profile"))
    .addOption(
      new Option("--profile-data <directory>", "user-local CLI profile directory")
        .default(commandOptions.defaultProfileDirectory)
        .env("ARTIFACT_SERVER_HOME"),
    )
    .addOption(new Option("--entry <path>", "directory file that opens first"))
    .addOption(
      new Option("--routing <mode>", "path routing for the published files")
        .choices(["static", "spa"])
        .default("static"),
    )
    .addOption(new Option("--name <name>", "name for a new artifact"))
    .addOption(new Option("--public", "allow the link to open without sign-in").default(false))
    .addOption(
      new Option("--tag <tag>", "tag for a new artifact; repeat for more tags")
        .argParser(collectTag)
        .default([]),
    )
    .addOption(new Option("--artifact <id>", "artifact ID when publishing a new version"))
    .addOption(new Option("--project <id>", "project ID; optional when one active project exists"))
    .addOption(
      new Option(
        "--expected-version <id>",
        "current version ID required when publishing a new version",
      ),
    )
    .action(async (inputPath: string, options: PublishOptions) => {
      let connection = await resolvePublicationConnection(options);
      const command = publicationCommand(inputPath, options);
      let outcome = await executePublication(connection, command);
      if (
        !outcome.success
        && outcome.error._tag === "FilePublicationProtocolError"
        && outcome.error.status === 401
        && connection.profile?.authentication === "oauth"
      ) {
        connection = await resolveProfileConnection(
          path.resolve(options.profileData),
          connection.profile,
          true,
        );
        outcome = await executePublication(connection, command);
      }
      if (!outcome.success) throw cliPublicationError(outcome.error);
      console.log(JSON.stringify(outcome.result, null, 2));
    });
}

function publicationCommand(
  inputPath: string,
  options: PublishOptions,
): FilePublicationCommand {
  const hasArtifact = options.artifact !== undefined;
  const hasExpectedVersion = options.expectedVersion !== undefined;
  if (hasArtifact !== hasExpectedVersion) {
    throw new Error(
      "Publishing a new version requires both --artifact and --expected-version.",
    );
  }

  const idempotencyKey = randomBytes(24).toString("base64url");
  const common: Omit<FilePublicationCommand, "entryPath" | "target"> =
    options.project === undefined
      ? {idempotencyKey, inputPath, routingMode: options.routing}
      : {
        idempotencyKey,
        inputPath,
        projectId: options.project,
        routingMode: options.routing,
      };
  if (options.artifact !== undefined && options.expectedVersion !== undefined) {
    if (options.name !== undefined || options.public || options.tag.length > 0) {
      throw new Error(
        "--name, --public, and --tag apply only when creating a new artifact.",
      );
    }
    return withEntryPath({
      ...common,
      target: {
        artifactId: options.artifact,
        expectedCurrentVersionId: options.expectedVersion,
        kind: "new_version",
      },
    }, options.entry);
  }

  const target = options.name === undefined
    ? {
      accessSetting: options.public ? "public_link" as const : "account_required" as const,
      kind: "new_artifact" as const,
      tags: options.tag,
    }
    : {
      accessSetting: options.public ? "public_link" as const : "account_required" as const,
      kind: "new_artifact" as const,
      name: options.name,
      tags: options.tag,
    };
  return withEntryPath({
    ...common,
    target,
  }, options.entry);
}

async function resolvePublicationConnection(
  options: PublishOptions,
): Promise<PublicationConnection> {
  const explicitToken = await loadExplicitApiToken(options);
  const dataDirectory = path.resolve(options.profileData);
  if (explicitToken !== undefined) {
    if (options.server === undefined) {
      throw new Error(
        "ARTIFACT_SERVER_API_TOKEN and --token-file require --server or ARTIFACT_SERVER_URL so the credential has one explicit destination.",
      );
    }
    return {
      apiToken: explicitToken,
      origin: options.server,
    };
  }

  if (options.profile !== undefined) {
    const profile = options.server === undefined
      ? await runCliEffect(resolveCliProfile(dataDirectory, {
        name: options.profile,
      }))
      : await runCliEffect(resolveCliProfile(dataDirectory, {
        name: options.profile,
        origin: options.server,
      }));
    return resolveProfileConnection(dataDirectory, profile);
  }

  if (options.server !== undefined && !isLoopbackServer(options.server)) {
    const profile = await runCliEffect(resolveCliProfile(dataDirectory, {
      origin: options.server,
    }));
    return resolveProfileConnection(dataDirectory, profile);
  }

  if (options.server === undefined) {
    const state = await runCliEffect(readCliProfileState(dataDirectory));
    const defaultProfile = state.profiles.find(
      (profile) => profile.id === state.defaultProfileId,
    );
    if (defaultProfile !== undefined) {
      return resolveProfileConnection(dataDirectory, defaultProfile);
    }
  }

  return {
    apiToken: await loadLocalApiToken(options),
    origin: options.server ?? "http://localhost:8787",
  };
}

async function resolveProfileConnection(
  dataDirectory: string,
  profile: CliProfile,
  forceRefresh = false,
): Promise<PublicationConnection> {
  const resolved = await runCliEffect(resolveVerifiedProfileCredential(
    dataDirectory,
    profile,
    createSystemCredentialStore(),
    forceRefresh,
  ).pipe(Effect.provide(FetchHttpClient.layer)));
  return {
    apiToken: resolved.bearer,
    origin: profile.origin,
    profile,
  };
}

async function loadExplicitApiToken(
  options: PublishOptions,
): Promise<Redacted.Redacted | undefined> {
  const environmentToken = process.env["ARTIFACT_SERVER_API_TOKEN"];
  if (options.tokenFile === undefined && environmentToken !== undefined) {
    const parsed = bearerCredentialSchema.safeParse(environmentToken);
    if (!parsed.success) {
      throw new Error("ARTIFACT_SERVER_API_TOKEN is invalid.");
    }
    return Redacted.make(parsed.data, {label: "artifact-server-api-token"});
  }
  if (options.tokenFile === undefined) return undefined;

  const tokenPath = path.resolve(options.tokenFile);
  let candidate: string;
  try {
    candidate = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    throw new Error(
      `Artifact Server API token not found at ${tokenPath}.`,
    );
  }
  const parsed = bearerCredentialSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The API token in ${tokenPath} is invalid.`);
  }
  return Redacted.make(parsed.data, {label: "artifact-server-api-token"});
}

async function loadLocalApiToken(
  options: PublishOptions,
): Promise<Redacted.Redacted> {
  const tokenPath = path.resolve(
    path.join(options.data, "local-api-token"),
  );
  let candidate: string;
  try {
    candidate = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    throw new Error(
      `Local Artifact Server API token not found at ${tokenPath}. Run artifactserver up or artifactserver start first.`,
    );
  }
  const parsed = bearerCredentialSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The local API token in ${tokenPath} is invalid.`);
  }
  return Redacted.make(parsed.data, {label: "artifact-server-api-token"});
}

async function executePublication(
  connection: PublicationConnection,
  command: FilePublicationCommand,
): Promise<
  | {readonly error: FilePublicationFailure; readonly success: false}
  | {readonly result: FilePublicationResult; readonly success: true}
> {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: connection.apiToken,
        serverOrigin: connection.origin,
      },
      command,
    ).pipe(
      Effect.match({
        onFailure: (error) => ({error, success: false} as const),
        onSuccess: (result) => ({result, success: true} as const),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function isLoopbackServer(candidate: string): boolean {
  try {
    const hostname = new URL(candidate).hostname;
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "[::1]";
  } catch {
    return false;
  }
}

function collectTag(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function withEntryPath(
  command: Omit<FilePublicationCommand, "entryPath">,
  entryPath: string | undefined,
): FilePublicationCommand {
  if (entryPath === undefined) return command;
  return {...command, entryPath};
}

function cliPublicationError(error: FilePublicationFailure): Error {
  if (error._tag === "FilePublicationProtocolError") {
    const code = error.serverCode ?? error._tag;
    const status = error.status === null ? "" : ` (HTTP ${error.status})`;
    return new Error(`${code}${status}: ${error.message}`, {cause: error});
  }
  return new Error(`${error._tag}: ${error.message}`, {cause: error});
}
