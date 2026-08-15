import {randomUUID} from "node:crypto";
import {chmod, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";

import {Effect, Schema} from "effect";
import {z} from "zod";

const profileNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const profileNameSchema = z.string().min(1).max(64).regex(profileNamePattern);
const profileSchema = z.object({
  accountId: z.string().min(1).max(200),
  authentication: z.enum(["api_key", "oauth"]),
  createdAt: z.iso.datetime(),
  credentialId: z.string().uuid(),
  id: z.string().uuid(),
  installationId: z.string().min(1).max(200),
  lastVerifiedAt: z.iso.datetime(),
  name: profileNameSchema,
  origin: z.url(),
}).strict();
const profileStateSchema = z.object({
  defaultProfileId: z.string().uuid().nullable(),
  profiles: z.array(profileSchema),
  schemaVersion: z.literal(1),
}).strict();
const systemErrorSchema = z.object({code: z.string().optional()});

/** Expected failure while parsing or changing the CLI profile index. */
export class CliProfileError extends Schema.TaggedError<CliProfileError>()(
  "CliProfileError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "ambiguous_profile",
      "duplicate_name",
      "invalid_origin",
      "invalid_profile",
      "missing_profile",
      "profile_store_unavailable",
    ]),
  },
) {}

/** One non-secret authenticated CLI connection. */
export type CliProfile = z.infer<typeof profileSchema>;

/** Non-secret user-local CLI profile state. */
export type CliProfileState = z.infer<typeof profileStateSchema>;

export interface SaveCliProfileInput {
  readonly accountId: string;
  readonly authentication: CliProfile["authentication"];
  readonly credentialId: string;
  readonly installationId: string;
  readonly name?: string;
  readonly origin: string;
}

/** Deterministic profile selector accepted by all CLI commands. */
export interface CliProfileSelection {
  readonly name?: string;
  readonly origin?: string;
}

/** Normalize one exact Artifact Server origin without silently keeping a path. */
export function parseArtifactServerOrigin(
  candidate: string,
): Effect.Effect<string, CliProfileError> {
  return Effect.try({
    try: () => {
      const url = new URL(candidate);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || url.username.length > 0
        || url.password.length > 0
        || (url.pathname !== "" && url.pathname !== "/")
        || url.search.length > 0
        || url.hash.length > 0
      ) {
        throw new Error("invalid origin");
      }
      url.pathname = "";
      return url.origin;
    },
    catch: () => new CliProfileError({
      message:
        "The Artifact Server address must be an HTTP or HTTPS origin without credentials, a path, a query, or a fragment.",
      reason: "invalid_origin",
    }),
  });
}

/** Read the non-secret profile index, returning an empty index when absent. */
export const readCliProfileState = Effect.fn("CliProfileStore.read")(
  function*(dataDirectory: string) {
    const profilePath = cliProfilePath(dataDirectory);
    const source = yield* Effect.tryPromise({
      try: () => readFile(profilePath, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) => isMissingFile(cause)
        ? Effect.succeed<string | null>(null)
        : Effect.fail(new CliProfileError({
          message: "The Artifact Server CLI profile index could not be read.",
          reason: "profile_store_unavailable",
        }))),
    );
    if (source === null) return emptyProfileState();
    return yield* Effect.try({
      try: () => profileStateSchema.parse(JSON.parse(source)),
      catch: () => new CliProfileError({
        message: "The Artifact Server CLI profile index is invalid.",
        reason: "invalid_profile",
      }),
    });
  },
);

/** Create or replace the exact origin/account profile and make it the default. */
export const saveCliProfile = Effect.fn("CliProfileStore.save")(
  function*(
    dataDirectory: string,
    input: SaveCliProfileInput,
  ): Effect.fn.Return<CliProfile, CliProfileError> {
    const state = yield* readCliProfileState(dataDirectory);
    const origin = yield* parseArtifactServerOrigin(input.origin);
    const now = new Date().toISOString();
    const existing = state.profiles.find((profile) =>
      profile.origin === origin && profile.accountId === input.accountId
    );
    const name = yield* chooseProfileName(state, origin, input.name, existing);
    const profile = profileSchema.parse({
      accountId: input.accountId,
      authentication: input.authentication,
      createdAt: existing?.createdAt ?? now,
      credentialId: input.credentialId,
      id: existing?.id ?? randomUUID(),
      installationId: input.installationId,
      lastVerifiedAt: now,
      name,
      origin,
    });
    yield* writeCliProfileState(dataDirectory, {
      defaultProfileId: profile.id,
      profiles: [
        ...state.profiles.filter((candidate) => candidate.id !== profile.id),
        profile,
      ].toSorted(compareProfiles),
      schemaVersion: 1,
    });
    return profile;
  },
);

/** Mark one profile as successfully verified without changing its credential. */
export const markCliProfileVerified = Effect.fn("CliProfileStore.markVerified")(
  function*(
    dataDirectory: string,
    profileId: string,
  ): Effect.fn.Return<CliProfile, CliProfileError> {
    const state = yield* readCliProfileState(dataDirectory);
    const current = state.profiles.find((profile) => profile.id === profileId);
    if (current === undefined) return yield* missingProfile();
    const profile: CliProfile = {
      ...current,
      lastVerifiedAt: new Date().toISOString(),
    };
    yield* writeCliProfileState(dataDirectory, {
      ...state,
      profiles: state.profiles.map((candidate) =>
        candidate.id === profile.id ? profile : candidate
      ),
    });
    return profile;
  },
);

/** Remove one profile and select another deterministic default when needed. */
export const removeCliProfile = Effect.fn("CliProfileStore.remove")(
  function*(
    dataDirectory: string,
    profileId: string,
  ): Effect.fn.Return<CliProfile, CliProfileError> {
    const state = yield* readCliProfileState(dataDirectory);
    const profile = state.profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) return yield* missingProfile();
    const profiles = state.profiles.filter((candidate) => candidate.id !== profileId);
    yield* writeCliProfileState(dataDirectory, {
      defaultProfileId: state.defaultProfileId === profileId
        ? profiles[0]?.id ?? null
        : state.defaultProfileId,
      profiles,
      schemaVersion: 1,
    });
    return profile;
  },
);

/** Resolve a named, exact-origin, or sole default profile without guessing. */
export const resolveCliProfile = Effect.fn("CliProfileStore.resolve")(
  function*(
    dataDirectory: string,
    selection: CliProfileSelection,
  ): Effect.fn.Return<CliProfile, CliProfileError> {
    const state = yield* readCliProfileState(dataDirectory);
    if (selection.name !== undefined) {
      const profile = state.profiles.find((candidate) =>
        candidate.name === selection.name
      );
      if (profile === undefined) return yield* missingProfile(selection.name);
      if (selection.origin !== undefined) {
        const origin = yield* parseArtifactServerOrigin(selection.origin);
        if (profile.origin !== origin) return yield* missingProfile(origin);
      }
      return profile;
    }
    if (selection.origin !== undefined) {
      const origin = yield* parseArtifactServerOrigin(selection.origin);
      const profiles = state.profiles.filter((candidate) =>
        candidate.origin === origin
      );
      if (profiles.length > 1) {
        return yield* new CliProfileError({
          message:
            `More than one account is saved for ${origin}. Select one with --profile.`,
          reason: "ambiguous_profile",
        });
      }
      const profile = profiles[0];
      return profile ?? (yield* missingProfile(origin));
    }
    const defaultProfile = state.profiles.find((candidate) =>
      candidate.id === state.defaultProfileId
    );
    if (defaultProfile !== undefined) return defaultProfile;
    if (state.profiles.length === 1 && state.profiles[0] !== undefined) {
      return state.profiles[0];
    }
    return yield* new CliProfileError({
      message: state.profiles.length === 0
        ? "No remote Artifact Server profile is saved. Run artifactserver auth login <server>."
        : "More than one Artifact Server profile is saved. Select one with --profile.",
      reason: state.profiles.length === 0
        ? "missing_profile"
        : "ambiguous_profile",
    });
  },
);

/** Build the private path containing non-secret CLI profile metadata. */
export function cliProfilePath(dataDirectory: string): string {
  return path.join(dataDirectory, "cli-profiles.json");
}

function writeCliProfileState(
  dataDirectory: string,
  state: CliProfileState,
): Effect.Effect<void, CliProfileError> {
  const profilePath = cliProfilePath(dataDirectory);
  const temporaryPath = `${profilePath}.${process.pid}.${randomUUID()}.tmp`;
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dataDirectory, {recursive: true, mode: 0o700});
      await chmod(dataDirectory, 0o700);
      await writeFile(
        temporaryPath,
        `${JSON.stringify(profileStateSchema.parse(state), null, 2)}\n`,
        {encoding: "utf8", flag: "wx", mode: 0o600},
      );
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, profilePath);
      await chmod(profilePath, 0o600);
    },
    catch: () => new CliProfileError({
      message: "The Artifact Server CLI profile index could not be updated.",
      reason: "profile_store_unavailable",
    }),
  });
}

function chooseProfileName(
  state: CliProfileState,
  origin: string,
  requested: string | undefined,
  existing: CliProfile | undefined,
): Effect.Effect<string, CliProfileError> {
  const candidate = requested ?? existing?.name ?? defaultProfileName(origin);
  const parsed = profileNameSchema.safeParse(candidate);
  if (!parsed.success) {
    return Effect.fail(new CliProfileError({
      message:
        "A profile name must use 1 to 64 lowercase letters, numbers, or interior hyphens.",
      reason: "invalid_profile",
    }));
  }
  const conflict = state.profiles.some((profile) =>
    profile.name === parsed.data && profile.id !== existing?.id
  );
  return conflict
    ? Effect.fail(new CliProfileError({
      message: `The profile name ${parsed.data} is already in use.`,
      reason: "duplicate_name",
    }))
    : Effect.succeed(parsed.data);
}

function defaultProfileName(origin: string): string {
  const hostname = new URL(origin).hostname.toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 64);
  return profileNamePattern.test(hostname) ? hostname : "server";
}

function emptyProfileState(): CliProfileState {
  return {defaultProfileId: null, profiles: [], schemaVersion: 1};
}

function isMissingFile(cause: unknown): boolean {
  const parsed = systemErrorSchema.safeParse(cause);
  return parsed.success && parsed.data.code === "ENOENT";
}

function missingProfile(selection?: string): Effect.Effect<never, CliProfileError> {
  return Effect.fail(new CliProfileError({
    message: selection === undefined
      ? "The Artifact Server profile does not exist."
      : `No Artifact Server profile matches ${selection}.`,
    reason: "missing_profile",
  }));
}

function compareProfiles(left: CliProfile, right: CliProfile): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
