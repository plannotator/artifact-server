import {createHash, randomUUID, timingSafeEqual} from "node:crypto";

import { DateTime, Effect, Layer, Redacted } from "effect";

import {
  AuthenticationService,
  type BearerCredentialVerifier,
  type ExternalMcpBearerVerifier,
} from "../application/authentication.js";
import {
  digestIdentitySecret,
  InstallationAccessService,
} from "../application/installation-access.js";
import {
  type InteractiveIdentityProvider,
  InteractiveLoginService,
} from "../application/interactive-login.js";
import {
  type AgentDispatchDependencies,
  type AgentDispatchRepositoryFailure,
  AgentDispatchService,
} from "../application/agent-dispatch.js";
import {
  type ArtifactCommentDependencies,
  ArtifactCommentService,
  type CommentRepositoryFailure,
} from "../application/artifact-comments.js";
import {
  type ArtifactManagementDependencies,
  ArtifactManagementService,
} from "../application/artifact-management.js";
import { AuthorizationService } from "../application/authorization.js";
import {
  type CompareArtifactDependencies,
  CompareArtifactService,
} from "../application/compare-artifact.js";
import {
  type ContentAccessDependencies,
  ContentAccessService,
} from "../application/content-access.js";
import {ExpiredStagingCleanupService} from
  "../application/expired-staging-cleanup.js";

import {
  disabledLinkedArtifactLayer,
  type LinkedArtifactConfiguration,
  type LinkedSourceEngineOperations,
  LinkedArtifactService,
} from "../application/linked-artifacts.js";
import {
  type PublishArtifactDependencies,
  PublishArtifactService,
} from "../application/publish-artifact.js";
import {
  type StagedUploadDependencies,
  StagedUploadService,
} from "../application/staged-upload.js";
import {
  type ProjectManagementDependencies,
  ProjectManagementService,
} from "../application/project-management.js";
import {
  type ProjectGitHistoryDependencies,
  type ProjectGitHistoryStore,
  ProjectGitHistoryService,
} from "../application/project-git-history.js";
import {
  type ListPublicLinks,
  type PublicLinkAdministrationRepository,
  PublicLinkAdministrationService,
  type PublicLinkInventoryPage,
} from "../application/public-link-administration.js";
import {
  AgentDispatchNotFound,
  AgentNotFound,
  ArtifactNotFound,
  ArtifactMutationConflict,
  ArtifactRepositoryFailure,
  AuthenticationRequired,
  BlobStorageFailure,
  CommentNotFound,
  CommentResolved,
  DispatchStateConflict,
  IdempotencyConflict,
  IdentityConflict,
  IdentityNotFound,
  IdentityRepositoryFailure,
  InvalidComment,
  InvalidDispatch,
  PublishConflict,
  ProjectConflict,
  ProjectArchived,
  ProjectNotFound,
  LoginAttemptRejected,
  StagingStorageFailure,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  UploadedFileMismatch,
  VersionNotFound,
} from "../core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";
import type {
  AgentDispatchRepository,
  ArtifactRepository,
  BlobStore,
  Clock,
  CommentRepository,
  ContentSessionRepository,
  IdGenerator,
  ProjectRepository,
  SourceBindingRepository,
  StagedUploadRepository,
  StagingStore,
} from "../core/ports.js";
import type {IdentityRepository} from "../core/identity-ports.js";
import type { ManifestEntry } from "../core/model.js";
import {randomBase64Url} from "../core/random.js";
import { FileVerificationError } from "../storage/verified-file.js";
import {defaultStagingCleanupPolicy} from
  "../lifecycle/staging-cleanup.js";
import {
  disabledGitHistoryCapability,
  fixedGitHistoryCapabilityReader,
  type GitHistoryCapabilityReader,
} from "../git-history/git-history-capability.js";

/** Concrete Node adapters reused by the Effect application layer. */
export interface ApplicationAdapters {
  readonly apiToken: Redacted.Redacted | null;
  readonly blobs: BlobStore;
  readonly bootstrapAdministratorEmail: string;
  readonly clock: Clock;
  readonly externalApiBearerVerifier: BearerCredentialVerifier | null;
  readonly externalMcpBearerVerifier: BearerCredentialVerifier | null;
  readonly externalMcpOAuthVerifier: ExternalMcpBearerVerifier | null;
  /**
   * Agent-dispatch persistence. Every backend implements the dispatch tables,
   * so omitting the slot is a compile error rather than a runtime failure.
   */
  readonly dispatches: AgentDispatchRepository;
  readonly ids: IdGenerator;
  readonly identityRepository: IdentityRepository;
  readonly installationId: string;
  readonly interactiveIdentityProvider: InteractiveIdentityProvider | null;
  /** Live optional-provider state used to guard project enablement. */
  readonly gitHistory?: GitHistoryCapabilityReader;
  /**
   * Linked-artifact adapters, present only on a local deployment that has
   * enabled the capability. Absent, every runtime still provides the
   * linked-artifact service through its disabled layer, which answers the
   * stable capability-unavailable shape.
   */
  readonly linked?: LinkedApplicationAdapters;
  readonly localBootstrapCredential: Redacted.Redacted | null;
  readonly protectBootstrapAdministrator: boolean;
  readonly repository: ArtifactRepository &
    CommentRepository &
    ContentSessionRepository &
    ProjectRepository &
    ProjectGitHistoryStore &
    PublicLinkInventoryStore &
    StagedUploadRepository;
  readonly staging: StagingStore;
  readonly stagingCleanupPolicy?: {
    readonly concurrency: number;
    readonly settleDelayMilliseconds: number;
  };
}

/** Node-only linked-artifact adapters supplied by the local deployment. */
export interface LinkedApplicationAdapters {
  readonly bindings: SourceBindingRepository;
  readonly configuration: LinkedArtifactConfiguration;
  readonly engine: LinkedSourceEngineOperations;
}

interface PublicLinkInventoryStore {
  readonly listPublicLinks: (
    command: ListPublicLinks,
  ) => Promise<PublicLinkInventoryPage>;
}

/** Build Node application services over the selected persistence adapters. */
export function createApplicationLayer(
  adapters: ApplicationAdapters,
): Layer.Layer<
  | AgentDispatchService
  | AuthenticationService
  | ArtifactCommentService
  | ArtifactManagementService
  | AuthorizationService
  | CompareArtifactService
  | ContentAccessService
  | ExpiredStagingCleanupService
  | InstallationAccessService
  | InteractiveLoginService
  | LinkedArtifactService
  | PublishArtifactService
  | ProjectGitHistoryService
  | ProjectManagementService
  | PublicLinkAdministrationService
  | StagedUploadService
> {
  const clock = {
    now: Effect.sync(() => DateTime.makeUnsafe(adapters.clock.now())),
  };
  const publishDependencies: PublishArtifactDependencies = {
    blobs: {
      put: (write) =>
        Effect.tryPromise({
          try: (fiberSignal) => adapters.blobs.put({
            ...write,
            signal: combineAbortSignals(fiberSignal, write.signal),
          }),
          catch: (cause) =>
            new BlobStorageFailure({cause, operation: "put"}),
        }),
    },
    clock,
    ids: adapters.ids,
    repository: {
      assertPublicationSourceReady: (source, manifestDigest, commitTime) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.assertPublicationSourceReady(
              source,
              manifestDigest,
              commitTime,
            ),
          catch: classifySourceReadinessFailure,
        }),
      commitNewArtifact: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.commitNewArtifact(command),
          catch: classifyCommitNewFailure,
        }),
      commitVersion: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.commitVersion(command),
          catch: classifyCommitVersionFailure,
        }),
      findIdempotentPublication: (projectId, idempotencyKey, inputDigest) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findIdempotentPublication(
              projectId,
              idempotencyKey,
              inputDigest,
            ),
          catch: (cause) =>
            cause instanceof IdempotencyConflict
              ? cause
              : repositoryFailure("findIdempotentPublication", cause),
        }),
      findCurrentVersion: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.findCurrentVersion(projectId, artifactId),
          catch: (cause) => repositoryFailure("findCurrentVersion", cause),
        }),
    },
  };
  const stagedDependencies: StagedUploadDependencies = {
    clock,
    ids: adapters.ids,
    staging: {
      open: (uploadId, storageToken) =>
        Effect.tryPromise({
          try: () => adapters.staging.open(uploadId, storageToken),
          catch: (cause) =>
            new StagingStorageFailure({cause, operation: "open"}),
        }),
      put: (write) =>
        Effect.tryPromise({
          try: (fiberSignal) => adapters.staging.put({
            ...write,
            signal: combineAbortSignals(fiberSignal, write.signal),
          }),
          catch: (cause) =>
            cause instanceof FileVerificationError
              ? new UploadedFileMismatch({
                message:
                  "The uploaded bytes do not match the declared size and SHA-256 fingerprint.",
              })
              : new StagingStorageFailure({cause, operation: "put"}),
        }),
      remove: (uploadId, storageToken) =>
        Effect.tryPromise({
          try: () => adapters.staging.remove(uploadId, storageToken),
          catch: (cause) =>
            new StagingStorageFailure({cause, operation: "remove"}),
        }),
    },
    uploads: {
      createStagedUpload: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.createStagedUpload(command),
          catch: (cause) => cause instanceof ProjectArchived
            ? cause
            : repositoryFailure("createStagedUpload", cause),
        }),
      findStagedUpload: (projectId, uploadId, principalId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findStagedUpload(
              projectId,
              uploadId,
              principalId,
            ),
          catch: (cause) => repositoryFailure("findStagedUpload", cause),
        }),
      listExpiredStagedUploads: (expiredBefore, limit) =>
        Effect.tryPromise({
          try: () => adapters.repository.listExpiredStagedUploads(
            expiredBefore,
            limit,
          ),
          catch: (cause) => repositoryFailure(
            "listExpiredStagedUploads",
            cause,
          ),
        }),
      markStagedFileUploaded: (
        projectId,
        uploadId,
        principalId,
        storageToken,
        uploadedAt,
      ) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.markStagedFileUploaded(
              projectId,
              uploadId,
              principalId,
              storageToken,
              uploadedAt,
            ),
          catch: (cause) => {
            if (
              cause instanceof UploadNotFound ||
              cause instanceof UploadClosed ||
              cause instanceof UploadFileNotFound ||
              cause instanceof UploadExpired ||
              cause instanceof ProjectArchived
            ) {
              return cause;
            }
            return repositoryFailure("markStagedFileUploaded", cause);
          },
        }),
      removeExpiredStagedUpload: (uploadId, expiredBefore) =>
        Effect.tryPromise({
          try: () => adapters.repository.removeExpiredStagedUpload(
            uploadId,
            expiredBefore,
          ),
          catch: (cause) => repositoryFailure(
            "removeExpiredStagedUpload",
            cause,
          ),
        }),
    },
  };
  const projectDependencies: ProjectManagementDependencies = {
    clock,
    ids: adapters.ids,
    installationId: adapters.installationId,
    repository: {
      createProject: (command) => Effect.tryPromise({
        try: () => adapters.repository.createProject(command),
        catch: (cause) => cause instanceof ProjectConflict
          ? cause
          : repositoryFailure("createProject", cause),
      }),
      findProject: (projectId) => Effect.tryPromise({
        try: () => adapters.repository.findProject(projectId),
        catch: (cause) => repositoryFailure("findProject", cause),
      }),
      listProjects: () => Effect.tryPromise({
        try: () => adapters.repository.listProjects(),
        catch: (cause) => repositoryFailure("listProjects", cause),
      }),
      renameProject: (command) => Effect.tryPromise({
        try: () => adapters.repository.renameProject(command),
        catch: (cause) => cause instanceof ProjectNotFound
          ? cause
          : repositoryFailure("renameProject", cause),
      }),
      setProjectArchive: (command) => Effect.tryPromise({
        try: () => adapters.repository.setProjectArchive(command),
        catch: (cause) =>
          cause instanceof ProjectNotFound || cause instanceof ProjectConflict
            ? cause
            : repositoryFailure("setProjectArchive", cause),
      }),
    },
  };
  const projectGitHistoryDependencies: ProjectGitHistoryDependencies = {
    clock,
    provider: adapters.gitHistory ?? fixedGitHistoryCapabilityReader(
      disabledGitHistoryCapability(),
    ),
    repository: {
      estimateProjectGitHistory: (projectId, limits) => Effect.tryPromise({
        try: () => adapters.repository.estimateProjectGitHistory(projectId, limits),
        catch: (cause) => repositoryFailure("estimateProjectGitHistory", cause),
      }),
      readProjectGitHistorySetting: (projectId) => Effect.tryPromise({
        try: () => adapters.repository.readProjectGitHistorySetting(projectId),
        catch: (cause) => repositoryFailure("readProjectGitHistorySetting", cause),
      }),
      storeProjectGitHistorySetting: (setting) => Effect.tryPromise({
        try: () => adapters.repository.storeProjectGitHistorySetting(setting),
        catch: (cause) => repositoryFailure("storeProjectGitHistorySetting", cause),
      }),
    },
  };
  const managementDependencies: ArtifactManagementDependencies = {
    clock,
    repository: {
      changeAccessSetting: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.changeAccessSetting(command),
          catch: classifyChangeAccessFailure,
        }),
      changeTags: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.changeTags(command),
          catch: classifyChangeTagsFailure,
        }),
      deleteArtifact: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.deleteArtifact(command),
          catch: classifyDeleteFailure,
        }),
      findArtifact: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.findArtifact(projectId, artifactId),
          catch: (cause) => repositoryFailure("findArtifact", cause),
        }),
      findArtifactForAdministration: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findArtifactForAdministration(
              projectId,
              artifactId,
            ),
          catch: (cause) =>
            repositoryFailure("findArtifactForAdministration", cause),
        }),
      findVersionRecord: (projectId, artifactId, versionId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findVersionRecord(
              projectId,
              artifactId,
              versionId,
            ),
          catch: (cause) => repositoryFailure("findVersionRecord", cause),
        }),
      listArtifactVersions: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.listArtifactVersions(projectId, artifactId),
          catch: (cause) => repositoryFailure("listArtifactVersions", cause),
        }),
      listArtifactActions: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.listArtifactActions(command),
          catch: (cause) => repositoryFailure("listArtifactActions", cause),
        }),
      listArtifacts: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.listArtifacts(command),
          catch: (cause) => repositoryFailure("listArtifacts", cause),
        }),
      restoreVersion: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.restoreVersion(command),
          catch: classifyRestoreFailure,
        }),
    },
  };
  const commentDependencies: ArtifactCommentDependencies = {
    clock,
    ids: adapters.ids,
    installationId: adapters.installationId,
    repository: {
      createReply: (command) => commentEffect(
        "createCommentReply",
        () => adapters.repository.createReply(command),
      ),
      createThread: (command) => commentEffect(
        "createCommentThread",
        () => adapters.repository.createThread(command),
      ),
      deleteReply: (command) => commentEffect(
        "deleteCommentReply",
        () => adapters.repository.deleteReply(command),
      ),
      deleteThread: (command) => commentEffect(
        "deleteCommentThread",
        () => adapters.repository.deleteThread(command),
      ),
      findArtifact: (projectId, artifactId) => commentEffect(
        "findArtifact",
        () => adapters.repository.findArtifact(projectId, artifactId),
      ),
      findVersionRecord: (projectId, artifactId, versionId) => commentEffect(
        "findVersionRecord",
        () => adapters.repository.findVersionRecord(
          projectId,
          artifactId,
          versionId,
        ),
      ),
      findThread: (projectId, artifactId, threadId) => commentEffect(
        "findCommentThread",
        () => adapters.repository.findThread(projectId, artifactId, threadId),
      ),
      listReplies: (threadId) => commentEffect(
        "listCommentReplies",
        () => adapters.repository.listReplies(threadId),
      ),
      listThreads: (command) => commentEffect(
        "listCommentThreads",
        () => adapters.repository.listThreads(command),
      ),
      updateReply: (command) => commentEffect(
        "updateCommentReply",
        () => adapters.repository.updateReply(command),
      ),
      updateThread: (command) => commentEffect(
        "updateCommentThread",
        () => adapters.repository.updateThread(command),
      ),
      versionContainsPath: (projectId, versionId, path) => commentEffect(
        "versionContainsPath",
        () => adapters.repository.versionContainsPath(projectId, versionId, path),
      ),
    },
  };
  const dispatchStore = adapters.dispatches;
  const dispatchDependencies: AgentDispatchDependencies = {
    clock,
    ids: adapters.ids,
    installationId: adapters.installationId,
    repository: {
      cancelDispatch: (command) => dispatchEffect(
        "cancelAgentDispatch",
        () => dispatchStore.cancelDispatch(command),
      ),
      claimNextDispatch: (agentId, now, bumpHeartbeat) => dispatchEffect(
        "claimAgentDispatch",
        () => dispatchStore.claimNextDispatch(agentId, now, bumpHeartbeat),
      ),
      createDispatch: (command) => dispatchEffect(
        "createAgentDispatch",
        () => dispatchStore.createDispatch(command),
      ),
      disconnectAgent: (installationId, agentId) => dispatchEffect(
        "disconnectRegisteredAgent",
        () => dispatchStore.disconnectAgent(installationId, agentId),
      ),
      findAgent: (installationId, agentId) => dispatchEffect(
        "findRegisteredAgent",
        () => dispatchStore.findAgent(installationId, agentId),
      ),
      findDispatch: (installationId, dispatchId, now) => dispatchEffect(
        "findAgentDispatch",
        () => dispatchStore.findDispatch(installationId, dispatchId, now),
      ),
      listAgents: (installationId, now) => dispatchEffect(
        "listRegisteredAgents",
        () => dispatchStore.listAgents(installationId, now),
      ),
      listDispatches: (command) => dispatchEffect(
        "listAgentDispatches",
        () => dispatchStore.listDispatches(command),
      ),
      markDelivered: (command) => dispatchEffect(
        "markAgentDispatchDelivered",
        () => dispatchStore.markDelivered(command),
      ),
      markFailed: (command) => dispatchEffect(
        "markAgentDispatchFailed",
        () => dispatchStore.markFailed(command),
      ),
      observeAddressed: (dispatchId, now) => dispatchEffect(
        "observeAgentDispatchAddressed",
        () => dispatchStore.observeAddressed(dispatchId, now),
      ),
      registerAgent: (command) => dispatchEffect(
        "registerAgent",
        () => dispatchStore.registerAgent(command),
      ),
    },
  };
  const publicLinkAdministrationRepository: PublicLinkAdministrationRepository = {
    listPublicLinks: (command) =>
      Effect.tryPromise({
        try: () => adapters.repository.listPublicLinks(command),
        catch: (cause) => repositoryFailure("listPublicLinks", cause),
      }),
  };
  const comparisonDependencies: CompareArtifactDependencies = {
    blobs: {
      readBytes: (entry) =>
        Effect.tryPromise({
          try: () => readBlobBytes(adapters.blobs, entry),
          catch: (cause) =>
            new BlobStorageFailure({cause, operation: "open"}),
        }),
    },
    repository: {
      findArtifact: managementDependencies.repository.findArtifact,
      findVersionRecord: managementDependencies.repository.findVersionRecord,
    },
  };

  const contentDependencies: ContentAccessDependencies = {
    clock,
    repository: {
      createContentBootstrap: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.createContentBootstrap(command),
          catch: (cause) => repositoryFailure("createContentBootstrap", cause),
        }),
      exchangeContentBootstrap: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.exchangeContentBootstrap(command),
          catch: (cause) => repositoryFailure("exchangeContentBootstrap", cause),
        }),
      findContentSession: (tokenDigest, contentToken, requestTime) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findContentSession(
              tokenDigest,
              contentToken,
              requestTime,
            ),
          catch: (cause) => repositoryFailure("findContentSession", cause),
        }),
      findCurrentVersion: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.findCurrentVersion(projectId, artifactId),
          catch: (cause) => repositoryFailure("findCurrentVersion", cause),
        }),
      findVersionRecord: (projectId, artifactId, versionId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findVersionRecord(
              projectId,
              artifactId,
              versionId,
            ),
          catch: (cause) => repositoryFailure("findVersionRecord", cause),
        }),
      findVersionContent: (contentToken, requestedPath, fallback) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findVersionContent(
              contentToken,
              requestedPath,
              fallback,
            ),
          catch: (cause) => repositoryFailure("findVersionContent", cause),
        }),
    },
    secrets: {
      digest: (token) =>
        createHash("sha256").update(Redacted.value(token)).digest("hex"),
      issue: () => {
        const raw = randomBase64Url(32);
        return {
          digest: createHash("sha256").update(raw).digest("hex"),
          token: Redacted.make(raw, {label: "content-session-token"}),
        };
      },
    },
  };

  const localPrincipal: Principal = {
    authorizedByPrincipalId: null,
    capabilities: [
      principalCapabilities.connectAgents,
      principalCapabilities.createArtifact,
      principalCapabilities.issueContentSession,
      principalCapabilities.manageAnyArtifact,
      principalCapabilities.manageProjects,
      principalCapabilities.publishAnyArtifact,
      principalCapabilities.readArtifacts,
      principalCapabilities.writeComments,
    ],
    displayName: "Local",
    id: "local-api-token",
    installationId: adapters.installationId,
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
  const identityRepository = adapters.identityRepository;
  const identityLayer = InstallationAccessService.layer({
    bootstrapAdministratorEmail: adapters.bootstrapAdministratorEmail,
    clock: adapters.clock,
    ids: {
      apiKeyId: () => `key_${randomUUID()}`,
      memberId: () => `member_${randomUUID()}`,
      sessionId: () => `session_${randomUUID()}`,
    },
    installationId: adapters.installationId,
    localBootstrapCredential: adapters.localBootstrapCredential,
    localLoginAttemptLifetimeMilliseconds: 60 * 1_000,
    protectBootstrapAdministrator: adapters.protectBootstrapAdministrator,
    repository: {
      admitMember: (command) => identityEffectWithConflict(
        "admitMember",
        () => identityRepository.admitMember(command),
      ),
      bindExternalIdentity: (command) => identityEffectWithConflict(
        "bindExternalIdentity",
        () => identityRepository.bindExternalIdentity(command),
      ),
      createApiKey: (key) => identityEffect(
        "createApiKey",
        () => identityRepository.createApiKey(key),
      ),
      createApplicationSession: (command) => identityEffect(
        "createApplicationSession",
        () => identityRepository.createApplicationSession(command),
      ),
      consumeLoginAttempt: (stateDigest, provider, consumedAt) =>
        loginAttemptEffect(
          "consumeLoginAttempt",
          () => identityRepository.consumeLoginAttempt(
            stateDigest,
            provider,
            consumedAt,
          ),
        ),
      createLoginAttempt: (attempt) => identityEffect(
        "createLoginAttempt",
        () => identityRepository.createLoginAttempt(attempt),
      ),
      deactivateMember: (installationId, memberId, updatedAt) =>
        identityEffectWithConflictOrNotFound(
          "deactivateMember",
          () => identityRepository.deactivateMember(
            installationId,
            memberId,
            updatedAt,
          ),
        ),
      findActiveMemberByEmail: (installationId, email) => identityEffect(
        "findActiveMemberByEmail",
        () => identityRepository.findActiveMemberByEmail(installationId, email),
      ),
      findActiveMemberByExternalIdentity: (
        installationId,
        provider,
        subject,
      ) => identityEffect(
        "findActiveMemberByExternalIdentity",
        () => identityRepository.findActiveMemberByExternalIdentity(
          installationId,
          provider,
          subject,
        ),
      ),
      findMember: (installationId, memberId) => identityEffect(
        "findMember",
        () => identityRepository.findMember(installationId, memberId),
      ),
      findApiKey: (installationId, keyId) => identityEffect(
        "findApiKey",
        () => identityRepository.findApiKey(installationId, keyId),
      ),
      findApplicationSession: (installationId, tokenDigest, requestTime) =>
        identityEffect(
          "findApplicationSession",
          () => identityRepository.findApplicationSession(
            installationId,
            tokenDigest,
            requestTime,
          ),
        ),
      hasMembers: (installationId) => identityEffect(
        "hasMembers",
        () => identityRepository.hasMembers(installationId),
      ),
      listApiKeys: (installationId) => identityEffect(
        "listApiKeys",
        () => identityRepository.listApiKeys(installationId),
      ),
      listMembers: (installationId) => identityEffect(
        "listMembers",
        () => identityRepository.listMembers(installationId),
      ),
      revokeApiKey: (installationId, keyId, revokedAt) => identityEffectWithNotFound(
        "revokeApiKey",
        () => identityRepository.revokeApiKey(installationId, keyId, revokedAt),
      ),
      revokeApplicationSession: (installationId, tokenDigest, revokedAt) =>
        identityEffect(
          "revokeApplicationSession",
          () => identityRepository.revokeApplicationSession(
            installationId,
            tokenDigest,
            revokedAt,
          ),
        ),
      rotateApiKey: (installationId, previousKeyId, replacement, revokedAt) =>
        identityEffectWithConflictOrNotFound(
          "rotateApiKey",
          () => identityRepository.rotateApiKey(
            installationId,
            previousKeyId,
            replacement,
            revokedAt,
          ),
        ),
    },
    secrets: {
      digest: digestIdentitySecret,
      issue: () => randomBase64Url(32),
    },
    sessionLifetimeMilliseconds: 12 * 60 * 60 * 1_000,
  });
  const authenticationLayer = Layer.effect(
    AuthenticationService,
    InstallationAccessService.use((installationAccess) => {
      const authenticateBearerWith = (
        externalVerifier: BearerCredentialVerifier | null,
      ): BearerCredentialVerifier["verify"] => (credential) => {
        const raw = Redacted.value(credential);
        if (
          adapters.apiToken !== null
          && credentialsEqual(raw, Redacted.value(adapters.apiToken))
        ) {
          return Effect.succeed(localPrincipal);
        }
        if (raw.startsWith("as_key_")) {
          return installationAccess.authenticateManagedApiKey(credential);
        }
        if (externalVerifier !== null) return externalVerifier.verify(credential);
        return Effect.fail(new AuthenticationRequired({
          message: "A valid Artifact Server API key is required.",
        }));
      };
      const authenticateMcpBearer = Effect.fn(
        "AuthenticationService.authenticateMcpBearer",
      )(function*(credential: Redacted.Redacted) {
        const raw = Redacted.value(credential);
        if (
          adapters.apiToken !== null
          && credentialsEqual(raw, Redacted.value(adapters.apiToken))
        ) {
          return {
            clientId: localPrincipal.id,
            expiresAt: Math.floor(adapters.clock.now().getTime() / 1_000) + 60,
            principal: localPrincipal,
            scopes: ["mcp"],
          };
        }
        if (raw.startsWith("as_key_")) {
          return {
            clientId: "artifact-server-managed-api-key",
            expiresAt: Math.floor(adapters.clock.now().getTime() / 1_000) + 60,
            principal: yield* installationAccess.authenticateManagedApiKey(credential),
            scopes: ["mcp"],
          };
        }
        if (adapters.externalMcpBearerVerifier !== null) {
          return {
            clientId: "external-bearer",
            expiresAt: Math.floor(adapters.clock.now().getTime() / 1_000) + 60,
            principal: yield* adapters.externalMcpBearerVerifier.verify(credential),
            scopes: ["mcp"],
          };
        }
        const verifier = adapters.externalMcpOAuthVerifier;
        if (verifier === null) {
          return yield* Effect.fail(new AuthenticationRequired({
            message: "A valid Artifact Server MCP credential is required.",
          }));
        }
        const verified = yield* verifier.verify(credential);
        let principal = yield* installationAccess.authenticateExternalSubject(
          verified.provider,
          verified.subject,
        );
        if (principal === null) {
          const identity = yield* verifier.resolveIdentity(verified);
          principal = yield* installationAccess.authenticateExternalIdentity(identity);
        }
        return {
          clientId: verified.clientId ?? verified.subject,
          expiresAt: verified.expiresAt,
          principal,
          // The exact resource-bound audience grants access to this MCP
          // endpoint. WorkOS does not issue a separate product scope.
          scopes: ["mcp"],
        };
      });
      return Effect.succeed(AuthenticationService.of({
        authenticateApiBearer: authenticateBearerWith(
          adapters.externalApiBearerVerifier,
        ),
        authenticateApplicationSession: installationAccess.authenticateSession,
        authenticateMcpBearer,
      }));
    }),
  ).pipe(Layer.provideMerge(identityLayer));
  const interactiveLoginLayer = InteractiveLoginService.layer({
    attemptLifetimeMilliseconds: 10 * 60 * 1_000,
    clock: adapters.clock,
    provider: adapters.interactiveIdentityProvider,
    repository: {
      consume: (stateDigest, provider, consumedAt) =>
        loginAttemptEffect(
          "consumeLoginAttempt",
          () => identityRepository.consumeLoginAttempt(
            stateDigest,
            provider,
            consumedAt,
          ),
        ),
      create: (attempt) => identityEffect(
        "createLoginAttempt",
        () => identityRepository.createLoginAttempt(attempt),
      ),
    },
  }).pipe(Layer.provideMerge(identityLayer));
  const authorizationLayer = AuthorizationService.layer({
    installationId: adapters.installationId,
  });
  const projectLayer = ProjectManagementService.layer(projectDependencies).pipe(
    Layer.provideMerge(authorizationLayer),
  );
  const projectGitHistoryLayer = ProjectGitHistoryService.layer(
    projectGitHistoryDependencies,
  ).pipe(Layer.provideMerge(Layer.mergeAll(authorizationLayer, projectLayer)));

  const publishLayer = PublishArtifactService.layer(publishDependencies).pipe(
    Layer.provideMerge(authorizationLayer),
  );
  const stagedLayer = StagedUploadService.layer(stagedDependencies).pipe(
    Layer.provideMerge(Layer.mergeAll(publishLayer, projectLayer)),
  );
  const cleanupLayer = ExpiredStagingCleanupService.layer({
    clock,
    concurrency: adapters.stagingCleanupPolicy?.concurrency ??
      defaultStagingCleanupPolicy.concurrency,
    repository: stagedDependencies.uploads,
    settleDelayMilliseconds:
      adapters.stagingCleanupPolicy?.settleDelayMilliseconds ??
        defaultStagingCleanupPolicy.settleDelayMilliseconds,
    storage: stagedDependencies.staging,
  });
  const contentLayer = ContentAccessService.layer(contentDependencies).pipe(
    Layer.provideMerge(Layer.mergeAll(authorizationLayer, projectLayer)),
  );
  const managementLayer = ArtifactManagementService.layer(
    managementDependencies,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(authorizationLayer, identityLayer, projectLayer),
    ),
  );
  const linked = adapters.linked;
  const linkedLayer = linked === undefined
    ? disabledLinkedArtifactLayer
    : LinkedArtifactService.layer({
      bindings: {
        commitCapturedVersion: (command) =>
          Effect.tryPromise({
            try: () => linked.bindings.commitCapturedVersion(command),
            catch: classifyCapturedCommitFailure,
          }),
        commitLinkedArtifact: (command) =>
          Effect.tryPromise({
            try: () => linked.bindings.commitLinkedArtifact(command),
            catch: classifyLinkedCommitFailure,
          }),
        findSourceBinding: (projectId, artifactId) =>
          Effect.tryPromise({
            try: () => linked.bindings.findSourceBinding(projectId, artifactId),
            catch: (cause) => repositoryFailure("linkedSource", cause),
          }),
        recordSourceFreshness: (command) =>
          Effect.tryPromise({
            try: () => linked.bindings.recordSourceFreshness(command),
            catch: (cause) => repositoryFailure("linkedSource", cause),
          }),
        relinkSource: (command) =>
          Effect.tryPromise({
            try: () => linked.bindings.relinkSource(command),
            catch: classifyRelinkFailure,
          }),
      },
      blobs: publishDependencies.blobs,
      clock,
      configuration: linked.configuration,
      engine: linked.engine,
      ids: adapters.ids,
      liveSessions: {
        createContentBootstrap: (command) =>
          contentDependencies.repository.createContentBootstrap(command),
        findContentSession: (tokenDigest, contentToken, requestTime) =>
          contentDependencies.repository.findContentSession(
            tokenDigest,
            contentToken,
            requestTime,
          ),
      },
      publication: {
        assertPublicationSourceReady: (source, manifestDigest, commitTime) =>
          publishDependencies.repository.assertPublicationSourceReady(
            source,
            manifestDigest,
            commitTime,
          ),
        findCurrentVersion: (projectId, artifactId) =>
          publishDependencies.repository.findCurrentVersion(
            projectId,
            artifactId,
          ),
        findIdempotentPublication: (projectId, idempotencyKey, inputDigest) =>
          publishDependencies.repository.findIdempotentPublication(
            projectId,
            idempotencyKey,
            inputDigest,
          ),
        findVersionRecord: (projectId, artifactId, versionId) =>
          contentDependencies.repository.findVersionRecord(
            projectId,
            artifactId,
            versionId,
          ),
      },
      secrets: contentDependencies.secrets,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(authorizationLayer, projectLayer, stagedLayer),
      ),
    );
  const commentLayer = ArtifactCommentService.layer(commentDependencies).pipe(
    Layer.provideMerge(
      Layer.mergeAll(authorizationLayer, projectLayer, linkedLayer),
    ),
  );
  const dispatchLayer = AgentDispatchService.layer(dispatchDependencies).pipe(
    Layer.provideMerge(Layer.mergeAll(authorizationLayer, projectLayer)),
  );
  const publicLinkAdministrationLayer = PublicLinkAdministrationService.layer(
    publicLinkAdministrationRepository,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(authorizationLayer, managementLayer)),
  );
  const comparisonLayer = CompareArtifactService.layer(
    comparisonDependencies,
  ).pipe(Layer.provideMerge(Layer.mergeAll(authorizationLayer, projectLayer)));
  return Layer.mergeAll(
    authenticationLayer,
    commentLayer,
    dispatchLayer,
    identityLayer,
    interactiveLoginLayer,
    stagedLayer,
    contentLayer,
    cleanupLayer,
    linkedLayer,
    managementLayer,
    publicLinkAdministrationLayer,
    comparisonLayer,
    projectGitHistoryLayer,
    projectLayer,
  );
}

/** Backward-compatible local composition name. */
export const createLocalApplicationLayer = createApplicationLayer;

function combineAbortSignals(
  fiberSignal: AbortSignal,
  deadlineSignal: AbortSignal | undefined,
): AbortSignal {
  return deadlineSignal === undefined
    ? fiberSignal
    : AbortSignal.any([fiberSignal, deadlineSignal]);
}

function identityEffect<A>(
  operation: IdentityRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, IdentityRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new IdentityRepositoryFailure({cause, operation}),
  });
}

function identityEffectWithConflict<A>(
  operation: IdentityRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, IdentityConflict | IdentityRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof IdentityConflict
      ? cause
      : new IdentityRepositoryFailure({cause, operation}),
  });
}

function identityEffectWithNotFound<A>(
  operation: IdentityRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, IdentityNotFound | IdentityRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof IdentityNotFound
      ? cause
      : new IdentityRepositoryFailure({cause, operation}),
  });
}

function identityEffectWithConflictOrNotFound<A>(
  operation: IdentityRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<
  A,
  IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof IdentityConflict || cause instanceof IdentityNotFound
        ? cause
        : new IdentityRepositoryFailure({cause, operation}),
  });
}

function loginAttemptEffect<A>(
  operation: IdentityRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, LoginAttemptRejected | IdentityRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof LoginAttemptRejected
      ? cause
      : new IdentityRepositoryFailure({cause, operation}),
  });
}

async function readBlobBytes(
  blobs: BlobStore,
  entry: ManifestEntry,
): Promise<Uint8Array> {
  const opened = await blobs.open(entry.sha256);
  if (opened.size !== entry.size) {
    await opened.body.cancel();
    throw new Error(
      `Stored blob ${entry.sha256} is ${opened.size} bytes but its manifest records ${entry.size}.`,
    );
  }
  const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `Stored blob ${entry.sha256} yielded ${bytes.byteLength} bytes but its manifest records ${entry.size}.`,
    );
  }
  return bytes;
}

function credentialsEqual(actualToken: string, expectedToken: string): boolean {
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  return actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected);
}

function classifyLinkedCommitFailure(cause: unknown) {
  if (
    cause instanceof IdempotencyConflict || cause instanceof ProjectArchived
  ) return cause;
  return repositoryFailure("linkedSource", cause);
}

function classifyCapturedCommitFailure(cause: unknown) {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof IdempotencyConflict ||
    cause instanceof ProjectArchived ||
    cause instanceof PublishConflict
  ) {
    return cause;
  }
  return repositoryFailure("linkedSource", cause);
}

function classifyRelinkFailure(cause: unknown) {
  if (
    cause instanceof ArtifactNotFound || cause instanceof IdempotencyConflict
  ) return cause;
  return repositoryFailure("linkedSource", cause);
}

function classifySourceReadinessFailure(cause: unknown) {
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("assertPublicationSourceReady", cause);
}

function classifyCommitNewFailure(cause: unknown) {
  if (
    cause instanceof IdempotencyConflict || cause instanceof ProjectArchived
  ) return cause;
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("commitNewArtifact", cause);
}

function classifyCommitVersionFailure(cause: unknown) {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof IdempotencyConflict ||
    cause instanceof ProjectArchived ||
    cause instanceof PublishConflict
  ) {
    return cause;
  }
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("commitVersion", cause);
}

function classifyChangeAccessFailure(cause: unknown):
  | ArtifactNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | ArtifactRepositoryFailure {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof ArtifactMutationConflict ||
    cause instanceof IdempotencyConflict
  ) {
    return cause;
  }
  return repositoryFailure("changeAccessSetting", cause);
}

function classifyChangeTagsFailure(cause: unknown):
  | ArtifactNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | ArtifactRepositoryFailure {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof ArtifactMutationConflict ||
    cause instanceof IdempotencyConflict
  ) {
    return cause;
  }
  return repositoryFailure("changeTags", cause);
}

function classifyRestoreFailure(cause: unknown):
  | ArtifactNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | VersionNotFound
  | ArtifactRepositoryFailure {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof ArtifactMutationConflict ||
    cause instanceof IdempotencyConflict ||
    cause instanceof VersionNotFound
  ) {
    return cause;
  }
  return repositoryFailure("restoreVersion", cause);
}

function classifyDeleteFailure(cause: unknown):
  | ArtifactNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | ArtifactRepositoryFailure {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof ArtifactMutationConflict ||
    cause instanceof IdempotencyConflict
  ) {
    return cause;
  }
  return repositoryFailure("deleteArtifact", cause);
}

function dispatchEffect<A>(
  operation: ArtifactRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, AgentDispatchRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => classifyDispatchFailure(operation, cause),
  });
}

function classifyDispatchFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): AgentDispatchRepositoryFailure {
  if (
    cause instanceof AgentDispatchNotFound ||
    cause instanceof AgentNotFound ||
    cause instanceof DispatchStateConflict ||
    cause instanceof IdempotencyConflict ||
    cause instanceof InvalidDispatch
  ) {
    return cause;
  }
  return repositoryFailure(operation, cause);
}

function commentEffect<A>(
  operation: ArtifactRepositoryFailure["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, CommentRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => classifyCommentFailure(operation, cause),
  });
}

function classifyCommentFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): CommentRepositoryFailure {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof CommentNotFound ||
    cause instanceof CommentResolved ||
    cause instanceof IdempotencyConflict ||
    cause instanceof InvalidComment ||
    cause instanceof VersionNotFound
  ) {
    return cause;
  }
  return repositoryFailure(operation, cause);
}

function repositoryFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure({cause, operation});
}
