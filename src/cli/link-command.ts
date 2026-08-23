import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import {Option, type Command} from "commander";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {resolveVerifiedProfileCredential} from "./cli-auth-commands.js";
import {resolveCliProfile} from "./cli-profile-store.js";
import {runCliEffect} from "./run-cli-effect.js";
import {createSystemCredentialStore} from "./system-credential-store.js";

interface LinkOptions {
  readonly data: string;
  readonly name?: string;
  readonly profile?: string;
  readonly profileData: string;
  readonly project?: string;
  readonly server?: string;
  readonly tokenFile?: string;
}

/** User-local configuration shared by auth, publish, and link commands. */
export interface LinkCommandOptions {
  readonly defaultProfileDirectory: string;
}

interface LinkConnection {
  readonly apiToken: Redacted.Redacted;
  readonly origin: string;
}

const bearerCredentialSchema = z.string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const linkedPublicationSchema = z.object({
  artifact: z.object({
    id: z.string().min(1),
    name: z.string(),
    projectId: z.string().min(1),
  }).loose(),
  links: z.object({artifact: z.string().min(1), version: z.string().min(1)})
    .loose(),
  replayed: z.boolean(),
  sourceBinding: z.object({
    lastVerifiedAt: z.string(),
    path: z.string(),
    status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
  }).loose(),
  version: z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
  }).loose(),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

const capabilityUnavailableExplanation =
  "This server does not link files. Linking works only on a local Artifact Server started with ARTIFACT_SERVER_LINKED_FILES=on and reached on its loopback address.";

/** Add the linked-file command to the Artifact Server CLI. */
export function configureLinkCommand(
  program: Command,
  commandOptions: LinkCommandOptions,
): void {
  program
    .command("link")
    .description(
      "Link one file on this machine as an artifact that tracks the file.",
    )
    .argument("<path>", "file on this machine to link")
    .addOption(new Option("--project <id>", "project ID; optional when one active project exists"))
    .addOption(new Option("--name <name>", "name for the linked artifact"))
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
    .action(async (inputPath: string, options: LinkOptions) => {
      // The server reads the file itself, so the path it receives must be
      // absolute on this machine; linking is a same-machine operation.
      const absolutePath = path.resolve(inputPath);
      const connection = await resolveLinkConnection(options);
      const response = await fetch(
        new URL("/api/v1/artifacts/link", connection.origin),
        {
          body: JSON.stringify(linkRequestBody(absolutePath, options)),
          headers: {
            Authorization: `Bearer ${Redacted.value(connection.apiToken)}`,
            "Content-Type": "application/json",
            "Idempotency-Key": randomBytes(24).toString("base64url"),
          },
          method: "POST",
        },
      );
      if (response.status !== 201) throw await linkFailure(response);
      console.log(JSON.stringify(
        linkedPublicationSchema.parse(await response.json()),
        null,
        2,
      ));
    });
}

function linkRequestBody(absolutePath: string, options: LinkOptions) {
  const base = options.name === undefined
    ? {path: absolutePath}
    : {name: options.name, path: absolutePath};
  return options.project === undefined
    ? base
    : {...base, projectId: options.project};
}

async function linkFailure(response: Response): Promise<Error> {
  const failure = await readFailure(response);
  if (failure === null) {
    return new Error(`The link request failed (HTTP ${response.status}).`);
  }
  if (failure.error.code === "CAPABILITY_UNAVAILABLE") {
    return new Error(capabilityUnavailableExplanation);
  }
  return new Error(
    `${failure.error.code} (HTTP ${response.status}): ${failure.error.message}`,
  );
}

async function readFailure(
  response: Response,
): Promise<z.infer<typeof failureSchema> | null> {
  try {
    return failureSchema.parse(await response.json());
  } catch {
    return null;
  }
}

async function resolveLinkConnection(
  options: LinkOptions,
): Promise<LinkConnection> {
  const explicitToken = await loadExplicitApiToken(options);
  if (explicitToken !== undefined) {
    if (options.server === undefined) {
      throw new Error(
        "ARTIFACT_SERVER_API_TOKEN and --token-file require --server or ARTIFACT_SERVER_URL so the credential has one explicit destination.",
      );
    }
    return {apiToken: explicitToken, origin: options.server};
  }

  if (options.profile !== undefined) {
    const dataDirectory = path.resolve(options.profileData);
    const profile = await runCliEffect(resolveCliProfile(
      dataDirectory,
      options.server === undefined
        ? {name: options.profile}
        : {name: options.profile, origin: options.server},
    ));
    const resolved = await runCliEffect(resolveVerifiedProfileCredential(
      dataDirectory,
      profile,
      createSystemCredentialStore(),
      false,
    ).pipe(Effect.provide(FetchHttpClient.layer)));
    return {apiToken: resolved.bearer, origin: profile.origin};
  }

  return {
    apiToken: await loadLocalApiToken(options),
    origin: options.server ?? "http://localhost:8787",
  };
}

async function loadExplicitApiToken(
  options: LinkOptions,
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
    throw new Error(`Artifact Server API token not found at ${tokenPath}.`);
  }
  const parsed = bearerCredentialSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The API token in ${tokenPath} is invalid.`);
  }
  return Redacted.make(parsed.data, {label: "artifact-server-api-token"});
}

async function loadLocalApiToken(
  options: LinkOptions,
): Promise<Redacted.Redacted> {
  const tokenPath = path.resolve(path.join(options.data, "local-api-token"));
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
