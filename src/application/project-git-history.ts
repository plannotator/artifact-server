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
  readonly state:
    | "backfilling"
    | "budget-limited"
    | "degraded"
    | "disabled"
    | "ready"
    | "waiting";
}

/** Bounded durable counts used to derive one project's effective state. */
export interface ProjectGitHistoryProgress {
  readonly budgetLimitedJobs: number;
  readonly mappedVersions: number;
  readonly pendingJobs: number;
  readonly unmappedVersions: number;
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
  readonly limits: GitHistoryLimits;
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
  readonly readProjectGitHistoryProgress: (
    projectId: string,
  ) => Effect.Effect<ProjectGitHistoryProgress, ArtifactRepositoryFailure>;
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
  readonly readProjectGitHistoryProgress: (
    projectId: string,
  ) => Promise<ProjectGitHistoryProgress>;
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

/** Owns deployment-neutral project selection and bounded history backfill. */
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
  const projectSettingProjection = Effect.fn(
    "ProjectGitHistoryService.projectSettingProjection",
  )(function*(projectId: string, enabled: boolean) {
    if (!enabled) return {enabled, projectId, state: "disabled" as const};
    const capability = dependencies.provider.read();
    if (
      capability.providerState === "degraded" ||
      capability.providerState === "misconfigured" ||
      capability.providerState === "migration-required"
    ) {
      return {enabled, projectId, state: "degraded" as const};
    }
    const progress = yield* dependencies.repository
      .readProjectGitHistoryProgress(projectId);
    if (progress.budgetLimitedJobs > 0) {
      return {enabled, projectId, state: "budget-limited" as const};
    }
    if (capability.providerState !== "available") {
      return {enabled, projectId, state: "waiting" as const};
    }
    if (progress.unmappedVersions === 0 && progress.pendingJobs === 0) {
      return {enabled, projectId, state: "ready" as const};
    }
    return {
      enabled,
      projectId,
      state: progress.mappedVersions === 0 ? "waiting" as const : "backfilling" as const,
    };
  });

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
      return yield* projectSettingProjection(
        command.projectId,
        stored?.enabled ?? false,
      );
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
        return yield* projectSettingProjection(command.projectId, command.enabled);
      }
      const capability = command.enabled
        ? yield* requireConfigured()
        : dependencies.provider.read();
      if (command.enabled) {
        if (capability.providerState !== "available") {
          return yield* new CapabilityUnavailable({
            message: "Git history is configured but the provider is not currently available.",
          });
        }
      }
      const setting = yield* dependencies.repository.storeProjectGitHistorySetting({
        enabled: command.enabled,
        limits: capability.limits,
        projectId: command.projectId,
        updatedAt: DateTime.formatIso(yield* dependencies.clock.now),
        updatedByPrincipalId: command.principal.id,
      });
      return yield* projectSettingProjection(setting.projectId, setting.enabled);
    },
  );

  return ProjectGitHistoryService.of({estimate, read, set});
}
