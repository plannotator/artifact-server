/**
 * Artifact Server bridge — the thin OpenCode-facing entry.
 *
 * Registers the OpenCode instance for this project directory with an
 * Artifact Server installation, receives annotation bundles as follow-up
 * prompts through the claim loop in `@plannotator/agent-bridge`, and
 * registers the `artifact_comments` tool the agent uses to reply to and
 * resolve each thread. All logic lives in the shared core; this file only
 * wires it to OpenCode's plugin API (V1 plugin surface, pinned in the
 * README): `client.session.promptAsync` is the follow-up injection seam,
 * `client.tui.showToast` is the notice surface, and hooks track the target
 * session and its compaction windows.
 */

import {homedir, hostname} from "node:os";

import {z} from "zod";

import {
  ActivityBeacon,
  type BridgeHandle,
  type BridgeNoticeKind,
  chooseDisplayName,
  type CommentOperations,
  createCommentOperations,
  type EnvironmentConfiguration,
  type HostPort,
  resolveBridgeCredentials,
  startBridge,
  ThreadLocationCache,
} from "@plannotator/agent-bridge";

/**
 * A compaction flag older than this is treated as expired: an abandoned
 * compaction whose `session.compacted` event never arrives must not hold
 * deliveries forever.
 */
const compactionFlagLifetimeMilliseconds = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// The narrow, structurally-typed slice of OpenCode's plugin API this entry
// uses. Typing it locally keeps the package free of a hard dependency on
// `@opencode-ai/plugin` and `@opencode-ai/sdk` while the real API remains
// structurally compatible (verified against the pinned version in README).
// ---------------------------------------------------------------------------

/** One SDK call answer: the OpenCode client reports failures as a value. */
interface OpencodeCallAnswer {
  readonly error?: {readonly message?: string};
}

interface OpencodePromptOptions {
  readonly body: {
    readonly parts: readonly {readonly text: string; readonly type: "text"}[];
  };
  readonly path: {readonly id: string};
}

interface OpencodeSessionApi {
  promptAsync(options: OpencodePromptOptions): Promise<OpencodeCallAnswer>;
}

interface OpencodeToastOptions {
  readonly body: {
    readonly message: string;
    readonly variant: BridgeNoticeKind;
  };
}

interface OpencodeTuiApi {
  showToast(options: OpencodeToastOptions): Promise<boolean>;
}

/** The in-process SDK client OpenCode hands every plugin. */
export interface OpencodeClient {
  session: OpencodeSessionApi;
  /** Absent or inert on headless hosts; every use is best-effort. */
  tui?: OpencodeTuiApi;
}

/** The V1 plugin context slice this bridge reads. */
export interface OpencodePluginInput {
  client: OpencodeClient;
  directory: string;
}

/**
 * A degraded plugin context from an unexpected OpenCode build. The boundary
 * guard turns it into a dormant bridge instead of a crash inside the host.
 */
export interface OpencodePartialPluginContext {
  readonly client?: undefined;
  readonly directory?: string;
}

/** One bus event as the `event` hook receives it; parsed with schemas. */
export interface OpencodeEvent {
  readonly properties?: object;
  readonly type: string;
}

interface ArtifactCommentsArguments {
  readonly body?: string;
  readonly operation: "get_bundle" | "reply" | "resolve";
  readonly threadId?: string;
  readonly threadIds?: readonly string[];
}

/** The `Hooks` slice this plugin returns to OpenCode. */
export interface OpencodeBridgeHooks {
  "chat.message"(input: {sessionID: string}): Promise<void>;
  dispose(): Promise<void>;
  event(input: {event: OpencodeEvent}): Promise<void>;
  "experimental.session.compacting"(input: {sessionID: string}): Promise<void>;
  tool: {
    artifact_comments: {
      args: ReturnType<typeof artifactCommentsToolArguments>;
      description: string;
      execute(args: ArtifactCommentsArguments): Promise<string>;
    };
  };
}

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

/**
 * The plugin context surface the bridge needs, checked at the boundary so a
 * host that lacks it leaves the bridge dormant instead of crashing OpenCode.
 * Only presence is checked; calls keep going through the original `input`
 * object so SDK method bindings stay intact.
 */
const pluginSurfaceSchema = z.object({
  client: z.object({
    session: z.object({promptAsync: z.function()}).loose(),
  }).loose(),
  directory: z.string().min(1),
}).loose();

function isCompletePluginInput(
  input: OpencodePartialPluginContext | OpencodePluginInput,
): input is OpencodePluginInput {
  return pluginSurfaceSchema.safeParse(input).success;
}

const sessionLifecycleEventSchema = z.object({
  properties: z.object({
    info: z.object({
      id: z.string(),
      parentID: z.string().optional(),
    }).loose(),
  }).loose(),
  type: z.enum(["session.created", "session.deleted", "session.updated"]),
}).loose();

const sessionCompactedEventSchema = z.object({
  properties: z.object({sessionID: z.string()}).loose(),
  type: z.literal("session.compacted"),
}).loose();

function artifactCommentsToolArguments() {
  return {
    body: z.string().optional()
      .describe("Reply text (reply operation only)."),
    operation: z.enum(["get_bundle", "reply", "resolve"]).describe(
      "get_bundle reads threads with their replies; reply posts one reply; " +
        "resolve closes one thread.",
    ),
    threadId: z.string().optional()
      .describe("Target thread id (reply and resolve operations)."),
    threadIds: z.array(z.string()).optional()
      .describe("Thread ids to read (get_bundle operation)."),
  };
}

function environmentConfiguration(): EnvironmentConfiguration {
  return {
    agentDisplayName: process.env["ARTIFACT_SERVER_AGENT_NAME"],
    agentToken: process.env["ARTIFACT_SERVER_AGENT_TOKEN"],
    origin: process.env["ARTIFACT_SERVER_ORIGIN"],
  };
}

const noopHooks: OpencodeBridgeHooks["event"] = () => Promise.resolve();

/** The hooks returned when the host context lacks the expected surface. */
function dormantHooks(): OpencodeBridgeHooks {
  return {
    "chat.message": () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    event: noopHooks,
    "experimental.session.compacting": () => Promise.resolve(),
    tool: {
      artifact_comments: {
        args: artifactCommentsToolArguments(),
        description: artifactCommentsDescription,
        execute: () =>
          Promise.reject(
            new Error(
              "Artifact Server is not configured; the bridge is dormant.",
            ),
          ),
      },
    },
  };
}

const artifactCommentsDescription =
  "Read, reply to, and resolve Artifact Server comment threads that were " +
  "sent to this agent. Use get_bundle to read threads, reply to record " +
  "what you did on a thread, and resolve to close it when done.";

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Artifact Server bridge plugin for OpenCode. Loaded once per OpenCode
 * instance; never throws into the host — a context without the expected
 * surface or without credentials produces a dormant bridge.
 */
export async function ArtifactServerBridge(
  input: OpencodePartialPluginContext | OpencodePluginInput,
): Promise<OpencodeBridgeHooks> {
  if (!isCompletePluginInput(input)) return dormantHooks();

  // The most recently active top-level session: bundles inject here.
  // Subagent (child) sessions never become the target — a bundle delivered
  // into a task session would vanish with it.
  let targetSessionId: string | null = null;
  const childSessionIds = new Set<string>();
  let compaction: {sessionId: string; startedAt: number} | null = null;

  const environment = environmentConfiguration();
  const credentials = await resolveBridgeCredentials(environment, homedir());
  const locations = new ThreadLocationCache();
  // One beacon per instance: replies and resolves through the tool count
  // against the bundles this bridge delivered.
  const beacon = new ActivityBeacon();
  const comments: CommentOperations | null = credentials === null
    ? null
    : createCommentOperations(credentials, fetch, locations, beacon);

  const notify = (message: string, kind: BridgeNoticeKind): void => {
    try {
      // Best-effort: a headless host has no TUI and simply drops notices.
      void input.client.tui?.showToast({body: {message, variant: kind}})
        .catch(() => undefined);
    } catch {
      // A notice may be lost; the bridge must never raise into the host.
    }
  };

  // `POST /session/:id/prompt_async` answers 204 once the prompt is
  // accepted; the port's injection contract is synchronous, so a failure
  // afterward can only be surfaced, not retried.
  const injectFollowUp = async (
    sessionId: string,
    text: string,
  ): Promise<void> => {
    let failed = false;
    try {
      const answer = await input.client.session.promptAsync({
        body: {parts: [{text, type: "text"}]},
        path: {id: sessionId},
      });
      failed = answer.error !== undefined;
    } catch {
      failed = true;
    }
    if (failed) {
      notify(
        "Artifact Server: delivering the annotation bundle to the " +
          "OpenCode session failed.",
        "warning",
      );
    }
  };

  const port: HostPort = {
    // OpenCode queues prompts server-side (`prompt_async` appends a user
    // message that the running loop picks up at its next boundary), so the
    // only pre-delivery hold this port needs is: no target session yet, or
    // the target is inside a bounded compaction window.
    isCompacting: () =>
      targetSessionId === null ||
      (compaction !== null &&
        compaction.sessionId === targetSessionId &&
        Date.now() - compaction.startedAt < compactionFlagLifetimeMilliseconds),
    notify,
    sendUserMessage: (text) => {
      const sessionId = targetSessionId;
      if (sessionId === null) {
        // isCompacting() held delivery while no session was known; losing
        // the session between that check and this call means the handle is
        // gone. Throwing ends the claim loop without reporting `delivered`,
        // so the lease requeues the bundle instead of dropping it.
        throw new Error("No OpenCode session is available for delivery.");
      }
      void injectFollowUp(sessionId, text);
    },
  };

  const bridge: BridgeHandle = startBridge({
    agentSessionId: null,
    beacon,
    credentials,
    displayName: chooseDisplayName(environment, input.directory),
    fetchImplementation: fetch,
    host: port,
    hostname: hostname(),
    kind: "opencode",
    locations,
    workingDirectory: input.directory,
  });

  return {
    "chat.message": (chat) => {
      if (!childSessionIds.has(chat.sessionID)) {
        targetSessionId = chat.sessionID;
      }
      return Promise.resolve();
    },
    dispose: () => bridge.stop({disconnect: true}),
    event: (received) => {
      const lifecycle = sessionLifecycleEventSchema.safeParse(received.event);
      if (lifecycle.success) {
        const {id, parentID} = lifecycle.data.properties.info;
        if (lifecycle.data.type === "session.deleted") {
          childSessionIds.delete(id);
          if (targetSessionId === id) targetSessionId = null;
        } else if (parentID !== undefined) {
          childSessionIds.add(id);
        } else if (targetSessionId === null) {
          // A top-level session appearing before any chat activity is the
          // best available target; the next chat message refines it.
          targetSessionId = id;
        }
        return Promise.resolve();
      }
      const compacted = sessionCompactedEventSchema.safeParse(received.event);
      if (
        compacted.success &&
        compaction?.sessionId === compacted.data.properties.sessionID
      ) {
        compaction = null;
      }
      return Promise.resolve();
    },
    "experimental.session.compacting": (compacting) => {
      compaction = {sessionId: compacting.sessionID, startedAt: Date.now()};
      return Promise.resolve();
    },
    tool: {
      artifact_comments: {
        args: artifactCommentsToolArguments(),
        description: artifactCommentsDescription,
        async execute(args) {
          if (comments === null) {
            throw new Error(
              "Artifact Server is not configured; the bridge is dormant.",
            );
          }
          if (args.operation === "get_bundle") {
            const threadIds = args.threadIds ?? [];
            if (threadIds.length === 0) {
              throw new Error("get_bundle requires threadIds.");
            }
            const details = [];
            for (const threadId of threadIds) {
              // eslint-disable-next-line no-await-in-loop
              details.push(await comments.getThread(threadId));
            }
            return JSON.stringify(details, null, 2);
          }
          const threadId = args.threadId ?? "";
          if (threadId === "") {
            throw new Error(`${args.operation} requires threadId.`);
          }
          if (args.operation === "reply") {
            const body = args.body ?? "";
            if (body.trim() === "") {
              throw new Error("reply requires a non-empty body.");
            }
            await comments.reply(threadId, body);
            return `Replied to ${threadId}.`;
          }
          await comments.resolve(threadId);
          return `Resolved ${threadId}.`;
        },
      },
    },
  };
}

export default ArtifactServerBridge;
