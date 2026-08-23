import {randomBytes, randomUUID} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {Effect, Option, Schema} from "effect";

const systemErrorSchema = Schema.Struct({code: Schema.optional(Schema.String)});

const installationMetadataSchema = Schema.Struct({
  bootstrapAdministratorEmail: Schema.String.check(
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
    Schema.isMaxLength(320),
  ),
  initializedAt: Schema.String,
  installationId: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
  ),
  schemaVersion: Schema.Literal(1),
});
const decodeInstallationMetadata = Schema.decodeUnknownEffect(
  installationMetadataSchema,
);

/** Stable, non-secret identity created for one compact installation. */
export type CompactInstallationMetadata =
  typeof installationMetadataSchema.Type;

/** Filesystem layout owned by one compact installation. */
export interface CompactInstallationLayout {
  /** Generated API credential file. */
  readonly apiTokenPath: string;
  /** Legacy browser bootstrap path retained only for restore compatibility. */
  readonly browserBootstrapTokenPath: string;
  /** Persistent database, blobs, staging, and installation metadata root. */
  readonly dataDirectory: string;
  /** Stable installation metadata file. */
  readonly metadataPath: string;
  /** Marker that prevents serving after an interrupted or failed restore. */
  readonly restoreIncompletePath: string;
  /** Directory containing generated credentials. */
  readonly secretsDirectory: string;
}

/** Result printed exactly once after compact initialization succeeds. */
export interface InitializedCompactInstallation {
  /** Stable installation identity. */
  readonly installationId: string;
}

/** An expected compact-installation filesystem or metadata failure. */
export class CompactInstallationError extends Schema.TaggedError<CompactInstallationError>()(
  "CompactInstallationError",
  {
    message: Schema.String,
    operation: Schema.Literals(["initialize", "read"]),
    path: Schema.String,
    reason: Schema.Literals([
      "already_initialized",
      "invalid_metadata",
      "missing",
      "not_directory",
      "read_failed",
      "write_failed",
    ]),
  },
) {}

/** Return the canonical paths for one caller-selected compact data directory. */
export function compactInstallationLayout(
  dataDirectory: string,
): CompactInstallationLayout {
  const resolved = path.resolve(dataDirectory);
  const secretsDirectory = path.join(resolved, "secrets");
  return {
    apiTokenPath: path.join(secretsDirectory, "api-token"),
    browserBootstrapTokenPath: path.join(
      secretsDirectory,
      "browser-bootstrap-token",
    ),
    dataDirectory: resolved,
    metadataPath: path.join(resolved, "installation.json"),
    restoreIncompletePath: path.join(resolved, ".restore-incomplete"),
    secretsDirectory,
  };
}

/**
 * Atomically create one compact installation and its initial credential.
 *
 * The target must not already contain state. This prevents an operator typo
 * from replacing an installation identity or its only bootstrap credential.
 */
export const initializeCompactInstallation = Effect.fn(
  "initializeCompactInstallation",
)(function*(input: {
  readonly bootstrapAdministratorEmail: string;
  readonly dataDirectory: string;
}): Effect.fn.Return<InitializedCompactInstallation, CompactInstallationError> {
  const layout = compactInstallationLayout(input.dataDirectory);
  const parent = path.dirname(layout.dataDirectory);
  const temporaryDirectory = path.join(
    parent,
    `.artifact-server-init-${randomUUID()}`,
  );
  const temporaryLayout = compactInstallationLayout(temporaryDirectory);
  const initializedAt = new Date().toISOString();
  const installationId = `inst_${randomUUID()}`;
  const apiToken =
    `as_key_key_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const bootstrapAdministratorEmail = yield* Schema.decodeUnknownEffect(
    installationMetadataSchema.fields.bootstrapAdministratorEmail,
  )(input.bootstrapAdministratorEmail).pipe(
    Effect.mapError(() => new CompactInstallationError({
      message: "The bootstrap administrator email is invalid.",
      operation: "initialize",
      path: layout.metadataPath,
      reason: "invalid_metadata",
    })),
  );

  yield* ensureInitializationTargetIsEmpty(layout);
  yield* fileOperation(
    "initialize",
    parent,
    "write_failed",
    () => mkdir(parent, {recursive: true}),
  );
  yield* fileOperation(
    "initialize",
    temporaryDirectory,
    "write_failed",
    async () => {
      await mkdir(temporaryLayout.secretsDirectory, {
        mode: 0o700,
        recursive: true,
      });
      const metadata: CompactInstallationMetadata = {
        bootstrapAdministratorEmail,
        initializedAt,
        installationId,
        schemaVersion: 1,
      };
      await Promise.all([
        writeFile(
          temporaryLayout.metadataPath,
          `${JSON.stringify(metadata, null, 2)}\n`,
          {encoding: "utf8", flag: "wx", mode: 0o600},
        ),
        writeFile(
          temporaryLayout.apiTokenPath,
          `${apiToken}\n`,
          {encoding: "utf8", flag: "wx", mode: 0o600},
        ),
      ]);
      await Promise.all([
        chmod(temporaryDirectory, 0o700),
        chmod(temporaryLayout.secretsDirectory, 0o700),
        chmod(temporaryLayout.metadataPath, 0o600),
        chmod(temporaryLayout.apiTokenPath, 0o600),
      ]);
      await rename(temporaryDirectory, layout.dataDirectory);
    },
  ).pipe(
    Effect.ensuring(Effect.promise(() =>
      rm(temporaryDirectory, {force: true, recursive: true})
    )),
  );

  return {installationId};
});

/** Read and parse the stable identity of an initialized compact installation. */
export const readCompactInstallation = Effect.fn("readCompactInstallation")(
  function*(
    dataDirectory: string,
  ): Effect.fn.Return<
    CompactInstallationMetadata,
    CompactInstallationError
  > {
    const layout = compactInstallationLayout(dataDirectory);
    const directoryStatus = yield* fileOperation(
      "read",
      layout.dataDirectory,
      "missing",
      () => stat(layout.dataDirectory),
    );
    if (!directoryStatus.isDirectory()) {
      return yield* new CompactInstallationError({
        message: "The compact data path is not a directory.",
        operation: "read",
        path: layout.dataDirectory,
        reason: "not_directory",
      });
    }
    const serialized = yield* fileOperation(
      "read",
      layout.metadataPath,
      "missing",
      () => readFile(layout.metadataPath, "utf8"),
    );
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return yield* new CompactInstallationError({
        message: "The compact installation metadata is not valid JSON.",
        operation: "read",
        path: layout.metadataPath,
        reason: "invalid_metadata",
      });
    }
    return yield* decodeInstallationMetadata(value).pipe(
      Effect.mapError(() => new CompactInstallationError({
        message: "The compact installation metadata is invalid or unsupported.",
        operation: "read",
        path: layout.metadataPath,
        reason: "invalid_metadata",
      })),
    );
  },
);

const ensureInitializationTargetIsEmpty = Effect.fn(
  "ensureInitializationTargetIsEmpty",
)(function*(
  layout: CompactInstallationLayout,
): Effect.fn.Return<void, CompactInstallationError> {
  const entries = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readdir(layout.dataDirectory);
      } catch (error) {
        const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
        if (Option.isSome(parsed) && parsed.value.code === "ENOENT") return null;
        throw error;
      }
    },
    catch: () => new CompactInstallationError({
      message: "The initialization target could not be inspected.",
      operation: "initialize",
      path: layout.dataDirectory,
      reason: "read_failed",
    }),
  });
  if (entries !== null) {
    return yield* new CompactInstallationError({
      message: entries.length === 0
        ? "The compact data directory already exists; choose a new path."
        : "The compact data directory already contains files; initialization refused.",
      operation: "initialize",
      path: layout.dataDirectory,
      reason: "already_initialized",
    });
  }
  return undefined;
});

function fileOperation<A>(
  operation: "initialize" | "read",
  targetPath: string,
  reason: "missing" | "read_failed" | "write_failed",
  action: () => Promise<A>,
): Effect.Effect<A, CompactInstallationError> {
  return Effect.tryPromise({
    try: action,
    catch: () => new CompactInstallationError({
      message: operation === "initialize"
        ? "The compact installation could not be created."
        : "The compact installation could not be read.",
      operation,
      path: targetPath,
      reason,
    }),
  });
}
