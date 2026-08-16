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
  ArtifactNotFound,
  ArtifactMutationConflict,
  ArtifactRepositoryFailure,
  AuthenticationRequired,
  BlobStorageFailure,
  IdempotencyConflict,
  IdentityConflict,
  IdentityNotFound,
  IdentityRepositoryFailure,
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
  ArtifactRepository,
  BlobStore,
  Clock,
  ContentSessionRepository,
  IdGenerator,
  ProjectRepository,
  StagedUploadRepository,
  StagingStore,
} from "../core/ports.js";
import type {IdentityRepository} from "../core/identity-ports.js";
import type { ManifestEntry } from "../core/model.js";
import {randomBase64Url} from "../core/random.js";
import { FileVerificationError } from "../storage/verified-file.js";
import {defaultStagingCleanupPolicy} from
  "../lifecycle/staging-cleanup.js";

/** Concrete Node adapters reused by the Effect application layer. */
export interface ApplicationAdapters {
  readonly apiToken: Redacted.Redacted;
  readonly blobs: BlobStore;
  readonly bootstrapAdministratorEmail: string;
  readonly clock: Clock;
  readonly externalApiBearerVerifier: BearerCredentialVerifier | null;
  readonly externalMcpBearerVerifier: BearerCredentialVerifier | null;
  readonly externalMcpOAuthVerifier: ExternalMcpBearerVerifier | null;
  readonly ids: IdGenerator;
  readonly identityRepository: IdentityRepository;
  readonly installationId: string;
  readonly interactiveIdentityProvider: InteractiveIdentityProvider | null;
  readonly localBootstrapCredential: Redacted.Redacted | null;
  readonly repository: ArtifactRepository &
    ContentSessionRepository &
    ProjectRepository &
    StagedUploadRepository;
  readonly staging: StagingStore;
  readonly stagingCleanupPolicy?: {
    readonly concurrency: number;
    readonly settleDelayMilliseconds: number;
  };
}

/** Build Node application services over the selected persistence adapters. */
export function createApplicationLayer(
  adapters: ApplicationAdapters,
): Layer.Layer<
  | AuthenticationService
  | ArtifactManagementService
  | AuthorizationService
  | CompareArtifactService
  | ContentAccessService
  | ExpiredStagingCleanupService
  | InstallationAccessService
  | InteractiveLoginService
  | PublishArtifactService
  | ProjectManagementService
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
  const managementDependencies: ArtifactManagementDependencies = {
    clock,
    repository: {
      changeAccessSetting: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.changeAccessSetting(command),
          catch: classifyChangeAccessFailure,
        }),
      changeOwnership: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.changeOwnership(command),
          catch: classifyChangeOwnershipFailure,
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
      findArtifactVersion: (projectId, artifactId, versionId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findArtifactVersion(
              projectId,
              artifactId,
              versionId,
            ),
          catch: (cause) => repositoryFailure("findArtifactVersion", cause),
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
      findArtifactVersion: managementDependencies.repository.findArtifactVersion,
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
      findArtifactVersion: (projectId, artifactId, versionId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findArtifactVersion(
              projectId,
              artifactId,
              versionId,
            ),
          catch: (cause) => repositoryFailure("findArtifactVersion", cause),
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
      principalCapabilities.createArtifact,
      principalCapabilities.issueContentSession,
      principalCapabilities.manageAnyArtifact,
      principalCapabilities.manageOwnedArtifact,
      principalCapabilities.manageProjects,
      principalCapabilities.publishAnyArtifact,
      principalCapabilities.publishOwnedArtifact,
      principalCapabilities.readArtifacts,
    ],
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
        if (raw.startsWith("as_key_")) {
          return installationAccess.authenticateManagedApiKey(credential);
        }
        if (credentialsEqual(raw, Redacted.value(adapters.apiToken))) {
          return Effect.succeed(localPrincipal);
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
        if (raw.startsWith("as_key_")) {
          return {
            clientId: "artifact-server-managed-api-key",
            expiresAt: Math.floor(adapters.clock.now().getTime() / 1_000) + 60,
            principal: yield* installationAccess.authenticateManagedApiKey(credential),
            scopes: ["mcp"],
          };
        }
        if (credentialsEqual(raw, Redacted.value(adapters.apiToken))) {
          return {
            clientId: localPrincipal.id,
            expiresAt: Math.floor(adapters.clock.now().getTime() / 1_000) + 60,
            principal: localPrincipal,
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
  const comparisonLayer = CompareArtifactService.layer(
    comparisonDependencies,
  ).pipe(Layer.provideMerge(Layer.mergeAll(authorizationLayer, projectLayer)));
  return Layer.mergeAll(
    authenticationLayer,
    identityLayer,
    interactiveLoginLayer,
    stagedLayer,
    contentLayer,
    cleanupLayer,
    managementLayer,
    comparisonLayer,
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

function classifyChangeOwnershipFailure(cause: unknown):
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
  return repositoryFailure("changeOwnership", cause);
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

function repositoryFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure({cause, operation});
}
