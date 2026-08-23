/**
 * Artifact Server bridge — the thin Pi-facing entry.
 *
 * Registers this Pi session with an Artifact Server installation, receives
 * annotation bundles as follow-up work through the claim loop in
 * `bridge-core.ts`, and registers the `artifact_comments` tool the agent uses
 * to reply to and resolve each thread. All logic lives in the core; this file
 * only wires it to the live extension API.
 */

import {homedir, hostname} from "node:os";

import {Type} from "typebox";

import {
  type BridgeHandle,
  type BridgeNoticeKind,
  chooseDisplayName,
  type CommentOperations,
  createCommentOperations,
  type EnvironmentConfiguration,
  type FollowUpDelivery,
  type PiPort,
  resolveBridgeCredentials,
  startBridge,
  ThreadLocationCache,
} from "./bridge-core.js";

/**
 * A compaction flag older than this is treated as expired: a cancelled
 * compaction never emits `session_compact`, so the hold must not stick.
 */
const compactionFlagLifetimeMilliseconds = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// The narrow, structurally-typed slice of Pi's extension API this entry uses.
// Typing it locally keeps the package free of a hard dependency on Pi's own
// type package while the real API remains structurally compatible.
// ---------------------------------------------------------------------------

interface PiNotifier {
  notify(message: string, kind?: BridgeNoticeKind): void;
}

interface PiSessionManagerLike {
  getSessionId(): string;
}

interface PiExtensionContextLike {
  cwd: string;
  sessionManager: PiSessionManagerLike;
  ui: PiNotifier;
}

interface PiSessionStartEventLike {
  reason: string;
}

interface PiToolTextContent {
  text: string;
  type: "text";
}

interface ArtifactCommentsDetails {
  operation: string;
  threadIds: readonly string[];
}

interface PiToolResultLike {
  content: PiToolTextContent[];
  details: ArtifactCommentsDetails;
}

interface ArtifactCommentsParams {
  body?: string;
  operation: "get_bundle" | "reply" | "resolve";
  threadId?: string;
  threadIds?: string[];
}

interface PiToolDefinitionLike {
  description: string;
  execute(
    toolCallId: string,
    params: ArtifactCommentsParams,
    signal: AbortSignal | undefined,
  ): Promise<PiToolResultLike>;
  label: string;
  name: string;
  parameters: ReturnType<typeof artifactCommentsParameters>;
}

interface PiExtensionApi {
  on(
    event: "session_start",
    handler: (
      event: PiSessionStartEventLike,
      ctx: PiExtensionContextLike,
    ) => Promise<void>,
  ): void;
  on(event: "session_before_compact", handler: () => void): void;
  on(event: "session_compact", handler: () => void): void;
  on(
    event: "session_shutdown",
    handler: (event?: PiSessionShutdownEventLike) => Promise<void>,
  ): void;
  registerTool(tool: PiToolDefinitionLike): void;
  sendUserMessage(text: string, delivery: FollowUpDelivery): void;
}

function artifactCommentsParameters() {
  return Type.Object({
    body: Type.Optional(Type.String({
      description: "Reply text (reply operation only).",
    })),
    operation: Type.Union([
      Type.Literal("get_bundle"),
      Type.Literal("reply"),
      Type.Literal("resolve"),
    ], {
      description:
        "get_bundle reads threads with their replies; reply posts one reply; " +
        "resolve closes one thread.",
    }),
    threadId: Type.Optional(Type.String({
      description: "Target thread id (reply and resolve operations).",
    })),
    threadIds: Type.Optional(Type.Array(Type.String(), {
      description: "Thread ids to read (get_bundle operation).",
    })),
  });
}

function environmentConfiguration(): EnvironmentConfiguration {
  return {
    agentDisplayName: process.env["ARTIFACT_SERVER_AGENT_NAME"],
    agentToken: process.env["ARTIFACT_SERVER_AGENT_TOKEN"],
    origin: process.env["ARTIFACT_SERVER_ORIGIN"],
  };
}

function textResult(
  operation: string,
  threadIds: readonly string[],
  text: string,
): PiToolResultLike {
  return {
    content: [{text, type: "text"}],
    details: {operation, threadIds},
  };
}

/** The shutdown reasons Pi emits; only a real quit is a departure. */
interface PiSessionShutdownEventLike {
  readonly reason?: string;
}

/** Artifact Server bridge extension factory. */
export default function artifactServerBridge(pi: PiExtensionApi): void {
  let bridge: BridgeHandle | null = null;
  let comments: CommentOperations | null = null;
  let compactionStartedAt: number | null = null;
  const locations = new ThreadLocationCache();

  const stopBridge = async (disconnect: boolean): Promise<void> => {
    const active = bridge;
    bridge = null;
    if (active !== null) await active.stop({disconnect});
  };

  // Compaction is tracked from events because the extension context exposes
  // no probe; the timestamp bounds the flag so a cancelled compaction (which
  // never emits session_compact) cannot hold deliveries forever.
  pi.on("session_before_compact", () => {
    compactionStartedAt = Date.now();
  });
  pi.on("session_compact", () => {
    compactionStartedAt = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    await stopBridge(false);
    const environment = environmentConfiguration();
    const credentials = await resolveBridgeCredentials(environment, homedir());
    comments = credentials === null
      ? null
      : createCommentOperations(credentials, fetch, locations);

    const port: PiPort = {
      isCompacting: () =>
        compactionStartedAt !== null &&
        Date.now() - compactionStartedAt < compactionFlagLifetimeMilliseconds,
      notify: (message, kind) => {
        ctx.ui.notify(message, kind);
      },
      sendUserMessage: (text, delivery) => {
        // Always named follow-up delivery: safe while idle (delivery mode is
        // ignored and a run starts) and queued to the work boundary while
        // streaming. Never "steer", and never omitted.
        pi.sendUserMessage(text, delivery);
      },
    };

    bridge = startBridge({
      agentSessionId: ctx.sessionManager.getSessionId(),
      credentials,
      displayName: chooseDisplayName(environment, ctx.cwd),
      fetchImplementation: fetch,
      hostname: hostname(),
      locations,
      pi: port,
      workingDirectory: ctx.cwd,
    });
  });

  pi.on("session_shutdown", async (event) => {
    await stopBridge(event?.reason === "quit");
  });

  pi.registerTool({
    description:
      "Read, reply to, and resolve Artifact Server comment threads that were " +
      "sent to this agent. Use get_bundle to read threads, reply to record " +
      "what you did on a thread, and resolve to close it when done.",
    async execute(_toolCallId, params) {
      const operations = comments;
      if (operations === null) {
        throw new Error(
          "Artifact Server is not configured; the bridge is dormant.",
        );
      }
      if (params.operation === "get_bundle") {
        const threadIds = params.threadIds ?? [];
        if (threadIds.length === 0) {
          throw new Error("get_bundle requires threadIds.");
        }
        const details = [];
        for (const threadId of threadIds) {
          // eslint-disable-next-line no-await-in-loop
          details.push(await operations.getThread(threadId));
        }
        return textResult(
          "get_bundle",
          threadIds,
          JSON.stringify(details, null, 2),
        );
      }
      const threadId = params.threadId ?? "";
      if (threadId === "") {
        throw new Error(`${params.operation} requires threadId.`);
      }
      if (params.operation === "reply") {
        const body = params.body ?? "";
        if (body.trim() === "") {
          throw new Error("reply requires a non-empty body.");
        }
        await operations.reply(threadId, body);
        return textResult("reply", [threadId], `Replied to ${threadId}.`);
      }
      await operations.resolve(threadId);
      return textResult("resolve", [threadId], `Resolved ${threadId}.`);
    },
    label: "Artifact comments",
    name: "artifact_comments",
    parameters: artifactCommentsParameters(),
  });
}
