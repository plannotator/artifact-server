import {Context, DateTime, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ReadProjectCommand,
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  type ArtifactRepositoryFailure,
  CapabilityUnavailable,
} from "../core/errors.js";
import type {
  GitHistoryCapabilityReader,
  GitHistoryLimits,
} from "../git-history/git-history-capability.js";

/** Persisted values for one project's Git history switch. */
export interface StoredProjectGitHistorySetting {
  readonly enabled: boolean;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
}

/** Secret-free product projection for one project's Git history switch. */
export interface ProjectGitHistorySetting {
  readonly enabled: boolean;
  readonly projectId: string;
}

/** Current-inventory planning summary shown before project enablement. */
export interface ProjectGitHistoryEstimate {
  readonly estimatedCopiedBytes: number;
  readonly estimatedPointerBytes: number;
  readonly notice: string;
  readonly operations: number;
  readonly projectId: string;
  readonly repositories: number;
  readonly versions: number;
}

/** Persistence input for changing one project's Git history switch. */
export interface StoreProjectGitHistorySetting {
  readonly enabled: boolean;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
}

/** Persistence required by the simple per-project Git history surface. */
export interface ProjectGitHistoryRepository {
  readonly estimateProjectGitHistory: (
    projectId: string,
    limits: Pick<GitHistoryLimits, "fileCopyBytes" | "versionCopyBytes">,
  ) => Effect.Effect<
    Omit<ProjectGitHistoryEstimate, "notice" | "operations" | "projectId">,
    ArtifactRepositoryFailure
  >;
  readonly readProjectGitHistorySetting: (
    projectId: string,
  ) => Effect.Effect<StoredProjectGitHistorySetting | null, ArtifactRepositoryFailure>;
  readonly storeProjectGitHistorySetting: (
    setting: StoreProjectGitHistorySetting,
  ) => Effect.Effect<StoredProjectGitHistorySetting, ArtifactRepositoryFailure>;
}

/** Promise-based adapter surface implemented by concrete storage repositories. */
export interface ProjectGitHistoryStore {
  readonly estimateProjectGitHistory: (
    projectId: string,
    limits: Pick<GitHistoryLimits, "fileCopyBytes" | "versionCopyBytes">,
  ) => Promise<Omit<ProjectGitHistoryEstimate, "notice" | "operations" | "projectId">>;
  readonly readProjectGitHistorySetting: (
    projectId: string,
  ) => Promise<StoredProjectGitHistorySetting | null>;
  readonly storeProjectGitHistorySetting: (
    setting: StoreProjectGitHistorySetting,
  ) => Promise<StoredProjectGitHistorySetting>;
}

/** Dependencies for the simple per-project Git history surface. */
export interface ProjectGitHistoryDependencies {
  readonly clock: ApplicationClock;
  readonly provider: GitHistoryCapabilityReader;
  readonly repository: ProjectGitHistoryRepository;
}

/** Input for estimating one project's current Git history copy. */
export type EstimateProjectGitHistoryCommand = ReadProjectCommand;

/** Input for reading one project's Git history switch. */
export type ReadProjectGitHistoryCommand = ReadProjectCommand;

/** Input for naturally idempotent project Git history changes. */
export type SetProjectGitHistoryCommand =
  | ReadProjectCommand & {
    readonly confirmEstimate: true;
    readonly enabled: true;
  }
  | ReadProjectCommand & {
    readonly enabled: false;
  };

/** Expected failures from project Git history operations. */
export type ProjectGitHistoryFailure =
  | ArtifactRepositoryFailure
  | CapabilityUnavailable
  | ProjectManagementFailure;

interface ProjectGitHistoryOperations {
  readonly estimate: (
    command: EstimateProjectGitHistoryCommand,
  ) => Effect.Effect<ProjectGitHistoryEstimate, ProjectGitHistoryFailure>;
  readonly read: (
    command: ReadProjectGitHistoryCommand,
  ) => Effect.Effect<ProjectGitHistorySetting, ProjectGitHistoryFailure>;
  readonly set: (
    command: SetProjectGitHistoryCommand,
  ) => Effect.Effect<ProjectGitHistorySetting, ProjectGitHistoryFailure>;
}

/** Owns the intentionally small off-by-default Git history setting per project. */
export class ProjectGitHistoryService extends Context.Service<
  ProjectGitHistoryService,
  ProjectGitHistoryOperations
>()("artifact-server/application/ProjectGitHistoryService") {
  /** Construct project Git history operations from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ProjectGitHistoryDependencies,
  ): Layer.Layer<
    ProjectGitHistoryService,
    never,
    AuthorizationService | ProjectManagementService
  > => Layer.effect(
    ProjectGitHistoryService,
    Effect.gen(function*() {
      const authorization = yield* AuthorizationService;
      const projects = yield* ProjectManagementService;
      return makeProjectGitHistoryService(dependencies, authorization, projects);
    }),
  );
}

const estimateNotice =
  "Planning estimate from current saved versions and configured copy limits. " +
  "It excludes future activity, retries, clone traffic, Git compression, and " +
  "other account usage; it is not an invoice.";

function makeProjectGitHistoryService(
  dependencies: ProjectGitHistoryDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): ProjectGitHistoryOperations {
  const requireConfigured = Effect.fn("ProjectGitHistoryService.requireConfigured")(
    function*() {
      const capability = dependencies.provider.read();
      if (
        capability.provider !== "cloudflare-artifacts" ||
        capability.providerState === "disabled" ||
        capability.providerState === "misconfigured" ||
        capability.providerState === "migration-required"
      ) {
        return yield* new CapabilityUnavailable({
          message: "Git history is not configured for use in this deployment.",
        });
      }
      return capability;
    },
  );

  const read = Effect.fn("ProjectGitHistoryService.read")(
    function*(command: ReadProjectGitHistoryCommand) {
      yield* projects.getProject(command);
      const stored = yield* dependencies.repository
        .readProjectGitHistorySetting(command.projectId);
      return {
        enabled: stored?.enabled ?? false,
        projectId: command.projectId,
      };
    },
  );

  const estimate = Effect.fn("ProjectGitHistoryService.estimate")(
    function*(command: EstimateProjectGitHistoryCommand) {
      yield* authorization.requireProjectManagement(command.principal);
      yield* projects.getProject(command);
      const capability = yield* requireConfigured();
      const values = yield* dependencies.repository.estimateProjectGitHistory(
        command.projectId,
        capability.limits,
      );
      return {
        ...values,
        notice: estimateNotice,
        operations: values.repositories + values.versions,
        projectId: command.projectId,
      };
    },
  );

  const set = Effect.fn("ProjectGitHistoryService.set")(
    function*(command: SetProjectGitHistoryCommand) {
      yield* authorization.requireProjectManagement(command.principal);
      yield* projects.getProject(command);
      const existing = yield* dependencies.repository
        .readProjectGitHistorySetting(command.projectId);
      if ((existing?.enabled ?? false) === command.enabled) {
        return {enabled: command.enabled, projectId: command.projectId};
      }
      if (command.enabled) yield* requireConfigured();
      const setting = yield* dependencies.repository.storeProjectGitHistorySetting({
        enabled: command.enabled,
        projectId: command.projectId,
        updatedAt: DateTime.formatIso(yield* dependencies.clock.now),
        updatedByPrincipalId: command.principal.id,
      });
      return {enabled: setting.enabled, projectId: setting.projectId};
    },
  );

  return ProjectGitHistoryService.of({estimate, read, set});
}
