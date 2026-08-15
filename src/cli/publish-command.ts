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
  publishPath,
} from "../client/file-publication-client.js";

interface PublishOptions {
  readonly artifact?: string;
  readonly data: string;
  readonly entry?: string;
  readonly expectedVersion?: string;
  readonly name?: string;
  readonly public: boolean;
  readonly project?: string;
  readonly server: string;
  readonly tag: readonly string[];
  readonly tokenFile?: string;
}

const bearerCredentialSchema = z.string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/u);

/** Add the file-first publication command to the Artifact Server CLI. */
export function configurePublishCommand(program: Command): void {
  program
    .command("publish")
    .description("Publish one file or finished directory.")
    .argument("<path>", "file or finished directory to publish")
    .addOption(
      new Option("--server <origin>", "Artifact Server origin")
        .default("http://localhost:8787")
        .env("ARTIFACT_SERVER_URL"),
    )
    .addOption(
      new Option("--data <directory>", "local Artifact Server data directory")
        .default(".artifact-server"),
    )
    .addOption(
      new Option("--token-file <path>", "file containing an Artifact Server API token"),
    )
    .addOption(new Option("--entry <path>", "directory file that opens first"))
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
      const apiToken = await loadApiToken(options);
      const command = publicationCommand(inputPath, options);
      const outcome = await Effect.runPromise(
        publishPath(
          {
            apiToken: Redacted.make(apiToken, {label: "artifact-server-api-token"}),
            serverOrigin: options.server,
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
      ? {idempotencyKey, inputPath}
      : {idempotencyKey, inputPath, projectId: options.project};
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

async function loadApiToken(options: PublishOptions): Promise<string> {
  const environmentToken = process.env["ARTIFACT_SERVER_API_TOKEN"];
  if (options.tokenFile === undefined && environmentToken !== undefined) {
    const parsed = bearerCredentialSchema.safeParse(environmentToken);
    if (!parsed.success) {
      throw new Error("ARTIFACT_SERVER_API_TOKEN is invalid.");
    }
    return parsed.data;
  }
  if (options.tokenFile === undefined && !isLoopbackServer(options.server)) {
    throw new Error(
      "A remote Artifact Server requires ARTIFACT_SERVER_API_TOKEN or --token-file. The local API token is never sent to a remote server automatically.",
    );
  }

  const tokenPath = path.resolve(
    options.tokenFile ?? path.join(options.data, "local-api-token"),
  );
  let candidate: string;
  try {
    candidate = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    throw new Error(
      `Artifact Server API token not found at ${tokenPath}. Start the local server, set ARTIFACT_SERVER_API_TOKEN, or use --token-file.`,
    );
  }
  const parsed = bearerCredentialSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The API token in ${tokenPath} is invalid.`);
  }
  return parsed.data;
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
