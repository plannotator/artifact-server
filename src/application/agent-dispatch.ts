import {Context, DateTime, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  AgentDispatchNotFound,
  AgentNotFound,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  type DispatchStateConflict,
  type IdempotencyConflict,
  InvalidDispatch,
  type InvalidIdempotencyKey,
  InvalidPagination,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import {
  type AgentActivityState,
  type AgentBeaconDetail,
  type AgentBeaconState,
  type AgentCapabilityDeclaration,
  type AgentDispatchCreation,
  type AgentDispatchPage,
  type AgentDispatchRecord,
  type AgentDispatchState,
  agentActivityStates,
  agentBeaconStates,
  type CommentAuthor,
  normalizeAgentCapabilities,
  type PageCursor,
  type RegisteredAgentKind,
  registeredAgentKindPattern,
  type RegisteredAgentPresence,
  type RegisteredAgentRecord,
} from "../core/model.js";
import type {
  CancelAgentDispatch,
  CreateAgentDispatch,
  IdGenerator,
  ListAgentDispatches,
  MarkDispatchDelivered,
  MarkDispatchFailed,
  RecordAgentActivity,
  RegisterAgent,
} from "../core/ports.js";
import {
  agentActivityBeaconTtlMilliseconds,
  agentConnectedWindowMilliseconds,
  maximumAgentConnectionKeyCharacters,
  maximumAgentDisplayNameCharacters,
  maximumAgentWorkingDirectoryCharacters,
  maximumCommentPageSize,
  maximumDispatchBundleSize,
  maximumDispatchFailureReasonCharacters,
  maximumDispatchNoteCharacters,
} from "../core/publishing-limits.js";

/** Outbound failures surfaced by agent-dispatch persistence. */
export type AgentDispatchRepositoryFailure =
  | AgentDispatchNotFound
  | AgentNotFound
  | ArtifactRepositoryFailure
  | DispatchStateConflict
  | IdempotencyConflict
  | InvalidDispatch;

/** Persistence required by the agent registry and the dispatch mailbox. */
export interface AgentDispatchPersistence {
  readonly cancelDispatch: (
    command: CancelAgentDispatch,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchRepositoryFailure>;
  readonly claimNextDispatch: (
    agentId: string,
    now: string,
    bumpHeartbeat: boolean,
  ) => Effect.Effect<AgentDispatchRecord | null, AgentDispatchRepositoryFailure>;
  readonly createDispatch: (
    command: CreateAgentDispatch,
  ) => Effect.Effect<AgentDispatchCreation, AgentDispatchRepositoryFailure>;
  readonly disconnectAgent: (
    installationId: string,
    agentId: string,
  ) => Effect.Effect<void, AgentDispatchRepositoryFailure>;
  readonly findAgent: (
    installationId: string,
    agentId: string,
  ) => Effect.Effect<RegisteredAgentRecord | null, AgentDispatchRepositoryFailure>;
  readonly findDispatch: (
    installationId: string,
    dispatchId: string,
    now: string,
  ) => Effect.Effect<AgentDispatchRecord | null, AgentDispatchRepositoryFailure>;
  readonly listAgents: (
    installationId: string,
    now: string,
  ) => Effect.Effect<
    readonly RegisteredAgentPresence[],
    AgentDispatchRepositoryFailure
  >;
  readonly listDispatches: (
    command: ListAgentDispatches,
  ) => Effect.Effect<AgentDispatchPage, AgentDispatchRepositoryFailure>;
  readonly markDelivered: (
    command: MarkDispatchDelivered,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchRepositoryFailure>;
  readonly markFailed: (
    command: MarkDispatchFailed,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchRepositoryFailure>;
  readonly observeAddressed: (
    dispatchId: string,
    now: string,
  ) => Effect.Effect<AgentDispatchRecord | null, AgentDispatchRepositoryFailure>;
  readonly recordActivity: (
    command: RecordAgentActivity,
  ) => Effect.Effect<void, AgentDispatchRepositoryFailure>;
  readonly registerAgent: (
    command: RegisterAgent,
  ) => Effect.Effect<RegisteredAgentRecord, AgentDispatchRepositoryFailure>;
}

/** Dependencies used to construct agent-dispatch operations. */
export interface AgentDispatchDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly repository: AgentDispatchPersistence;
}

/** One registered agent together with its presence, derived at read time. */
export interface ConnectedRegisteredAgent {
  /** The claimed or delivered dispatch the agent is working, or null. */
  readonly activeDispatchId: string | null;
  /** Derived presence; a fresh thinking/replying beacon reports working. */
  readonly activity: AgentActivityState;
  readonly agent: RegisteredAgentRecord;
  /** Finer beacon detail while fresh and the agent is connected. */
  readonly beacon: AgentBeaconDetail;
  /** True when the agent's last claim poll landed within the live window. */
  readonly connected: boolean;
  /** max(lastSeenAt, latest dispatch transition). */
  readonly lastActivityAt: string;
}

/** Input for one self-naming agent registration upsert. */
export interface RegisterAgentCommand {
  readonly agentSessionId: string | null;
  /** As declared on the wire; normalized before storage, null when absent. */
  readonly capabilities: AgentCapabilityDeclaration | null;
  readonly connectionKey: string;
  readonly displayName: string;
  readonly kind: RegisteredAgentKind;
  readonly principal: Principal;
  readonly workingDirectory: string;
}

/** Input shared by operations addressing one registered agent. */
export interface ReadAgentCommand {
  readonly agentId: string;
  readonly principal: Principal;
}

/** Input for listing the installation's registered agents. */
export interface ListAgentsCommand {
  readonly principal: Principal;
}

/** Input for one best-effort activity beacon from an agent. */
export interface RecordAgentActivityCommand {
  readonly agentId: string;
  /** Accepted for forward compatibility; display metadata, never stored. */
  readonly dispatchId: string | null;
  readonly principal: Principal;
  readonly state: AgentBeaconState;
}

/** Input for sending one bundle of comment threads to one agent. */
export interface CreateDispatchCommand {
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly note: string | null;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly threadIds: readonly string[];
}

/** Input for one single-shot claim of the oldest queued dispatch. */
export interface ClaimDispatchCommand {
  readonly agentId: string;
  /**
   * True on the first attempt of one held poll request — the attempt that is
   * the heartbeat — and false on the bounded re-checks inside the same held
   * request, which write nothing while the mailbox stays empty.
   */
  readonly bumpHeartbeat: boolean;
  readonly principal: Principal;
}

/** Input for reporting one claimed dispatch as delivered. */
export interface ReportDeliveredCommand {
  readonly agentId: string;
  readonly dispatchId: string;
  readonly principal: Principal;
}

/** Input for reporting one dispatch as permanently failed. */
export interface ReportFailedCommand extends ReportDeliveredCommand {
  readonly reason: string;
}

/** Input shared by human-facing operations addressing one dispatch. */
export interface ReadDispatchCommand {
  readonly dispatchId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for listing one project's dispatches, newest first. */
export interface ListDispatchesCommand {
  readonly agentId: string | null;
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly state: AgentDispatchState | null;
}

/** Expected failures produced by agent-dispatch operations. */
export type AgentDispatchFailure =
  | AgentDispatchNotFound
  | AgentNotFound
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | DispatchStateConflict
  | IdempotencyConflict
  | InvalidDispatch
  | InvalidIdempotencyKey
  | InvalidPagination
  | ProjectManagementFailure;

interface AgentDispatchOperations {
  readonly cancelDispatch: (
    command: ReadDispatchCommand,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchFailure>;
  readonly claimDispatch: (
    command: ClaimDispatchCommand,
  ) => Effect.Effect<AgentDispatchRecord | null, AgentDispatchFailure>;
  readonly createDispatch: (
    command: CreateDispatchCommand,
  ) => Effect.Effect<AgentDispatchCreation, AgentDispatchFailure>;
  readonly disconnectAgent: (
    command: ReadAgentCommand,
  ) => Effect.Effect<void, AgentDispatchFailure>;
  readonly getDispatch: (
    command: ReadDispatchCommand,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchFailure>;
  readonly listAgents: (
    command: ListAgentsCommand,
  ) => Effect.Effect<readonly ConnectedRegisteredAgent[], AgentDispatchFailure>;
  readonly listDispatches: (
    command: ListDispatchesCommand,
  ) => Effect.Effect<AgentDispatchPage, AgentDispatchFailure>;
  readonly recordActivity: (
    command: RecordAgentActivityCommand,
  ) => Effect.Effect<void, AgentDispatchFailure>;
  readonly registerAgent: (
    command: RegisterAgentCommand,
  ) => Effect.Effect<RegisteredAgentRecord, AgentDispatchFailure>;
  readonly reportDelivered: (
    command: ReportDeliveredCommand,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchFailure>;
  readonly reportFailed: (
    command: ReportFailedCommand,
  ) => Effect.Effect<AgentDispatchRecord, AgentDispatchFailure>;
}

/** Owns the agent registry and dispatch mailbox for one installation. */
export class AgentDispatchService extends Context.Service<
  AgentDispatchService,
  AgentDispatchOperations
>()("artifact-server/application/AgentDispatchService") {
  /** Construct dispatch operations from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: AgentDispatchDependencies,
  ): Layer.Layer<
    AgentDispatchService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      AgentDispatchService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeAgentDispatchService(dependencies, authorization, projects);
      }),
    );
}

function makeAgentDispatchService(
  dependencies: AgentDispatchDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): AgentDispatchOperations {
  const now = Effect.fn("AgentDispatchService.now")(function*() {
    return DateTime.formatIso(yield* dependencies.clock.now);
  });

  const resolveProjectForRead = Effect.fn(
    "AgentDispatchService.resolveProjectForRead",
  )(function*(principal: Principal, projectId: string | null) {
    return projectId === null
      ? yield* projects.resolveActiveProject({principal, projectId})
      : yield* projects.getProject({principal, projectId});
  });

  const resolveProjectForWrite = Effect.fn(
    "AgentDispatchService.resolveProjectForWrite",
  )(function*(principal: Principal, projectId: string | null) {
    return yield* projects.resolveActiveProject({principal, projectId});
  });

  const requireBoundedText = Effect.fn(
    "AgentDispatchService.requireBoundedText",
  )(function*(
    value: string,
    field: string,
    maximum: number,
  ): Effect.fn.Return<string, InvalidDispatch> {
    const trimmed = value.trim();
    if (trimmed.length >= 1 && trimmed.length <= maximum) return trimmed;
    return yield* new InvalidDispatch({
      message: `An agent ${field} must contain between 1 and ${maximum} characters.`,
    });
  });

  /** The kind is an open slug set; the shape check is the whole contract. */
  const requireAgentKind = Effect.fn("AgentDispatchService.requireAgentKind")(
    function*(kind: string): Effect.fn.Return<
      RegisteredAgentKind,
      InvalidDispatch
    > {
      if (registeredAgentKindPattern.test(kind)) return kind;
      return yield* new InvalidDispatch({
        message: "An agent kind must be a slug of at most 40 characters: a lowercase letter followed by lowercase letters, digits, or hyphens.",
      });
    },
  );

  const requireAgent = Effect.fn("AgentDispatchService.requireAgent")(
    function*(agentId: string): Effect.fn.Return<
      RegisteredAgentRecord,
      AgentDispatchRepositoryFailure
    > {
      const agent = yield* dependencies.repository.findAgent(
        dependencies.installationId,
        agentId,
      );
      if (agent !== null) return agent;
      return yield* new AgentNotFound({
        message: "The registered agent does not exist.",
      });
    },
  );

  /** The claim and report surfaces act only for the registering principal. */
  const requireOwnedAgent = Effect.fn("AgentDispatchService.requireOwnedAgent")(
    function*(agentId: string, principal: Principal): Effect.fn.Return<
      RegisteredAgentRecord,
      AgentDispatchRepositoryFailure | AuthorizationDenied
    > {
      const agent = yield* requireAgent(agentId);
      if (agent.principalId === principal.id) return agent;
      return yield* new AuthorizationDenied({
        message: "Only the registering principal can act as this agent.",
      });
    },
  );

  const requirePageSize = Effect.fn("AgentDispatchService.requirePageSize")(
    function*(limit: number) {
      if (
        Number.isSafeInteger(limit) && limit >= 1 &&
        limit <= maximumCommentPageSize
      ) {
        return limit;
      }
      return yield* new InvalidPagination({
        message:
          `A dispatch page must contain between 1 and ${maximumCommentPageSize} records.`,
      });
    },
  );

  const requireBundle = Effect.fn("AgentDispatchService.requireBundle")(
    function*(threadIds: readonly string[]): Effect.fn.Return<
      readonly string[],
      InvalidDispatch
    > {
      if (
        threadIds.length < 1 || threadIds.length > maximumDispatchBundleSize
      ) {
        return yield* new InvalidDispatch({
          message:
            `A dispatch bundle must reference between 1 and ${maximumDispatchBundleSize} comment threads.`,
        });
      }
      if (new Set(threadIds).size !== threadIds.length) {
        return yield* new InvalidDispatch({
          message: "A dispatch bundle cannot reference one thread twice.",
        });
      }
      return threadIds;
    },
  );

  const requireNote = Effect.fn("AgentDispatchService.requireNote")(
    function*(note: string | null): Effect.fn.Return<
      string | null,
      InvalidDispatch
    > {
      if (note === null) return null;
      const trimmed = note.trim();
      if (trimmed.length === 0) return null;
      if (trimmed.length <= maximumDispatchNoteCharacters) return trimmed;
      return yield* new InvalidDispatch({
        message:
          `A dispatch note must contain at most ${maximumDispatchNoteCharacters} characters.`,
      });
    },
  );

  const requireProjectDispatch = Effect.fn(
    "AgentDispatchService.requireProjectDispatch",
  )(function*(projectId: string, dispatchId: string, readTime: string): Effect.fn.Return<
    AgentDispatchRecord,
    AgentDispatchRepositoryFailure
  > {
    const dispatch = yield* dependencies.repository.findDispatch(
      dependencies.installationId,
      dispatchId,
      readTime,
    );
    if (dispatch !== null && dispatch.projectId === projectId) return dispatch;
    return yield* new AgentDispatchNotFound({
      message: "The dispatch does not exist.",
    });
  });

  const registerAgent = Effect.fn("AgentDispatchService.registerAgent")(
    function*(command: RegisterAgentCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const connectionKey = yield* requireBoundedText(
        command.connectionKey,
        "connection key",
        maximumAgentConnectionKeyCharacters,
      );
      const displayName = yield* requireBoundedText(
        command.displayName,
        "display name",
        maximumAgentDisplayNameCharacters,
      );
      const workingDirectory = yield* requireBoundedText(
        command.workingDirectory,
        "working directory",
        maximumAgentWorkingDirectoryCharacters,
      );
      return yield* dependencies.repository.registerAgent({
        agentSessionId: command.agentSessionId,
        capabilities: normalizeAgentCapabilities(command.capabilities),
        connectionKey,
        displayName,
        id: dependencies.ids.registeredAgentId(),
        installationId: dependencies.installationId,
        kind: yield* requireAgentKind(command.kind),
        principalId: command.principal.id,
        registeredAt: yield* now(),
        workingDirectory,
      });
    },
  );

  const disconnectAgent = Effect.fn("AgentDispatchService.disconnectAgent")(
    function*(command: ReadAgentCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const agent = yield* dependencies.repository.findAgent(
        dependencies.installationId,
        command.agentId,
      );
      // A missing row is a success: disconnect is an idempotent courtesy.
      if (agent === null) return;
      if (agent.principalId !== command.principal.id) {
        yield* Effect.fail(new AuthorizationDenied({
          message: "Only the registering principal can disconnect this agent.",
        }));
        return;
      }
      yield* dependencies.repository.disconnectAgent(
        dependencies.installationId,
        command.agentId,
      );
    },
  );

  const listAgents = Effect.fn("AgentDispatchService.listAgents")(
    function*(command: ListAgentsCommand) {
      yield* authorization.requireArtifactRead(command.principal);
      const readTime = yield* now();
      const agents = yield* dependencies.repository.listAgents(
        dependencies.installationId,
        readTime,
      );
      const readMilliseconds = Date.parse(readTime);
      return agents.map((presence) =>
        connectedAgent(presence, readMilliseconds)
      );
    },
  );

  const recordActivity = Effect.fn("AgentDispatchService.recordActivity")(
    function*(command: RecordAgentActivityCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const agent = yield* dependencies.repository.findAgent(
        dependencies.installationId,
        command.agentId,
      );
      // Another principal's agent is indistinguishable from a missing one:
      // the beacon route discloses nothing about foreign registrations.
      if (agent === null || agent.principalId !== command.principal.id) {
        yield* Effect.fail(new AgentNotFound({
          message: "The registered agent does not exist.",
        }));
        return;
      }
      // Stored unconditionally — a stale-heartbeat beacon is accepted too —
      // and the read side applies the TTL and liveness gates.
      yield* dependencies.repository.recordActivity({
        agentId: agent.id,
        installationId: dependencies.installationId,
        observedAt: yield* now(),
        state: command.state,
      });
    },
  );

  const createDispatch = Effect.fn("AgentDispatchService.createDispatch")(
    function*(command: CreateDispatchCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireDispatchSend(command.principal);
      const threadIds = yield* requireBundle(command.threadIds);
      const note = yield* requireNote(command.note);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const agent = yield* requireAgent(command.agentId);
      return yield* dependencies.repository.createDispatch({
        agentDisplayName: agent.displayName,
        agentId: agent.id,
        createdAt: yield* now(),
        id: dependencies.ids.agentDispatchId(),
        idempotencyKey,
        installationId: dependencies.installationId,
        note,
        projectId: project.id,
        sender: dispatchSender(command.principal),
        threadIds,
      });
    },
  );

  const claimDispatch = Effect.fn("AgentDispatchService.claimDispatch")(
    function*(command: ClaimDispatchCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const agent = yield* requireOwnedAgent(command.agentId, command.principal);
      return yield* dependencies.repository.claimNextDispatch(
        agent.id,
        yield* now(),
        command.bumpHeartbeat,
      );
    },
  );

  const reportDelivered = Effect.fn("AgentDispatchService.reportDelivered")(
    function*(command: ReportDeliveredCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const agent = yield* requireOwnedAgent(command.agentId, command.principal);
      return yield* dependencies.repository.markDelivered({
        agentId: agent.id,
        deliveredAt: yield* now(),
        dispatchId: command.dispatchId,
        installationId: dependencies.installationId,
      });
    },
  );

  const reportFailed = Effect.fn("AgentDispatchService.reportFailed")(
    function*(command: ReportFailedCommand) {
      yield* authorization.requireAgentConnection(command.principal);
      const agent = yield* requireOwnedAgent(command.agentId, command.principal);
      const reason = yield* requireBoundedText(
        command.reason,
        "failure reason",
        maximumDispatchFailureReasonCharacters,
      );
      return yield* dependencies.repository.markFailed({
        agentId: agent.id,
        dispatchId: command.dispatchId,
        failedAt: yield* now(),
        installationId: dependencies.installationId,
        reason,
      });
    },
  );

  const cancelDispatch = Effect.fn("AgentDispatchService.cancelDispatch")(
    function*(command: ReadDispatchCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireDispatchSend(command.principal);
      const canceledAt = yield* now();
      const dispatch = yield* requireProjectDispatch(
        project.id,
        command.dispatchId,
        canceledAt,
      );
      return yield* dependencies.repository.cancelDispatch({
        canceledAt,
        dispatchId: dispatch.id,
        installationId: dependencies.installationId,
        projectId: project.id,
      });
    },
  );

  const listDispatches = Effect.fn("AgentDispatchService.listDispatches")(
    function*(command: ListDispatchesCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireArtifactRead(command.principal);
      const limit = yield* requirePageSize(command.limit);
      return yield* dependencies.repository.listDispatches({
        agentId: command.agentId,
        cursor: command.cursor,
        installationId: dependencies.installationId,
        limit,
        now: yield* now(),
        projectId: project.id,
        state: command.state,
      });
    },
  );

  const getDispatch = Effect.fn("AgentDispatchService.getDispatch")(
    function*(command: ReadDispatchCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireArtifactRead(command.principal);
      return yield* requireProjectDispatch(
        project.id,
        command.dispatchId,
        yield* now(),
      );
    },
  );

  return AgentDispatchService.of({
    cancelDispatch,
    claimDispatch,
    createDispatch,
    disconnectAgent,
    getDispatch,
    listAgents,
    listDispatches,
    recordActivity,
    registerAgent,
    reportDelivered,
    reportFailed,
  });
}

/**
 * Presence per spec §3.2, derived at read time. Layer 1: working = the agent
 * holds a claimed/delivered dispatch with unresolved threads. Layer 2: a
 * fresh thinking/replying beacon from a connected agent also reports working
 * and carries the finer state; a stale beacon, or one from an agent whose
 * heartbeat lapsed, decays to the derived state. A disconnected agent is
 * disconnected regardless of the dispatches it still holds.
 */
function connectedAgent(
  presence: RegisteredAgentPresence,
  readMilliseconds: number,
): ConnectedRegisteredAgent {
  const {activeDispatchId, agent, latestDispatchTransitionAt} = presence;
  const connected = Date.parse(agent.lastSeenAt) >=
    readMilliseconds - agentConnectedWindowMilliseconds;
  const beaconFresh = agent.activityAt !== null &&
    Date.parse(agent.activityAt) >=
      readMilliseconds - agentActivityBeaconTtlMilliseconds;
  const beacon = connected && beaconFresh &&
      agent.activityState !== null &&
      agent.activityState !== agentBeaconStates.idle
    ? agent.activityState
    : null;
  const activity = !connected
    ? agentActivityStates.disconnected
    : beacon !== null || activeDispatchId !== null
    ? agentActivityStates.working
    : agentActivityStates.idle;
  const lastActivityAt = latestDispatchTransitionAt !== null &&
      Date.parse(latestDispatchTransitionAt) > Date.parse(agent.lastSeenAt)
    ? latestDispatchTransitionAt
    : agent.lastSeenAt;
  return {activeDispatchId, activity, agent, beacon, connected, lastActivityAt};
}

function dispatchSender(principal: Principal): CommentAuthor {
  return {
    authorizedByPrincipalId: principal.authorizedByPrincipalId,
    displayName: principal.displayName,
    principalId: principal.id,
    principalKind: principal.kind,
  };
}
