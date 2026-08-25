import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Option, type Command} from "commander";
import {Effect} from "effect";

import {
  type FilePublicationFailure,
  type FilePublicationIntent,
  type FilePublicationResult,
  prepareFilePublication,
  type PreparedFilePublication,
  publishPreparedPath,
} from "../client/file-publication-client.js";
import {
  authenticatedCliHttpClientLayer,
  resolveCliServerConnection,
  type CliServerConnection,
} from "./cli-server-connection.js";
import {resumePublicationOperation} from "./publication-operation-store.js";

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
      let connection = await resolveCliServerConnection(options, "publish");
      const intent = publicationCommand(inputPath, options);
      const prepared = await preparePublication(intent);
      const operation = await resumePublicationOperation(
        path.resolve(options.profileData),
        connection.origin,
        prepared.operationScopeDigest,
        prepared.operationDigest,
      );
      let outcome = await executePublication(
        connection,
        operation.idempotencyKey,
        prepared,
      );
      if (
        !outcome.success
        && outcome.error._tag === "FilePublicationProtocolError"
        && outcome.error.status === 401
        && connection.profile?.authentication === "oauth"
      ) {
        connection = await resolveCliServerConnection(options, "publish", true);
        outcome = await executePublication(
          connection,
          operation.idempotencyKey,
          prepared,
        );
      }
      if (!outcome.success) throw cliPublicationError(outcome.error);
      console.log(JSON.stringify(outcome.result, null, 2));
      await operation.complete();
    });
}

function publicationCommand(
  inputPath: string,
  options: PublishOptions,
): FilePublicationIntent {
  const hasArtifact = options.artifact !== undefined;
  const hasExpectedVersion = options.expectedVersion !== undefined;
  if (hasArtifact !== hasExpectedVersion) {
    throw new Error(
      "Publishing a new version requires both --artifact and --expected-version.",
    );
  }

  const common: Omit<FilePublicationIntent, "entryPath" | "target"> =
    options.project === undefined
      ? {inputPath, routingMode: options.routing}
      : {
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

async function executePublication(
  connection: CliServerConnection,
  idempotencyKey: string,
  prepared: PreparedFilePublication,
): Promise<
  | {readonly error: FilePublicationFailure; readonly success: false}
  | {readonly result: FilePublicationResult; readonly success: true}
> {
  return Effect.runPromise(
    publishPreparedPath(
      {
        apiToken: connection.apiToken,
        serverOrigin: connection.origin,
      },
      idempotencyKey,
      prepared,
    ).pipe(
      Effect.match({
        onFailure: (error) => ({error, success: false} as const),
        onSuccess: (result) => ({result, success: true} as const),
      }),
      Effect.provide(authenticatedCliHttpClientLayer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

async function preparePublication(
  intent: FilePublicationIntent,
): Promise<PreparedFilePublication> {
  return Effect.runPromise(
    prepareFilePublication(intent).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function collectTag(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function withEntryPath(
  command: Omit<FilePublicationIntent, "entryPath">,
  entryPath: string | undefined,
): FilePublicationIntent {
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
