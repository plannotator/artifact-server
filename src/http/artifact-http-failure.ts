import {
  type ArtifactServerFailure,
  errorCodes,
} from "../core/errors.js";

/** Stable protocol-safe projection shared by HTTP and MCP adapters. */
export function artifactServerFailureResponse(failure: ArtifactServerFailure) {
  switch (failure._tag) {
    case "ArtifactNotFound":
      return {code: errorCodes.artifactNotFound, message: failure.message, status: 404};
    case "ArtifactMutationConflict":
      return {code: errorCodes.artifactMutationConflict, message: failure.message, status: 409};
    case "AuthenticationRequired":
      return {code: errorCodes.authenticationRequired, message: failure.message, status: 401};
    case "IdentityAdmissionDenied":
      return {code: errorCodes.identityAdmissionDenied, message: failure.message, status: 403};
    case "IdentityConflict":
      return {code: errorCodes.identityConflict, message: failure.message, status: 409};
    case "IdentityNotFound":
      return {code: errorCodes.identityNotFound, message: failure.message, status: 404};
    case "IdentityProviderFailure":
      return {code: errorCodes.identityProviderFailure, message: failure.message, status: 502};
    case "InteractiveLoginUnavailable":
      return {code: errorCodes.interactiveLoginUnavailable, message: failure.message, status: 404};
    case "LoginAttemptRejected":
      return {code: errorCodes.authenticationRequired, message: failure.message, status: 401};
    case "AuthorizationDenied":
      return {code: errorCodes.authorizationDenied, message: failure.message, status: 403};
    case "ContentBootstrapRejected":
      return {code: errorCodes.contentBootstrapRejected, message: failure.message, status: 401};
    case "ContentSessionRequired":
    case "ContentNotPublic":
      return {code: errorCodes.contentNotPublic, message: failure.message, status: 401};
    case "InvalidArtifactName":
    case "InvalidProjectName":
    case "InvalidArtifactTags":
    case "InvalidIdempotencyKey":
    case "InvalidPagination":
    case "EmptyManifest":
    case "MissingManifestEntry":
    case "InvalidManifestFile":
    case "UploadedFileMismatch":
      return {code: errorCodes.invalidInput, message: failure.message, status: 422};
    case "InvalidManifestPath":
      return {code: errorCodes.invalidManifestPath, message: failure.message, status: 422};
    case "IdempotencyConflict":
      return {code: errorCodes.idempotencyConflict, message: failure.message, status: 409};
    case "PublishConflict":
      return {code: errorCodes.publishConflict, message: failure.message, status: 409};
    case "ProjectArchived":
      return {code: errorCodes.projectArchived, message: failure.message, status: 409};
    case "ProjectConflict":
      return {code: errorCodes.projectConflict, message: failure.message, status: 409};
    case "ProjectNotFound":
      return {code: errorCodes.projectNotFound, message: failure.message, status: 404};
    case "ProjectSelectionRequired":
      return {
        code: errorCodes.projectSelectionRequired,
        message: failure.message,
        status: 409,
      };
    case "UploadClosed":
      return {code: errorCodes.uploadClosed, message: failure.message, status: 409};
    case "UploadExpired":
      return {code: errorCodes.uploadExpired, message: failure.message, status: 410};
    case "UploadFileNotFound":
      return {code: errorCodes.uploadFileNotFound, message: failure.message, status: 404};
    case "UploadIncomplete":
      return {code: errorCodes.uploadIncomplete, message: failure.message, status: 409};
    case "UploadNotFound":
      return {code: errorCodes.uploadNotFound, message: failure.message, status: 404};
    case "VersionNotFound":
      return {code: errorCodes.versionNotFound, message: failure.message, status: 404};
    case "ArtifactRepositoryFailure":
    case "IdentityRepositoryFailure":
    case "BlobStorageFailure":
    case "StagingStorageFailure":
      return {
        code: "INTERNAL_ERROR" as const,
        message: "The server could not complete the request.",
        status: 500,
      };
  }
  return casesHandled(failure);
}

function casesHandled(value: never): never {
  throw new Error(`Unhandled Artifact Server failure: ${String(value)}`);
}
