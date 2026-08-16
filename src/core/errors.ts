import { Schema } from "effect";

/** Stable error codes exposed by Artifact Server protocols. */
export const errorCodes = {
  artifactNotFound: "ARTIFACT_NOT_FOUND",
  artifactMutationConflict: "ARTIFACT_MUTATION_CONFLICT",
  authorizationDenied: "AUTHORIZATION_DENIED",
  authenticationRequired: "AUTHENTICATION_REQUIRED",
  contentBootstrapRejected: "CONTENT_BOOTSTRAP_REJECTED",
  contentNotPublic: "CONTENT_NOT_PUBLIC",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  identityAdmissionDenied: "IDENTITY_ADMISSION_DENIED",
  identityConflict: "IDENTITY_CONFLICT",
  identityNotFound: "IDENTITY_NOT_FOUND",
  identityProviderFailure: "IDENTITY_PROVIDER_FAILURE",
  interactiveLoginUnavailable: "INTERACTIVE_LOGIN_UNAVAILABLE",
  invalidInput: "INVALID_INPUT",
  invalidManifestPath: "INVALID_MANIFEST_PATH",
  methodNotAllowed: "METHOD_NOT_ALLOWED",
  publishConflict: "PUBLISH_CONFLICT",
  projectArchived: "PROJECT_ARCHIVED",
  projectConflict: "PROJECT_CONFLICT",
  projectNotFound: "PROJECT_NOT_FOUND",
  projectSelectionRequired: "PROJECT_SELECTION_REQUIRED",
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

/** The artifact changed after a management client read its current state. */
export class ArtifactMutationConflict extends Schema.TaggedError<ArtifactMutationConflict>()(
  "ArtifactMutationConflict",
  messageField,
) {}

/** The request did not contain a valid supported credential. */
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  messageField,
) {}

/** A verified external identity is not admitted to this installation. */
export class IdentityAdmissionDenied extends Schema.TaggedError<IdentityAdmissionDenied>()(
  "IdentityAdmissionDenied",
  messageField,
) {}

/** An identity-management command conflicts with current installation state. */
export class IdentityConflict extends Schema.TaggedError<IdentityConflict>()(
  "IdentityConflict",
  messageField,
) {}

/** A requested member, session, or API key does not exist. */
export class IdentityNotFound extends Schema.TaggedError<IdentityNotFound>()(
  "IdentityNotFound",
  messageField,
) {}

/** Interactive browser login is not configured for this installation. */
export class InteractiveLoginUnavailable extends Schema.TaggedError<InteractiveLoginUnavailable>()(
  "InteractiveLoginUnavailable",
  messageField,
) {}

/** A configured external identity provider could not complete its operation. */
export class IdentityProviderFailure extends Schema.TaggedError<IdentityProviderFailure>()(
  "IdentityProviderFailure",
  messageField,
) {}

/** An interactive login attempt is invalid, expired, or already consumed. */
export class LoginAttemptRejected extends Schema.TaggedError<LoginAttemptRejected>()(
  "LoginAttemptRejected",
  messageField,
) {}

/** The authenticated principal is not permitted to perform the operation. */
export class AuthorizationDenied extends Schema.TaggedError<AuthorizationDenied>()(
  "AuthorizationDenied",
  messageField,
) {}

/** A private-content bootstrap cannot be exchanged. */
export class ContentBootstrapRejected extends Schema.TaggedError<ContentBootstrapRejected>()(
  "ContentBootstrapRejected",
  messageField,
) {}

/** A private version request lacks its exact version-scoped browser session. */
export class ContentSessionRequired extends Schema.TaggedError<ContentSessionRequired>()(
  "ContentSessionRequired",
  messageField,
) {}

/** The requested saved version does not exist on the named artifact. */
export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()(
  "VersionNotFound",
  messageField,
) {}

/** An artifact name cannot be parsed into the supported domain value. */
export class InvalidArtifactName extends Schema.TaggedError<InvalidArtifactName>()(
  "InvalidArtifactName",
  messageField,
) {}

/** A project name cannot be parsed into the supported domain value. */
export class InvalidProjectName extends Schema.TaggedError<InvalidProjectName>()(
  "InvalidProjectName",
  messageField,
) {}

/** The requested project does not exist in this installation. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound",
  messageField,
) {}

/** The selected project is archived and cannot accept new work. */
export class ProjectArchived extends Schema.TaggedError<ProjectArchived>()(
  "ProjectArchived",
  messageField,
) {}

/** A project management command conflicts with its current lifecycle state. */
export class ProjectConflict extends Schema.TaggedError<ProjectConflict>()(
  "ProjectConflict",
  messageField,
) {}

/** More than one active project exists and the caller must choose one. */
export class ProjectSelectionRequired extends Schema.TaggedError<ProjectSelectionRequired>()(
  "ProjectSelectionRequired",
  {message: Schema.String, projects: Schema.Array(Schema.Struct({id: Schema.String, name: Schema.String}))},
) {}

/** Artifact tags cannot be normalized into the supported metadata contract. */
export class InvalidArtifactTags extends Schema.TaggedError<InvalidArtifactTags>()(
  "InvalidArtifactTags",
  messageField,
) {}

/** An idempotency key does not meet the publishing contract. */
export class InvalidIdempotencyKey extends Schema.TaggedError<InvalidIdempotencyKey>()(
  "InvalidIdempotencyKey",
  messageField,
) {}

/** A bounded list request contains an invalid page size or cursor. */
export class InvalidPagination extends Schema.TaggedError<InvalidPagination>()(
  "InvalidPagination",
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
      "changeAccessSetting",
      "changeOwnership",
      "changeTags",
      "commitNewArtifact",
      "commitVersion",
      "createContentBootstrap",
      "createStagedUpload",
      "exchangeContentBootstrap",
      "findArtifact",
      "findArtifactForAdministration",
      "findArtifactVersion",
      "findContentSession",
      "findCurrentVersion",
      "findIdempotentPublication",
      "findStagedUpload",
      "findVersionContent",
      "deleteArtifact",
      "listArtifactActions",
      "listArtifacts",
      "listArtifactVersions",
      "listExpiredStagedUploads",
      "markStagedFileUploaded",
      "removeExpiredStagedUpload",
      "restoreVersion",
      "createProject",
      "findProject",
      "listProjects",
      "renameProject",
      "setProjectArchive",
    ]),
  },
) {}

/** An outbound installation-identity operation failed unexpectedly. */
export class IdentityRepositoryFailure extends Schema.TaggedError<IdentityRepositoryFailure>()(
  "IdentityRepositoryFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals([
      "admitMember",
      "bindExternalIdentity",
      "consumeLoginAttempt",
      "createApiKey",
      "createApplicationSession",
      "createLoginAttempt",
      "deactivateMember",
      "findActiveMemberByEmail",
      "findActiveMemberByExternalIdentity",
      "findMember",
      "findApiKey",
      "findApplicationSession",
      "hasMembers",
      "listApiKeys",
      "listMembers",
      "revokeApiKey",
      "revokeApplicationSession",
      "rotateApiKey",
    ]),
  },
) {}

/** An outbound immutable-blob operation failed unexpectedly. */
export class BlobStorageFailure extends Schema.TaggedError<BlobStorageFailure>()(
  "BlobStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["inspect", "open", "put"]),
  },
) {}

/** An outbound staging-storage operation failed unexpectedly. */
export class StagingStorageFailure extends Schema.TaggedError<StagingStorageFailure>()(
  "StagingStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["open", "put", "remove"]),
  },
) {}

const artifactServerFailureSchema = Schema.Union([
  ArtifactNotFound,
  ArtifactMutationConflict,
  AuthenticationRequired,
  IdentityAdmissionDenied,
  IdentityConflict,
  IdentityNotFound,
  IdentityProviderFailure,
  InteractiveLoginUnavailable,
  LoginAttemptRejected,
  AuthorizationDenied,
  ContentBootstrapRejected,
  ContentSessionRequired,
  InvalidArtifactName,
  InvalidProjectName,
  InvalidArtifactTags,
  InvalidIdempotencyKey,
  InvalidPagination,
  EmptyManifest,
  MissingManifestEntry,
  InvalidManifestFile,
  InvalidManifestPath,
  UploadedFileMismatch,
  IdempotencyConflict,
  PublishConflict,
  ProjectArchived,
  ProjectConflict,
  ProjectNotFound,
  ProjectSelectionRequired,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
  ContentNotPublic,
  ArtifactRepositoryFailure,
  IdentityRepositoryFailure,
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
