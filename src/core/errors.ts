import { Schema } from "effect";

/** Stable error codes exposed by Artifact Server protocols. */
export const errorCodes = {
  artifactNotFound: "ARTIFACT_NOT_FOUND",
  authenticationRequired: "AUTHENTICATION_REQUIRED",
  contentNotPublic: "CONTENT_NOT_PUBLIC",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  invalidInput: "INVALID_INPUT",
  invalidManifestPath: "INVALID_MANIFEST_PATH",
  methodNotAllowed: "METHOD_NOT_ALLOWED",
  publishConflict: "PUBLISH_CONFLICT",
  uploadClosed: "UPLOAD_CLOSED",
  uploadExpired: "UPLOAD_EXPIRED",
  uploadFileNotFound: "UPLOAD_FILE_NOT_FOUND",
  uploadIncomplete: "UPLOAD_INCOMPLETE",
  uploadNotFound: "UPLOAD_NOT_FOUND",
  versionNotFound: "VERSION_NOT_FOUND",
} as const;

/** One stable error code exposed by an Artifact Server protocol. */
export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

const messageField = {message: Schema.String};

/** The requested artifact does not exist in the installation. */
export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()(
  "ArtifactNotFound",
  messageField,
) {}

/** An artifact name cannot be parsed into the supported domain value. */
export class InvalidArtifactName extends Schema.TaggedError<InvalidArtifactName>()(
  "InvalidArtifactName",
  messageField,
) {}

/** An idempotency key does not meet the publishing contract. */
export class InvalidIdempotencyKey extends Schema.TaggedError<InvalidIdempotencyKey>()(
  "InvalidIdempotencyKey",
  messageField,
) {}

/** A manifest contains no files. */
export class EmptyManifest extends Schema.TaggedError<EmptyManifest>()(
  "EmptyManifest",
  messageField,
) {}

/** A manifest's entry path does not name one of its files. */
export class MissingManifestEntry extends Schema.TaggedError<MissingManifestEntry>()(
  "MissingManifestEntry",
  messageField,
) {}

/** A manifest file declaration cannot be parsed safely. */
export class InvalidManifestFile extends Schema.TaggedError<InvalidManifestFile>()(
  "InvalidManifestFile",
  messageField,
) {}

/** A manifest path is unsafe or not portable. */
export class InvalidManifestPath extends Schema.TaggedError<InvalidManifestPath>()(
  "InvalidManifestPath",
  messageField,
) {}

/** A client supplied more bytes than the inline publication path permits. */
export class InlineContentTooLarge extends Schema.TaggedError<InlineContentTooLarge>()(
  "InlineContentTooLarge",
  messageField,
) {}

/** Uploaded bytes do not match their declared length or fingerprint. */
export class UploadedFileMismatch extends Schema.TaggedError<UploadedFileMismatch>()(
  "UploadedFileMismatch",
  messageField,
) {}

/** An idempotency key was already bound to different publication input. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  messageField,
) {}

/** The artifact's current version changed before the publication committed. */
export class PublishConflict extends Schema.TaggedError<PublishConflict>()(
  "PublishConflict",
  messageField,
) {}

/** The requested staged upload has already committed. */
export class UploadClosed extends Schema.TaggedError<UploadClosed>()(
  "UploadClosed",
  messageField,
) {}

/** The requested staged upload is no longer open for publication. */
export class UploadExpired extends Schema.TaggedError<UploadExpired>()(
  "UploadExpired",
  messageField,
) {}

/** The requested file slot does not exist in the staged upload. */
export class UploadFileNotFound extends Schema.TaggedError<UploadFileNotFound>()(
  "UploadFileNotFound",
  messageField,
) {}

/** A staged upload does not yet contain every verified file. */
export class UploadIncomplete extends Schema.TaggedError<UploadIncomplete>()(
  "UploadIncomplete",
  messageField,
) {}

/** The requested staged upload does not exist for the principal. */
export class UploadNotFound extends Schema.TaggedError<UploadNotFound>()(
  "UploadNotFound",
  messageField,
) {}

/** The requested artifact cannot be opened without an authorized session. */
export class ContentNotPublic extends Schema.TaggedError<ContentNotPublic>()(
  "ContentNotPublic",
  messageField,
) {}

/** An outbound repository operation failed unexpectedly. */
export class ArtifactRepositoryFailure extends Schema.TaggedError<ArtifactRepositoryFailure>()(
  "ArtifactRepositoryFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals([
      "assertPublicationSourceReady",
      "commitNewArtifact",
      "commitVersion",
      "createStagedUpload",
      "findIdempotentPublication",
      "findStagedUpload",
      "markStagedFileUploaded",
    ]),
  },
) {}

/** An outbound immutable-blob operation failed unexpectedly. */
export class BlobStorageFailure extends Schema.TaggedError<BlobStorageFailure>()(
  "BlobStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literal("put"),
  },
) {}

/** An outbound staging-storage operation failed unexpectedly. */
export class StagingStorageFailure extends Schema.TaggedError<StagingStorageFailure>()(
  "StagingStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["open", "put"]),
  },
) {}

const artifactServerFailureSchema = Schema.Union([
  ArtifactNotFound,
  InvalidArtifactName,
  InvalidIdempotencyKey,
  EmptyManifest,
  MissingManifestEntry,
  InvalidManifestFile,
  InvalidManifestPath,
  InlineContentTooLarge,
  UploadedFileMismatch,
  IdempotencyConflict,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  ContentNotPublic,
  ArtifactRepositoryFailure,
  BlobStorageFailure,
  StagingStorageFailure,
]);

/** Every expected product or outbound-adapter failure handled by an entry point. */
export type ArtifactServerFailure = typeof artifactServerFailureSchema.Type;

const failureGuard = Schema.is(artifactServerFailureSchema);

/** Determine whether an unknown boundary failure is an Artifact Server failure value. */
export function isArtifactServerFailure(
  input: Error,
): input is ArtifactServerFailure {
  return failureGuard(input);
}
