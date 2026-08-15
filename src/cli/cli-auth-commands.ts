import {randomUUID} from "node:crypto";
import path from "node:path";

import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {type Command, Option} from "commander";
import {Effect} from "effect";

import {
  apiKeyCredential,
  bearerFromStoredCredential,
  CliAuthenticationError,
  decodeStoredCliCredential,
  encodeStoredCliCredential,
  oauthAccessTokenIsFresh,
  verifyCliCredential,
} from "./cli-profile-credential.js";
import {
  loginWithBrowserOAuth,
  refreshCliOAuthCredential,
  revokeCliOAuthCredential,
} from "./cli-oauth-client.js";
import {
  markCliProfileVerified,
  parseArtifactServerOrigin,
  readCliProfileState,
  removeCliProfile,
  resolveCliProfile,
  saveCliProfile,
  type CliProfile,
  type CliProfileSelection,
} from "./cli-profile-store.js";
import {
  createSystemCredentialStore,
  type CliCredentialStoreOperations,
} from "./system-credential-store.js";
import {runCliEffect} from "./run-cli-effect.js";

const maximumStdinCredentialBytes = 4_096;

interface LoginOptions {
  readonly apiKeyStdin: boolean;
  readonly name?: string;
  readonly profileData: string;
}

interface ProfileSelectionOptions {
  readonly profileData: string;
  readonly server?: string;
}

/** User-local directory used by CLI profiles and no remote server state. */
export interface CliAuthCommandOptions {
  readonly defaultProfileDirectory: string;
}

/** Register secure CLI login, status, and logout commands. */
export function configureCliAuthCommands(
  program: Command,
  options: CliAuthCommandOptions,
): void {
  const authCommand = program.command("auth")
    .description("Manage authenticated Artifact Server CLI profiles.");
  authCommand
    .command("login")
    .description("Sign the CLI in to one exact Artifact Server origin.")
    .argument("<server>", "Artifact Server origin")
    .addOption(new Option("--name <profile>", "saved profile name"))
    .addOption(
      new Option(
        "--api-key-stdin",
        "read an administrator-issued API key from standard input",
      ).default(false),
    )
    .addOption(profileDataOption(options.defaultProfileDirectory))
    .action(async (server: string, commandOptions: LoginOptions) => {
      const store = createSystemCredentialStore();
      const profile = await runCliAuthEffect(loginProfile(
        path.resolve(commandOptions.profileData),
        server,
        commandOptions,
        store,
      ));
      console.log(JSON.stringify(profileOutput(profile, "authenticated"), null, 2));
    });

  authCommand
    .command("status [profile]")
    .description("Verify saved CLI profiles without printing credentials.")
    .addOption(new Option("--server <origin>", "exact Artifact Server origin"))
    .addOption(profileDataOption(options.defaultProfileDirectory))
    .action(async (
      profileName: string | undefined,
      commandOptions: ProfileSelectionOptions,
    ) => {
      const dataDirectory = path.resolve(commandOptions.profileData);
      const store = createSystemCredentialStore();
      const profiles = profileName === undefined && commandOptions.server === undefined
        ? (await runCliEffect(readCliProfileState(dataDirectory))).profiles
        : [await runCliEffect(resolveCliProfile(
          dataDirectory,
          profileSelection(profileName, commandOptions.server),
        ))];
      const statuses = await Promise.all(profiles.map((profile) =>
        runCliAuthEffect(inspectProfile(dataDirectory, profile, store))
          .catch(() => profileOutput(profile, "invalid"))
      ));
      console.log(JSON.stringify({profiles: statuses}, null, 2));
      if (statuses.some((status) => status.status === "invalid")) {
        process.exitCode = 2;
      }
    });

  authCommand
    .command("logout [profile]")
    .description("Remove one saved CLI credential and profile.")
    .addOption(new Option("--server <origin>", "exact Artifact Server origin"))
    .addOption(profileDataOption(options.defaultProfileDirectory))
    .action(async (
      profileName: string | undefined,
      commandOptions: ProfileSelectionOptions,
    ) => {
      const dataDirectory = path.resolve(commandOptions.profileData);
      const store = createSystemCredentialStore();
      const profile = await runCliEffect(resolveCliProfile(
        dataDirectory,
        profileSelection(profileName, commandOptions.server),
      ));
      const result = await runCliAuthEffect(logoutProfile(
        dataDirectory,
        profile,
        store,
      ));
      console.log(JSON.stringify(result, null, 2));
    });
}

/** Load, renew when needed, and verify one saved profile credential. */
export const resolveVerifiedProfileCredential = Effect.fn(
  "CliAuth.resolveVerifiedProfileCredential",
)(function*(
  dataDirectory: string,
  profile: CliProfile,
  store: CliCredentialStoreOperations,
  forceRefresh = false,
) {
  const encoded = yield* store.read(profile.credentialId);
  let credential = yield* decodeStoredCliCredential(encoded);
  if (
    credential.kind === "oauth"
    && (forceRefresh || !oauthAccessTokenIsFresh(credential))
  ) {
    credential = yield* refreshCliOAuthCredential(
      profile.origin,
      credential,
      process.env,
      forceRefresh,
    );
    yield* store.write(
      profile.credentialId,
      encodeStoredCliCredential(credential),
    );
  }
  let bearer = bearerFromStoredCredential(credential);
  const account = yield* verifyCliCredential(profile.origin, bearer).pipe(
    Effect.catchTag("CliAuthenticationError", (error) => {
      if (
        error.reason !== "credential_revoked"
        || credential.kind !== "oauth"
        || forceRefresh
      ) return Effect.fail(error);
      const currentOAuthCredential = credential;
      return Effect.gen(function*() {
        credential = yield* refreshCliOAuthCredential(
          profile.origin,
          currentOAuthCredential,
          process.env,
          true,
        );
        yield* store.write(
          profile.credentialId,
          encodeStoredCliCredential(credential),
        );
        bearer = bearerFromStoredCredential(credential);
        return yield* verifyCliCredential(profile.origin, bearer);
      });
    }),
  );
  if (
    account.principal.id !== profile.accountId
    || account.principal.installationId !== profile.installationId
  ) {
    return yield* new CliAuthenticationError({
      message:
        "The saved credential belongs to a different Artifact Server account or installation.",
      reason: "credential_invalid",
    });
  }
  yield* markCliProfileVerified(dataDirectory, profile.id);
  return {bearer, credential, profile};
});

const loginProfile = Effect.fn("CliAuth.login")(
  function*(
    dataDirectory: string,
    server: string,
    options: LoginOptions,
    store: CliCredentialStoreOperations,
  ) {
    const origin = yield* parseArtifactServerOrigin(server);
    const credential = options.apiKeyStdin
      ? apiKeyCredential(yield* readApiKeyFromStandardInput())
      : (yield* loginWithBrowserOAuth(origin)).credential;
    const account = yield* verifyCliCredential(
      origin,
      bearerFromStoredCredential(credential),
    );
    const currentState = yield* readCliProfileState(dataDirectory);
    const previous = currentState.profiles.find((profile) =>
      profile.origin === origin && profile.accountId === account.principal.id
    );
    const credentialId = randomUUID();
    yield* store.write(credentialId, encodeStoredCliCredential(credential));
    const profileInput = {
      accountId: account.principal.id,
      authentication: credential.kind,
      credentialId,
      installationId: account.principal.installationId,
      origin,
    };
    const profile = yield* (options.name === undefined
      ? saveCliProfile(dataDirectory, profileInput)
      : saveCliProfile(dataDirectory, {...profileInput, name: options.name})).pipe(
      Effect.tapError(() => store.delete(credentialId).pipe(Effect.ignore)),
    );
    if (
      previous !== undefined
      && previous.credentialId !== credentialId
    ) {
      yield* store.delete(previous.credentialId).pipe(Effect.ignore);
    }
    return profile;
  },
);

const inspectProfile = Effect.fn("CliAuth.status")(
  function*(
    dataDirectory: string,
    profile: CliProfile,
    store: CliCredentialStoreOperations,
  ) {
    yield* resolveVerifiedProfileCredential(dataDirectory, profile, store);
    return profileOutput(profile, "authenticated");
  },
);

const logoutProfile = Effect.fn("CliAuth.logout")(
  function*(
    dataDirectory: string,
    profile: CliProfile,
    store: CliCredentialStoreOperations,
  ) {
    const stored = yield* store.read(profile.credentialId).pipe(
      Effect.flatMap(decodeStoredCliCredential),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing"
          ? Effect.succeed(null)
          : Effect.fail(error)),
    );
    let remoteRevocation:
      | "confirmed"
      | "not_applicable"
      | "not_confirmed" = "not_applicable";
    if (stored?.kind === "oauth") {
      remoteRevocation = (yield* revokeCliOAuthCredential(
        profile.origin,
        stored,
      ))
        ? "confirmed"
        : "not_confirmed";
    }
    yield* store.delete(profile.credentialId);
    yield* removeCliProfile(dataDirectory, profile.id);
    return {
      ...profileOutput(profile, "logged_out"),
      remoteRevocation,
    };
  },
);

function readApiKeyFromStandardInput(): Effect.Effect<
  string,
  CliAuthenticationError
> {
  return Effect.tryPromise({
    try: async () => {
      if (process.stdin.isTTY) {
        throw new Error(
          "Pipe the administrator-issued key to --api-key-stdin so it does not enter shell history.",
        );
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maximumStdinCredentialBytes) {
          throw new Error("The API key on standard input exceeds the safe limit.");
        }
        chunks.push(buffer);
      }
      const credential = Buffer.concat(chunks).toString("utf8").trim();
      if (credential.length < 32) {
        throw new Error("Standard input did not contain a valid Artifact Server API key.");
      }
      return credential;
    },
    catch: (cause) => new CliAuthenticationError({
      message: cause instanceof Error
        ? cause.message
        : "The Artifact Server API key could not be read from standard input.",
      reason: "credential_invalid",
    }),
  });
}

function profileOutput(
  profile: CliProfile,
  status: "authenticated" | "invalid" | "logged_out",
) {
  return {
    accountId: profile.accountId,
    authentication: profile.authentication,
    installationId: profile.installationId,
    name: profile.name,
    origin: profile.origin,
    status,
  };
}

function profileDataOption(defaultDirectory: string): Option {
  return new Option(
    "--profile-data <directory>",
    "user-local CLI profile directory",
  ).default(defaultDirectory).env("ARTIFACT_SERVER_HOME");
}

function profileSelection(
  name: string | undefined,
  origin: string | undefined,
): CliProfileSelection {
  if (name !== undefined && origin !== undefined) return {name, origin};
  if (name !== undefined) return {name};
  if (origin !== undefined) return {origin};
  return {};
}

function runCliAuthEffect<A, E extends {_tag: string; message: string}>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> {
  return runCliEffect(effect.pipe(Effect.provide(FetchHttpClient.layer)));
}
