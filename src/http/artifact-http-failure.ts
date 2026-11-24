import {
  type ArtifactServerFailure,
  errorCodes,
} from "../core/errors.js";

const folderFailureStatus = {
  "not-found": {code: errorCodes.folderNotFound, status: 404},
  cycle: {code: errorCodes.folderCycle, status: 409},
  limit: {code: errorCodes.folderLimit, status: 409},
  "not-empty": {code: errorCodes.folderNotEmpty, status: 409},
  "name-conflict": {code: errorCodes.nameConflict, status: 409},
  revision: {code: errorCodes.folderRevisionConflict, status: 409},
  "invalid-name": {code: errorCodes.invalidInput, status: 422},
} as const;

const projectMoveStatus = {
  "dispatch-held": errorCodes.dispatchHeld,
  "git-history-enabled": errorCodes.gitHistoryEnabled,
  "too-large": errorCodes.moveTooLarge,
} as const;

const trashFailureStatus = {
  "not-in-trash": {code: errorCodes.notInTrash, status: 409},
  "artifact-in-trash": {code: errorCodes.artifactInTrash, status: 409},
  "dispatch-held": {code: errorCodes.dispatchHeld, status: 409},
  "confirmation-mismatch": {code: errorCodes.purgeConfirmationMismatch, status: 422},
  "too-large": {code: errorCodes.trashTooLarge, status: 409},
} as const;

const folderLinkFailureStatus = {
  "not-found": {code: errorCodes.folderLinkNotFound, status: 404},
  "entry-not-found": {code: errorCodes.inventoryEntryNotFound, status: 404},
  overlap: {code: errorCodes.linkOverlap, status: 409},
  limit: {code: errorCodes.linkLimit, status: 409},
  "batch-too-large": {code: errorCodes.captureBatchTooLarge, status: 422},
  revision: {code: errorCodes.folderLinkRevisionConflict, status: 409},
  "in-trash": {code: errorCodes.folderLinkInTrash, status: 409},
} as const;

/** Stable protocol-safe projection shared by HTTP and MCP adapters. */
export function artifactServerFailureResponse(failure: ArtifactServerFailure) {
  switch (failure._tag) {
    case "FolderFailure": {
      const response = {
        ...folderFailureStatus[failure.reason],
        message: failure.message,
      };
      const withCurrent = failure.current === undefined ? response : {...response, current: failure.current};
      return failure.conflictingFolderId === undefined
        ? withCurrent
        : {...withCurrent, conflictingFolderId: failure.conflictingFolderId};
    }
    case "ProjectMoveRefused":
      return {code: projectMoveStatus[failure.reason], message: failure.message, status: 409};
    case "TrashFailure":
      return {...trashFailureStatus[failure.reason], message: failure.message};
    case "AgentNotFound":
      return {code: errorCodes.agentNotFound, message: failure.message, status: 404};
    case "AgentDispatchNotFound":
      return {code: errorCodes.dispatchNotFound, message: failure.message, status: 404};
    case "InvalidDispatch":
      return {code: errorCodes.invalidDispatch, message: failure.message, status: 422};
    case "DispatchStateConflict":
      return {code: errorCodes.dispatchStateConflict, message: failure.message, status: 409};
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
    case "CommentNotFound":
      return {code: errorCodes.commentNotFound, message: failure.message, status: 404};
    case "CommentResolved":
      return {code: errorCodes.commentResolved, message: failure.message, status: 409};
    case "InvalidComment":
      return {code: errorCodes.invalidComment, message: failure.message, status: 422};
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
    case "PublishConflict": {
      const response = {
        code: errorCodes.publishConflict,
        message: failure.message,
        status: 409 as const,
      };
      return failure.currentVersionId === undefined ? response : {...response, currentVersionId: failure.currentVersionId};
    }
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
    case "InvalidLinkPath":
      return {code: errorCodes.invalidLinkPath, message: failure.message, status: 422};
    case "LinkPathOutsideRoots":
      return {code: errorCodes.linkPathOutsideRoots, message: failure.message, status: 403};
    case "LinkPathProtected":
      return {code: errorCodes.linkPathProtected, message: failure.message, status: 403};
    case "SourceDrifted":
      return {code: errorCodes.sourceDrifted, message: failure.message, status: 409};
    case "SourceMissing":
      return {code: errorCodes.sourceMissing, message: failure.message, status: 409};
    case "SourceUnreadable":
      return {code: errorCodes.sourceUnreadable, message: failure.message, status: 409};
    case "SourceMoved":
      return {code: errorCodes.sourceMoved, message: failure.message, status: 409};
    case "FolderLinkFailure":
      return {...folderLinkFailureStatus[failure.reason], message: failure.message};
    case "CapabilityUnavailable":
      return {
        code: errorCodes.capabilityUnavailable,
        message: failure.message,
        status: 501,
      };
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
