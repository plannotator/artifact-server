import {Context, DateTime, Effect, Layer, Schema} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  InvalidProjectName,
  ProjectArchived,
  type ProjectConflict,
  ProjectNotFound,
  ProjectSelectionRequired,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {ProjectRecord} from "../core/model.js";
import type {
  CreateProject,
  IdGenerator,
  RenameProject,
  SetProjectArchive,
} from "../core/ports.js";

const projectNameSchema = Schema.Trim.check(Schema.isLengthBetween(1, 120));
const decodeProjectName = Schema.decodeUnknownEffect(projectNameSchema);

/** Input for creating one project inside the current installation. */
export interface CreateProjectCommand {
  readonly name: string;
  readonly principal: Principal;
}

/** Input for selecting one active project, with omission allowed for zero-setup use. */
export interface ResolveActiveProjectCommand {
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for reading one project inside the current installation. */
export interface ReadProjectCommand {
  readonly principal: Principal;
  readonly projectId: string;
}

/** Input for changing one project's label. */
export interface RenameProjectCommand extends ReadProjectCommand {
  readonly name: string;
}

/** Persistence required by project lifecycle operations. */
export interface ProjectManagementRepository {
  readonly createProject: (
    command: CreateProject,
  ) => Effect.Effect<ProjectRecord, ProjectConflict | ArtifactRepositoryFailure>;
  readonly findProject: (
    projectId: string,
  ) => Effect.Effect<ProjectRecord | null, ArtifactRepositoryFailure>;
  readonly listProjects: () => Effect.Effect<
    readonly ProjectRecord[],
    ArtifactRepositoryFailure
  >;
  readonly renameProject: (
    command: RenameProject,
  ) => Effect.Effect<ProjectRecord, ProjectNotFound | ArtifactRepositoryFailure>;
  readonly setProjectArchive: (
    command: SetProjectArchive,
  ) => Effect.Effect<
    ProjectRecord,
    ProjectConflict | ProjectNotFound | ArtifactRepositoryFailure
  >;
}

/** Dependencies used to construct project lifecycle operations. */
export interface ProjectManagementDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly repository: ProjectManagementRepository;
}

/** Expected failures produced by project lifecycle operations. */
export type ProjectManagementFailure =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | InvalidProjectName
  | ProjectArchived
  | ProjectConflict
  | ProjectNotFound
  | ProjectSelectionRequired;

interface ProjectManagementOperations {
  readonly archiveProject: (
    command: ReadProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
  readonly createProject: (
    command: CreateProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
  readonly getProject: (
    command: ReadProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
  readonly listProjects: (
    principal: Principal,
  ) => Effect.Effect<readonly ProjectRecord[], ProjectManagementFailure>;
  readonly renameProject: (
    command: RenameProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
  readonly resolveActiveProject: (
    command: ResolveActiveProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
  readonly unarchiveProject: (
    command: ReadProjectCommand,
  ) => Effect.Effect<ProjectRecord, ProjectManagementFailure>;
}

/** Owns project selection and lifecycle policy for one installation. */
export class ProjectManagementService extends Context.Service<
  ProjectManagementService,
  ProjectManagementOperations
>()("artifact-server/application/ProjectManagementService") {
  /** Construct project operations from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ProjectManagementDependencies,
  ): Layer.Layer<ProjectManagementService, never, AuthorizationService> =>
    Layer.effect(
      ProjectManagementService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeProjectManagementService(dependencies, authorization);
      }),
    );
}

function makeProjectManagementService(
  dependencies: ProjectManagementDependencies,
  authorization: AuthorizationOperations,
): ProjectManagementOperations {
  const requireProject = Effect.fn("ProjectManagementService.requireProject")(
    function*(principal: Principal, projectId: string) {
      yield* authorization.requireProjectAccess(principal);
      const project = yield* dependencies.repository.findProject(projectId);
      if (
        project !== null &&
        project.installationId === dependencies.installationId
      ) {
        yield* Effect.annotateCurrentSpan({"artifact.project.id": project.id});
        return project;
      }
      return yield* new ProjectNotFound({message: "The project does not exist."});
    },
  );

  const listProjects = Effect.fn("ProjectManagementService.listProjects")(
    function*(principal: Principal) {
      yield* authorization.requireProjectAccess(principal);
      return yield* dependencies.repository.listProjects();
    },
  );

  const resolveActiveProject = Effect.fn(
    "ProjectManagementService.resolveActiveProject",
  )(function*(command: ResolveActiveProjectCommand) {
    if (command.projectId !== null) {
      const project = yield* requireProject(command.principal, command.projectId);
      if (project.archivedAt !== null) {
        return yield* new ProjectArchived({
          message: "The project is archived and cannot accept new work.",
        });
      }
      return project;
    }
    const projects = (yield* listProjects(command.principal)).filter(
      (project) => project.archivedAt === null,
    );
    const onlyProject = projects.length === 1 ? projects[0] : undefined;
    if (onlyProject !== undefined) {
      yield* Effect.annotateCurrentSpan({"artifact.project.id": onlyProject.id});
      return onlyProject;
    }
    if (projects.length === 0) {
      return yield* new ProjectNotFound({
        message: "This installation has no active project.",
      });
    }
    return yield* new ProjectSelectionRequired({
      message: `Choose a project before continuing: ${projects.map(
        ({id, name}) => `${name} (${id})`,
      ).join(", ")}.`,
      projects: projects.map(({id, name}) => ({id, name})),
    });
  });

  const createProject = Effect.fn("ProjectManagementService.createProject")(
    function*(command: CreateProjectCommand) {
      yield* authorization.requireProjectManagement(command.principal);
      const name = yield* parseProjectName(command.name);
      const project = yield* dependencies.repository.createProject({
        archivedAt: null,
        createdAt: DateTime.formatIso(yield* dependencies.clock.now),
        id: dependencies.ids.projectId(),
        installationId: dependencies.installationId,
        name,
      });
      yield* Effect.annotateCurrentSpan({"artifact.project.id": project.id});
      return project;
    },
  );

  const getProject = Effect.fn("ProjectManagementService.getProject")(
    function*(command: ReadProjectCommand) {
      return yield* requireProject(command.principal, command.projectId);
    },
  );

  const renameProject = Effect.fn("ProjectManagementService.renameProject")(
    function*(command: RenameProjectCommand) {
      yield* authorization.requireProjectManagement(command.principal);
      yield* requireProject(command.principal, command.projectId);
      return yield* dependencies.repository.renameProject({
        name: yield* parseProjectName(command.name),
        projectId: command.projectId,
      });
    },
  );

  const setProjectArchive = Effect.fn(
    "ProjectManagementService.setProjectArchive",
  )(function*(command: ReadProjectCommand, archivedAt: string | null) {
    yield* authorization.requireProjectManagement(command.principal);
    const project = yield* requireProject(command.principal, command.projectId);
    const alreadyInRequestedState = archivedAt === null
      ? project.archivedAt === null
      : project.archivedAt !== null;
    if (alreadyInRequestedState) return project;
    return yield* dependencies.repository.setProjectArchive({
      archivedAt,
      projectId: command.projectId,
    });
  });

  const archiveProject = Effect.fn("ProjectManagementService.archiveProject")(
    function*(command: ReadProjectCommand) {
      return yield* setProjectArchive(
        command,
        DateTime.formatIso(yield* dependencies.clock.now),
      );
    },
  );

  const unarchiveProject = Effect.fn(
    "ProjectManagementService.unarchiveProject",
  )(function*(command: ReadProjectCommand) {
    return yield* setProjectArchive(command, null);
  });

  return ProjectManagementService.of({
    archiveProject,
    createProject,
    getProject,
    listProjects,
    renameProject,
    resolveActiveProject,
    unarchiveProject,
  });
}

function parseProjectName(
  input: string,
): Effect.Effect<string, InvalidProjectName> {
  return decodeProjectName(input).pipe(
    Effect.mapError(() =>
      new InvalidProjectName({
        message: "Project names must contain between 1 and 120 characters.",
      })
    ),
  );
}
