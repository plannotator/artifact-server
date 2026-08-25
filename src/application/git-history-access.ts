import {Context, Effect, Layer} from "effect";

import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  CapabilityUnavailable,
  type AuthorizationDenied,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {ArtifactRecord} from "../core/model.js";
import type {
  GitCloneCredential,
  GitHistoryProvider,
  GitRepositoryCoordinates,
} from "../git-history/git-history-mirror.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import type {StoredProjectGitHistorySetting} from "./project-git-history.js";

export const defaultGitCloneCredentialTtlSeconds = 15 * 60;
export const maximumGitCloneCredentialTtlSeconds = 60 * 60;

export interface GitHistoryCloneAccess {
  readonly defaultBranch: "main";
  readonly expiresAt: string;
  readonly remote: string;
  readonly token: string;
}

export interface IssueGitHistoryCloneCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string;
  readonly ttlSeconds: number;
}

export interface GitHistoryAccessRepository {
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findGitHistoryRepository: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<GitRepositoryCoordinates | null, ArtifactRepositoryFailure>;
  readonly readProjectGitHistorySetting: (
    projectId: string,
  ) => Effect.Effect<StoredProjectGitHistorySetting | null, ArtifactRepositoryFailure>;
}

export interface GitHistoryAccessDependencies {
  readonly provider: GitHistoryProvider | null;
  readonly repository: GitHistoryAccessRepository;
}

export type GitHistoryAccessFailure =
  | ArtifactNotFound
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | CapabilityUnavailable
  | ProjectManagementFailure;

interface GitHistoryAccessOperations {
  readonly issueCloneCredential: (
    command: IssueGitHistoryCloneCommand,
  ) => Effect.Effect<GitHistoryCloneAccess, GitHistoryAccessFailure>;
}

/** Authorizes and mints one bounded, repository-scoped clone credential. */
export class GitHistoryAccessService extends Context.Service<
  GitHistoryAccessService,
  GitHistoryAccessOperations
>()("artifact-server/application/GitHistoryAccessService") {
  static readonly layer = (
    dependencies: GitHistoryAccessDependencies,
  ): Layer.Layer<
    GitHistoryAccessService,
    never,
    AuthorizationService | ProjectManagementService
  > => Layer.effect(
    GitHistoryAccessService,
    Effect.gen(function*() {
      const authorization = yield* AuthorizationService;
      const projects = yield* ProjectManagementService;
      return makeGitHistoryAccessService(dependencies, authorization, projects);
    }),
  );
}

function makeGitHistoryAccessService(
  dependencies: GitHistoryAccessDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): GitHistoryAccessOperations {
  const issueCloneCredential = Effect.fn(
    "GitHistoryAccessService.issueCloneCredential",
  )(function*(command: IssueGitHistoryCloneCommand) {
    yield* authorization.requireArtifactRead(command.principal);
    yield* projects.getProject(command);
    const artifact = yield* dependencies.repository.findArtifact(
      command.projectId,
      command.artifactId,
    );
    const setting = yield* dependencies.repository
      .readProjectGitHistorySetting(command.projectId);
    const coordinates = yield* dependencies.repository.findGitHistoryRepository(
      command.projectId,
      command.artifactId,
    );
    if (
      artifact === null || artifact.deletedAt !== null ||
      setting?.enabled !== true || coordinates?.status !== "provisioned" ||
      dependencies.provider === null
    ) {
      return yield* new ArtifactNotFound({
        message: "Git history is not available for this artifact.",
      });
    }
    const provider = dependencies.provider;
    if (provider === null) {
      return yield* new ArtifactNotFound({
        message: "Git history is not available for this artifact.",
      });
    }
    const credential = yield* Effect.tryPromise({
      try: () => provider.issueCredential(
        coordinates,
        "read",
        command.ttlSeconds,
      ),
      catch: () => new CapabilityUnavailable({
        message: "Git history is temporarily unavailable.",
      }),
    });
    return projectCloneAccess(coordinates, credential);
  });
  return GitHistoryAccessService.of({issueCloneCredential});
}

function projectCloneAccess(
  coordinates: GitRepositoryCoordinates,
  credential: GitCloneCredential,
): GitHistoryCloneAccess {
  return {
    defaultBranch: coordinates.defaultBranch,
    expiresAt: credential.expiresAt,
    remote: coordinates.remoteUrl,
    token: credential.token,
  };
}
