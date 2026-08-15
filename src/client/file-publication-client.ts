import {createHash} from "node:crypto";
import {
  constants as fileSystemConstants,
  lstat,
  open,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import {Effect, Option, Schema, type Redacted} from "effect";
import type * as FileSystem from "effect/FileSystem";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  EmptyManifest,
  InvalidManifestFile,
  InvalidManifestPath,
  MissingManifestEntry,
} from "../core/errors.js";
import {
  createManifest,
  parseManifestPath,
} from "../manifest/create-manifest.js";

const maximumFileCount = 10_000;
const maximumManifestPathLength = 1_024;
const defaultDirectoryEntryPath = "index.html";
const uploadConcurrency = 4;

const mediaTypesByExtension = new Map<string, string>([
  [".aac", "audio/aac"],
  [".avif", "image/avif"],
  [".avi", "video/x-msvideo"],
  [".bin", "application/octet-stream"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const nonnegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const artifactSchema = Schema.Struct({
  accessSetting: Schema.Literals(["account_required", "public_link"]),
  createdAt: Schema.String,
  currentVersionId: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  name: Schema.String,
  ownerPrincipalId: Schema.String,
  projectId: Schema.String,
  tags: Schema.Array(Schema.String),
});
const versionSchema = Schema.Struct({
  artifactId: Schema.String,
  contentToken: Schema.String,
  createdAt: Schema.String,
  entryPath: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
  number: positiveIntegerSchema,
  publisherPrincipalId: Schema.String,
  projectId: Schema.String,
  routingMode: Schema.Literal("static"),
});
const publishResponseSchema = Schema.Struct({
  artifact: artifactSchema,
  links: Schema.Struct({
    artifact: Schema.URLFromString,
    version: Schema.URLFromString,
  }),
  replayed: Schema.Boolean,
  version: versionSchema,
});
const createUploadResponseSchema = Schema.Struct({
  commitUrl: Schema.URLFromString,
  expiresAt: Schema.String,
  files: Schema.Array(Schema.Struct({
    method: Schema.Literal("PUT"),
    path: Schema.String,
    size: nonnegativeIntegerSchema,
    uploadUrl: Schema.URLFromString,
  })),
  manifestDigest: Schema.String,
  projectId: Schema.String,
  uploadId: Schema.String,
});
const serverErrorSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});
const uploadedFileResponseSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal("verified"),
  uploadId: Schema.String,
});

const decodeServerError = Schema.decodeUnknownOption(serverErrorSchema);

/** A filesystem input cannot be turned into a safe artifact publication. */
export class FilePublicationInputError extends Schema.TaggedError<FilePublicationInputError>()(
  "FilePublicationInputError",
  {
    inputPath: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "empty_directory",
      "input_changed",
      "invalid_entry",
      "invalid_path",
      "read_failed",
      "symbolic_link",
      "too_many_files",
      "unsupported_file_type",
    ]),
  },
) {}

/** The configured server or one of its upload-plan URLs is unsafe. */
export class FilePublicationConfigurationError extends Schema.TaggedError<FilePublicationConfigurationError>()(
  "FilePublicationConfigurationError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid_server", "unsafe_upload_plan"]),
  },
) {}

/** The server could not complete or validate one file publication operation. */
export class FilePublicationProtocolError extends Schema.TaggedError<FilePublicationProtocolError>()(
  "FilePublicationProtocolError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "commit_upload",
      "create_upload",
      "upload_file",
    ]),
    serverCode: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.Int),
  },
) {}

/** Expected failures from the file-first publication client. */
export type FilePublicationFailure =
  | FilePublicationInputError
  | FilePublicationConfigurationError
  | FilePublicationProtocolError;

/** Result returned after a staged upload commits an immutable version. */
export type FilePublicationResult = typeof publishResponseSchema.Type;

/** Target selected by a file-first publication caller. */
export type FilePublicationTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name?: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

/** One user-facing file or directory publication request. */
export interface FilePublicationCommand {
  readonly entryPath?: string;
  readonly idempotencyKey: string;
  readonly inputPath: string;
  readonly projectId?: string;
  readonly target: FilePublicationTarget;
}

/** Connection values for one Artifact Server installation. */
export interface FilePublicationClientConfig {
  readonly apiToken: Redacted.Redacted;
  readonly serverOrigin: string;
}

interface PreparedFile {
  readonly absolutePath: string;
  readonly device: number;
  readonly inode: number;
  readonly mediaType: string;
  readonly modifiedAtMilliseconds: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface PreparedPublication {
  readonly defaultName: string;
  readonly entryPath: string;
  readonly files: readonly PreparedFile[];
}

interface CreateUploadRequestBody {
  readonly entryPath: string;
  readonly files: readonly {
    readonly mediaType: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly projectId?: string;
}

type CommitPublicationTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

interface CommitUploadRequestBody {
  readonly target: CommitPublicationTarget;
}

type FilePublicationRequestBody =
  | CreateUploadRequestBody
  | CommitUploadRequestBody;

type FilePublicationOperation = FilePublicationProtocolError["operation"];

/**
 * Publish one local file or finished directory through a server-issued upload
 * plan. The server receives bytes and portable manifest paths, never the local
 * filesystem path.
 */
export const publishPath = Effect.fn("FilePublicationClient.publishPath")(
  function*(
    config: FilePublicationClientConfig,
    command: FilePublicationCommand,
  ): Effect.fn.Return<
    FilePublicationResult,
    FilePublicationFailure,
    FileSystem.FileSystem | HttpClient.HttpClient
  > {
    const serverOrigin = yield* parseServerOrigin(config.serverOrigin);
    const prepared = yield* preparePublication(command);
    const upload = yield* createUpload(
      serverOrigin,
      config.apiToken,
      prepared,
      command.projectId,
    );
    yield* validateUploadPlan(serverOrigin, prepared, upload);
    yield* Effect.forEach(
      upload.files,
      (plannedFile) => uploadPreparedFile(
        config.apiToken,
        plannedFile,
        requiredPreparedFile(prepared.files, plannedFile.path),
        upload.uploadId,
      ),
      {concurrency: uploadConcurrency, discard: true},
    );
    const target: CommitPublicationTarget = command.target.kind === "new_artifact"
      ? {
        accessSetting: command.target.accessSetting,
        kind: command.target.kind,
        name: command.target.name ?? prepared.defaultName,
        tags: command.target.tags,
      }
      : command.target;
    return yield* commitUpload(
      config.apiToken,
      command.idempotencyKey,
      target,
      upload.commitUrl,
    );
  },
);

/** Infer a deterministic browser media type from one file name. */
export function mediaTypeForPath(filePath: string): string {
  return mediaTypesByExtension.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

const preparePublication = Effect.fn("FilePublicationClient.preparePublication")(
  function*(
    command: FilePublicationCommand,
  ): Effect.fn.Return<PreparedPublication, FilePublicationInputError> {
    const absoluteInputPath = path.resolve(command.inputPath);
    const prepared = yield* Effect.tryPromise({
      try: () => inspectPublicationPath(absoluteInputPath, command.entryPath),
      catch: (cause) => inputFailureFrom(cause, absoluteInputPath),
    });
    return prepared;
  },
);

async function inspectPublicationPath(
  absoluteInputPath: string,
  requestedEntryPath: string | undefined,
): Promise<PreparedPublication> {
  const rootInfo = await lstat(absoluteInputPath);
  if (rootInfo.isSymbolicLink()) {
    throw inputFailure(
      absoluteInputPath,
      "symbolic_link",
      "The publication input cannot be a symbolic link.",
    );
  }
  if (rootInfo.isFile()) {
    const relativePath = path.basename(absoluteInputPath);
    if (
      requestedEntryPath !== undefined
      && requestedEntryPath !== relativePath
    ) {
      throw inputFailure(
        absoluteInputPath,
        "invalid_entry",
        `A single-file artifact opens ${JSON.stringify(relativePath)}; --entry is only needed for a directory.`,
      );
    }
    const file = await inspectRegularFile(absoluteInputPath, relativePath);
    return canonicalPreparedPublication(
      path.basename(absoluteInputPath),
      relativePath,
      [file],
      absoluteInputPath,
    );
  }
  if (!rootInfo.isDirectory()) {
    throw inputFailure(
      absoluteInputPath,
      "unsupported_file_type",
      "The publication input must be one regular file or directory.",
    );
  }

  const files: PreparedFile[] = [];
  await inspectDirectory(absoluteInputPath, "", files);
  if (files.length === 0) {
    throw inputFailure(
      absoluteInputPath,
      "empty_directory",
      "The publication directory does not contain any files.",
    );
  }
  return canonicalPreparedPublication(
    path.basename(absoluteInputPath),
    requestedEntryPath ?? defaultDirectoryEntryPath,
    files,
    absoluteInputPath,
  );
}

async function inspectDirectory(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  files: PreparedFile[],
): Promise<void> {
  const names = (await readdir(absoluteDirectoryPath)).toSorted();
  await names.reduce<Promise<void>>(
    (previous, name) => previous.then(() => inspectDirectoryEntry(
      absoluteDirectoryPath,
      relativeDirectoryPath,
      name,
      files,
    )),
    Promise.resolve(),
  );
}

async function inspectDirectoryEntry(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  name: string,
  files: PreparedFile[],
): Promise<void> {
  const absoluteChildPath = path.join(absoluteDirectoryPath, name);
  const relativeChildPath = relativeDirectoryPath.length === 0
    ? name
    : path.posix.join(relativeDirectoryPath, name);
  assertPortableClientPath(relativeChildPath, absoluteChildPath);
  const info = await lstat(absoluteChildPath);
  if (info.isSymbolicLink()) {
    throw inputFailure(
      absoluteChildPath,
      "symbolic_link",
      "Publication directories cannot contain symbolic links.",
    );
  }
  if (info.isDirectory()) {
    await inspectDirectory(absoluteChildPath, relativeChildPath, files);
    return undefined;
  }
  if (!info.isFile()) {
    throw inputFailure(
      absoluteChildPath,
      "unsupported_file_type",
      "Publication directories can contain only regular files and directories.",
    );
  }
  if (files.length >= maximumFileCount) {
    throw inputFailure(
      absoluteChildPath,
      "too_many_files",
      `A publication can contain at most ${maximumFileCount} files.`,
    );
  }
  files.push(await inspectRegularFile(absoluteChildPath, relativeChildPath));
}

async function inspectRegularFile(
  absolutePath: string,
  relativePath: string,
): Promise<PreparedFile> {
  assertPortableClientPath(relativePath, absolutePath);
  const fileHandle = await open(
    absolutePath,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
  );
  try {
    const info = await fileHandle.stat();
    if (!info.isFile()) {
      throw inputFailure(
        absolutePath,
        "unsupported_file_type",
        "The publication input must contain only regular files.",
      );
    }
    if (!Number.isSafeInteger(info.size)) {
      throw inputFailure(
        absolutePath,
        "unsupported_file_type",
        "The selected file is too large to represent safely.",
      );
    }
    const fingerprint = createHash("sha256");
    const stream = fileHandle.createReadStream({autoClose: false});
    for await (const chunk of stream) fingerprint.update(chunk);
    return {
      absolutePath,
      device: info.dev,
      inode: info.ino,
      mediaType: mediaTypeForPath(relativePath),
      modifiedAtMilliseconds: info.mtimeMs,
      path: relativePath,
      sha256: fingerprint.digest("hex"),
      size: info.size,
    };
  } finally {
    await fileHandle.close();
  }
}

function canonicalPreparedPublication(
  defaultName: string,
  entryPath: string,
  files: readonly PreparedFile[],
  inputPath: string,
): PreparedPublication {
  try {
    const manifest = createManifest({
      entryPath,
      files,
      routingMode: "static",
    });
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    return {
      defaultName,
      entryPath: manifest.entryPath,
      files: manifest.entries.map((entry) => {
        const file = filesByPath.get(entry.path);
        if (file === undefined) {
          throw new Error("A canonical manifest entry lost its prepared file.");
        }
        return file;
      }),
    };
  } catch (cause) {
    if (cause instanceof EmptyManifest) {
      throw inputFailure(inputPath, "empty_directory", cause.message);
    }
    if (cause instanceof MissingManifestEntry) {
      throw inputFailure(inputPath, "invalid_entry", cause.message);
    }
    if (cause instanceof InvalidManifestPath) {
      throw inputFailure(inputPath, "invalid_path", cause.message);
    }
    if (cause instanceof InvalidManifestFile) {
      throw inputFailure(inputPath, "unsupported_file_type", cause.message);
    }
    throw cause;
  }
}

function assertPortableClientPath(
  relativePath: string,
  absolutePath: string,
): void {
  if (relativePath.length > maximumManifestPathLength) {
    throw inputFailure(
      absolutePath,
      "invalid_path",
      `Artifact paths cannot exceed ${maximumManifestPathLength} characters.`,
    );
  }
  try {
    parseManifestPath(relativePath);
  } catch (cause) {
    if (cause instanceof InvalidManifestPath) {
      throw inputFailure(absolutePath, "invalid_path", cause.message);
    }
    throw cause;
  }
}

const parseServerOrigin = Effect.fn("FilePublicationClient.parseServerOrigin")(
  function*(
    candidate: string,
  ): Effect.fn.Return<URL, FilePublicationConfigurationError> {
    return yield* Effect.try({
      try: () => {
        const url = new URL(candidate);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:")
          || url.username.length > 0
          || url.password.length > 0
          || (url.pathname !== "/" && url.pathname !== "")
          || url.search.length > 0
          || url.hash.length > 0
        ) {
          throw new Error("invalid server origin");
        }
        url.pathname = "/";
        return url;
      },
      catch: () => new FilePublicationConfigurationError({
        message: "The Artifact Server URL must be an HTTP or HTTPS origin without credentials, a path, a query, or a fragment.",
        reason: "invalid_server",
      }),
    });
  },
);

const createUpload = Effect.fn("FilePublicationClient.createUpload")(
  function*(
    serverOrigin: URL,
    apiToken: Redacted.Redacted,
    prepared: PreparedPublication,
    projectId: string | undefined,
  ): Effect.fn.Return<
    typeof createUploadResponseSchema.Type,
    FilePublicationProtocolError,
    HttpClient.HttpClient
  > {
    const files = prepared.files.map((file) => ({
      mediaType: file.mediaType,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    }));
    const body: CreateUploadRequestBody = projectId === undefined ? {
      entryPath: prepared.entryPath,
      files,
    } : {
      entryPath: prepared.entryPath,
      files,
      projectId,
    };
    const request = yield* jsonRequest(
      HttpClientRequest.post(new URL("/api/v1/uploads", serverOrigin)),
      apiToken,
      body,
      "create_upload",
    );
    return yield* executeJson(
      request,
      createUploadResponseSchema,
      "create_upload",
    );
  },
);

const validateUploadPlan = Effect.fn("FilePublicationClient.validateUploadPlan")(
  function*(
    serverOrigin: URL,
    prepared: PreparedPublication,
    upload: typeof createUploadResponseSchema.Type,
  ): Effect.fn.Return<void, FilePublicationConfigurationError> {
    if (
      upload.commitUrl.origin !== serverOrigin.origin
      || upload.files.some((file) => file.uploadUrl.origin !== serverOrigin.origin)
    ) {
      return yield* new FilePublicationConfigurationError({
        message: "The server returned an upload URL on another origin. Artifact Server credentials were not sent.",
        reason: "unsafe_upload_plan",
      });
    }
    if (upload.files.length !== prepared.files.length) {
      return yield* unsafeUploadPlan(
        "The server returned an incomplete file-upload plan.",
      );
    }
    const preparedByPath = new Map(prepared.files.map((file) => [file.path, file]));
    const plannedPaths = new Set<string>();
    for (const planned of upload.files) {
      const preparedFile = preparedByPath.get(planned.path);
      if (
        preparedFile === undefined
        || preparedFile.size !== planned.size
        || plannedPaths.has(planned.path)
      ) {
        return yield* unsafeUploadPlan(
          "The server returned a file-upload plan that does not match the selected files.",
        );
      }
      plannedPaths.add(planned.path);
    }
    return undefined;
  },
);

const uploadPreparedFile = Effect.fn("FilePublicationClient.uploadPreparedFile")(
  function*(
    apiToken: Redacted.Redacted,
    plannedFile: typeof createUploadResponseSchema.Type["files"][number],
    preparedFile: PreparedFile,
    uploadId: string,
  ): Effect.fn.Return<
    void,
    FilePublicationInputError | FilePublicationProtocolError,
    FileSystem.FileSystem | HttpClient.HttpClient
  > {
    yield* assertPreparedFileStable(preparedFile);
    const body = yield* HttpBody.file(preparedFile.absolutePath, {
      contentType: preparedFile.mediaType,
    }).pipe(
      Effect.mapError(() => inputFailure(
        preparedFile.absolutePath,
        "read_failed",
        "The selected file could not be opened for upload.",
      )),
    );
    const request = HttpClientRequest.put(plannedFile.uploadUrl).pipe(
      HttpClientRequest.bearerToken(apiToken),
      HttpClientRequest.setBody(body),
    );
    const uploaded = yield* executeJson(
      request,
      uploadedFileResponseSchema,
      "upload_file",
    );
    if (uploaded.path !== plannedFile.path || uploaded.uploadId !== uploadId) {
      return yield* protocolFailure(
        "upload_file",
        "Artifact Server verified a different upload file than the client sent.",
        200,
      );
    }
    return undefined;
  },
);

const assertPreparedFileStable = Effect.fn("FilePublicationClient.assertPreparedFileStable")(
  function*(
    preparedFile: PreparedFile,
  ): Effect.fn.Return<void, FilePublicationInputError> {
    const current = yield* Effect.tryPromise({
      try: () => lstat(preparedFile.absolutePath),
      catch: () => inputFailure(
        preparedFile.absolutePath,
        "read_failed",
        "The selected file could not be inspected before upload.",
      ),
    });
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== preparedFile.device
      || current.ino !== preparedFile.inode
      || current.size !== preparedFile.size
      || current.mtimeMs !== preparedFile.modifiedAtMilliseconds
    ) {
      return yield* inputFailure(
        preparedFile.absolutePath,
        "input_changed",
        "The selected file changed after publication preparation. Run publish again.",
      );
    }
    return undefined;
  },
);

const commitUpload = Effect.fn("FilePublicationClient.commitUpload")(
  function*(
    apiToken: Redacted.Redacted,
    idempotencyKey: string,
    target: CommitPublicationTarget,
    commitUrl: URL,
  ): Effect.fn.Return<
    FilePublicationResult,
    FilePublicationProtocolError,
    HttpClient.HttpClient
  > {
    const request = yield* jsonRequest(
      HttpClientRequest.post(commitUrl).pipe(
        HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
      ),
      apiToken,
      {target},
      "commit_upload",
    );
    return yield* executeJson(request, publishResponseSchema, "commit_upload");
  },
);

const jsonRequest = Effect.fn("FilePublicationClient.jsonRequest")(
  function*(
    request: HttpClientRequest.HttpClientRequest,
    apiToken: Redacted.Redacted,
    body: FilePublicationRequestBody,
    operation: FilePublicationOperation,
  ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, FilePublicationProtocolError> {
    return yield* HttpClientRequest.bodyJson(
      HttpClientRequest.bearerToken(request, apiToken),
      body,
    ).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "The publication request could not be encoded.",
      )),
    );
  },
);

const executeJson = Effect.fn("FilePublicationClient.executeJson")(
  function*<A>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.ConstraintDecoder<A>,
    operation: FilePublicationOperation,
  ): Effect.fn.Return<A, FilePublicationProtocolError, HttpClient.HttpClient> {
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "Artifact Server could not be reached.",
      )),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* failureFromResponse(response, operation);
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => protocolFailure(
        operation,
        "Artifact Server returned an invalid success response.",
        response.status,
      )),
    );
  },
);

const failureFromResponse = Effect.fn("FilePublicationClient.failureFromResponse")(
  function*(
    response: HttpClientResponse.HttpClientResponse,
    operation: FilePublicationOperation,
  ): Effect.fn.Return<never, FilePublicationProtocolError> {
    const decoded = yield* response.json.pipe(
      Effect.map(decodeServerError),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    return yield* Option.match(decoded, {
      onNone: () => protocolFailure(
        operation,
        `Artifact Server rejected the publication request with HTTP ${response.status}.`,
        response.status,
      ),
      onSome: (body) => new FilePublicationProtocolError({
        message: body.error.message,
        operation,
        serverCode: body.error.code,
        status: response.status,
      }),
    });
  },
);

function requiredPreparedFile(
  files: readonly PreparedFile[],
  filePath: string,
): PreparedFile {
  const file = files.find((candidate) => candidate.path === filePath);
  if (file === undefined) {
    throw new Error("A validated upload plan lost its prepared file.");
  }
  return file;
}

function inputFailureFrom(cause: unknown, inputPath: string): FilePublicationInputError {
  if (cause instanceof FilePublicationInputError) return cause;
  return inputFailure(
    inputPath,
    "read_failed",
    "The publication input could not be read.",
  );
}

function inputFailure(
  inputPath: string,
  reason: FilePublicationInputError["reason"],
  message: string,
): FilePublicationInputError {
  return new FilePublicationInputError({inputPath, message, reason});
}

function protocolFailure(
  operation: FilePublicationOperation,
  message: string,
  status: number | null = null,
): FilePublicationProtocolError {
  return new FilePublicationProtocolError({
    message,
    operation,
    serverCode: null,
    status,
  });
}

function unsafeUploadPlan(message: string): FilePublicationConfigurationError {
  return new FilePublicationConfigurationError({
    message,
    reason: "unsafe_upload_plan",
  });
}
