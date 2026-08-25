import {readFile} from "node:fs/promises";
import path from "node:path";

import {Effect, Layer, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {resolveVerifiedProfileCredential} from "./cli-auth-commands.js";
import {
  parseArtifactServerOrigin,
  readCliProfileState,
  resolveCliProfile,
  type CliProfile,
} from "./cli-profile-store.js";
import {inspectManagedLocalService} from "./local-service-manager.js";
import {runCliEffect} from "./run-cli-effect.js";
import {createSystemCredentialStore} from "./system-credential-store.js";

const canonicalDirectLocalOrigin = "http://localhost:8787";
const bearerCredentialSchema = z.string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9._~-]+$/u);

/** Inputs shared by authenticated Artifact Server CLI commands. */
export interface CliServerConnectionOptions {
  readonly data: string;
  readonly profile?: string;
  readonly profileData: string;
  readonly server?: string;
  readonly tokenFile?: string;
}

/** A bearer credential bound to one normalized Artifact Server origin. */
export interface CliServerConnection {
  readonly apiToken: Redacted.Redacted;
  readonly origin: string;
  readonly profile?: CliProfile;
  readonly source: "explicit" | "local" | "profile";
}

/** Authenticated fetch transport that refuses every redirect. */
export const authenticatedCliHttpClientLayer = Layer.merge(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, {redirect: "error"}),
);

/**
 * Resolve one credential only for the exact destination it is allowed to reach.
 *
 * Linked-file commands default to the local installation because the server
 * must read the selected path. Publication retains its existing default-profile
 * behavior when the caller omits a destination.
 */
export async function resolveCliServerConnection(
  options: CliServerConnectionOptions,
  purpose: "history" | "link" | "publish",
  forceProfileRefresh = false,
): Promise<CliServerConnection> {
  const explicitToken = await loadExplicitApiToken(options);
  const profileDataDirectory = path.resolve(options.profileData);
  if (explicitToken !== undefined) {
    if (options.server === undefined) {
      throw new Error(
        "ARTIFACT_SERVER_API_TOKEN and --token-file require --server or ARTIFACT_SERVER_URL so the credential has one explicit destination.",
      );
    }
    return {
      apiToken: explicitToken,
      origin: await normalizeOrigin(options.server),
      source: "explicit",
    };
  }

  if (options.profile !== undefined) {
    const profile = await runCliEffect(resolveCliProfile(
      profileDataDirectory,
      options.server === undefined
        ? {name: options.profile}
        : {name: options.profile, origin: options.server},
    ));
    return resolveProfileConnection(
      profileDataDirectory,
      profile,
      forceProfileRefresh,
    );
  }

  if (options.server !== undefined) {
    const origin = await normalizeOrigin(options.server);
    const managedOrigin = await readHealthyManagedOrigin(options.data);
    if (managedOrigin !== null && managedOrigin === origin) {
      return localConnection(options.data, origin);
    }
    const profile = await runCliEffect(resolveCliProfile(profileDataDirectory, {
      origin,
    }));
    return resolveProfileConnection(
      profileDataDirectory,
      profile,
      forceProfileRefresh,
    );
  }

  if (purpose === "history" || purpose === "publish") {
    const state = await runCliEffect(readCliProfileState(profileDataDirectory));
    const defaultProfile = state.profiles.find(
      (profile) => profile.id === state.defaultProfileId,
    );
    if (defaultProfile !== undefined) {
      return resolveProfileConnection(
        profileDataDirectory,
        defaultProfile,
        forceProfileRefresh,
      );
    }
  }

  const managedOrigin = await readHealthyManagedOrigin(options.data);
  return localConnection(
    options.data,
    managedOrigin ?? canonicalDirectLocalOrigin,
  );
}

async function resolveProfileConnection(
  dataDirectory: string,
  profile: CliProfile,
  forceRefresh: boolean,
): Promise<CliServerConnection> {
  const resolved = await runCliEffect(resolveVerifiedProfileCredential(
    dataDirectory,
    profile,
    createSystemCredentialStore(),
    forceRefresh,
  ).pipe(Effect.provide(authenticatedCliHttpClientLayer)));
  return {
    apiToken: resolved.bearer,
    origin: profile.origin,
    profile,
    source: "profile",
  };
}

async function localConnection(
  dataDirectory: string,
  origin: string,
): Promise<CliServerConnection> {
  return {
    apiToken: await loadLocalApiToken(dataDirectory),
    origin,
    source: "local",
  };
}

async function loadExplicitApiToken(
  options: CliServerConnectionOptions,
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
  dataDirectory: string,
): Promise<Redacted.Redacted> {
  const resolvedDataDirectory = path.resolve(dataDirectory);
  const tokenPath = path.join(resolvedDataDirectory, "local-api-token");
  let candidate: string;
  try {
    candidate = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    const renderedDataDirectory = JSON.stringify(resolvedDataDirectory);
    throw new Error(
      `Local Artifact Server credentials were not found in ${resolvedDataDirectory}. `
      + `Run artifactserver open --data ${renderedDataDirectory} to start the managed local service, `
      + `or use artifactserver start --data ${renderedDataDirectory} for a foreground service.`,
    );
  }
  const parsed = bearerCredentialSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The local API token in ${tokenPath} is invalid.`);
  }
  return Redacted.make(parsed.data, {label: "artifact-server-api-token"});
}

async function normalizeOrigin(candidate: string): Promise<string> {
  return runCliEffect(parseArtifactServerOrigin(candidate));
}

async function readHealthyManagedOrigin(
  dataDirectory: string,
): Promise<string | null> {
  const inspection = await inspectManagedLocalService(path.resolve(dataDirectory));
  if (
    !inspection.reachable
    || inspection.processAlive !== true
    || inspection.record === null
  ) {
    return null;
  }
  return normalizeOrigin(inspection.record.origin);
}
