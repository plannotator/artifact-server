import {useEffect, useState} from "react";
import {z} from "zod";

import {
  api,
  ApiError,
  type AgentPresence,
  type CommentReply,
  type CommentThread,
} from "@/api/client";
import {echoCounts, type EchoCounts} from "./webmcp-counts.ts";

/**
 * The WebMCP adapter: the one file that knows the `document.modelContext`
 * API shape (webmachinelearning/webmcp draft as of commit bd99438,
 * August 2026 — `registerTool(tool, {signal})`, unregistration by aborting
 * the signal, `execute(input)` returning a JSON-serializable value the user
 * agent stringifies). Every call is guarded: a browser without the API, or
 * with a changed one, degrades silently — no console noise, no UI change.
 *
 * Seven tools over the existing api client (the same code paths the UI
 * uses, so authorization and validation are identical), following the
 * hop-minimal rule: `get_view` is one situational call, every mutation
 * echoes the updated thread and counts, and `open` returns the new view.
 */

// ---------------------------------------------------------------------------
// The structurally-typed slice of the WebMCP draft this adapter uses.
// ---------------------------------------------------------------------------

/** JSON as the user agent hands it to a tool and serializes it back. */
type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};
type ToolInput = {readonly [key: string]: JsonValue};

interface ModelContextToolLike {
  readonly annotations?: {readonly readOnlyHint?: boolean};
  readonly description: string;
  readonly execute: (input: ToolInput) => Promise<JsonValue>;
  readonly inputSchema?: JsonValue;
  readonly name: string;
  readonly title?: string;
}

interface ModelContextLike {
  registerTool(
    tool: ModelContextToolLike,
    options?: {readonly signal?: AbortSignal},
  ): Promise<undefined>;
}

declare global {
  interface Document {
    /** Present only in WebMCP-capable browsers; parsed before use. */
    readonly modelContext?: unknown;
  }
}

const modelContextSchema = z.object({
  registerTool: z.custom<ModelContextLike["registerTool"]>(
    // The browser API boundary itself: nothing upstream can parse this.
    // eslint-disable-next-line anti-slop/no-runtime-typeof
    (value) => typeof value === "function",
  ),
}).loose();

function readModelContext(): ModelContextLike | null {
  try {
    const parsed = modelContextSchema.safeParse(document.modelContext);
    return parsed.success ? parsed.data : null;
  } catch {
    // A hostile or partial implementation is treated as absent.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The per-user toggle (default on), a UI preference like the theme.
// ---------------------------------------------------------------------------

const storageKey = "artifact-review-webmcp";
const changeEvent = "artifact-webmcp-changed";

/** Whether the signed-in user has browser agent tools enabled (default on). */
export function webmcpEnabled(): boolean {
  try {
    return window.localStorage.getItem(storageKey) !== "off";
  } catch {
    return false;
  }
}

function setWebmcpEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey, enabled ? "on" : "off");
  } catch {
    // Preference storage is best-effort, exactly like the theme.
  }
  window.dispatchEvent(new Event(changeEvent));
}

// ---------------------------------------------------------------------------
// What the review application hands the adapter each render.
// ---------------------------------------------------------------------------

/** The live review state the tools read; reassigned every render via a ref. */
export interface WebmcpBindings {
  readonly getSnapshot: () => WebmcpSnapshot;
  readonly openArtifact: (artifactId: string, versionId: string | null) => void;
  readonly reloadComments: () => Promise<void>;
}

export interface WebmcpSnapshot {
  readonly artifact: {
    readonly currentVersionId: string;
    readonly id: string;
    readonly name: string;
  } | null;
  readonly loading: boolean;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly replies: ReadonlyMap<string, readonly CommentReply[]>;
  readonly threads: readonly CommentThread[];
  readonly version: {readonly createdAt: string; readonly id: string} | null;
}

interface BindingsRef {
  readonly current: WebmcpBindings;
}

// ---------------------------------------------------------------------------
// Result shaping: bounded, structured, and read-back free.
// ---------------------------------------------------------------------------

const defaultThreadLimit = 20;
const maximumThreadLimit = 100;
const activeDispatchStates = new Set(["claimed", "delivered", "queued"]);

type ToolThread = {
  readonly author: string;
  readonly body: string;
  readonly id: string;
  readonly path: string | null;
  readonly replies: readonly {
    readonly author: string;
    readonly body: string;
    readonly id: string;
    readonly updatedAt: string;
  }[];
  readonly state: "open" | "resolved";
  readonly updatedAt: string;
  readonly versionId: string;
};

function toolThread(
  thread: CommentThread,
  replies: readonly CommentReply[],
): ToolThread {
  return {
    author: thread.author.displayName,
    body: thread.body,
    id: thread.id,
    path: thread.path,
    replies: replies.map((reply) => ({
      author: reply.author.displayName,
      body: reply.body,
      id: reply.id,
      updatedAt: reply.updatedAt,
    })),
    state: thread.state,
    updatedAt: thread.updatedAt,
    versionId: thread.versionId,
  };
}

function toolAgent(agent: AgentPresence) {
  return {
    activity: agent.activity ?? (agent.connected ? "idle" : "disconnected"),
    beacon: agent.beacon ?? null,
    connected: agent.connected,
    evidence: agent.capabilities?.evidence ?? "native",
    kind: agent.kind,
    name: agent.displayName,
  };
}

async function readAgents(): Promise<readonly ReturnType<typeof toolAgent>[]> {
  try {
    return (await api.agentPresence()).map(toolAgent);
  } catch {
    return [];
  }
}

async function readActiveDispatches(projectId: string) {
  if (projectId === "") return [];
  try {
    const page = await api.agentDispatches(projectId, {
      agentId: null,
      cursor: null,
      limit: 50,
      state: null,
    });
    return page.items
      .filter((dispatch) => activeDispatchStates.has(dispatch.state))
      .map((dispatch) => ({
        agent: dispatch.agentDisplayName,
        id: dispatch.id,
        note: dispatch.note,
        state: dispatch.state,
        threadCount: dispatch.threadIds.length,
      }));
  } catch {
    return [];
  }
}

function settledSnapshot(ref: BindingsRef): Promise<WebmcpSnapshot> {
  return waitFor(ref, (snapshot) => !snapshot.loading);
}

function waitFor(
  ref: BindingsRef,
  ready: (snapshot: WebmcpSnapshot) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<WebmcpSnapshot> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const probe = (): void => {
      const snapshot = ref.current.getSnapshot();
      if (ready(snapshot)) {
        resolve(snapshot);
        return;
      }
      if (Date.now() - startedAt > timeoutMilliseconds) {
        reject(new Error("The review view did not finish loading."));
        return;
      }
      setTimeout(probe, 100);
    };
    probe();
  });
}

async function assembleView(
  ref: BindingsRef,
  input: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
    readonly state?: "open" | "resolved" | undefined;
  },
) {
  const snapshot = await settledSnapshot(ref);
  const stateFilter = input.state ?? null;
  const limit = input.limit !== undefined
    && Number.isInteger(input.limit)
    && input.limit > 0
    ? Math.min(input.limit, maximumThreadLimit)
    : defaultThreadLimit;
  const offset = input.cursor !== undefined && /^\d+$/u.test(input.cursor)
    ? Number(input.cursor)
    : 0;
  const openFirst = snapshot.threads.toSorted((left, right) =>
    left.state === right.state ? 0 : left.state === "open" ? -1 : 1
  );
  const filtered = stateFilter === null
    ? openFirst
    : openFirst.filter((thread) => thread.state === stateFilter);
  const pageItems = filtered.slice(offset, offset + limit);
  const [agents, activeDispatches] = await Promise.all([
    readAgents(),
    readActiveDispatches(snapshot.projectId),
  ]);
  return {
    activeDispatches,
    agents,
    artifact: snapshot.artifact,
    counts: viewCounts(snapshot),
    project: snapshot.projectId === ""
      ? null
      : {id: snapshot.projectId, name: snapshot.projectName},
    threads: {
      items: pageItems.map((thread) =>
        toolThread(thread, snapshot.replies.get(thread.id) ?? [])
      ),
      nextCursor: offset + limit < filtered.length
        ? String(offset + limit)
        : null,
    },
    version: snapshot.version,
  };
}

function viewCounts(snapshot: WebmcpSnapshot) {
  let open = 0;
  for (const thread of snapshot.threads) {
    if (thread.state === "open") open += 1;
  }
  return {open, resolved: snapshot.threads.length - open};
}

async function mutationEcho(
  ref: BindingsRef,
  threadId: string,
): Promise<{counts: EchoCounts; thread: ToolThread}> {
  const before = ref.current.getSnapshot();
  const view = openView(before);
  const details = await api.comment(view.projectId, view.artifactId, threadId);
  // Counts are derived purely from the view's threads with the fresh thread
  // substituted in, so they are post-mutation regardless of commit timing.
  const counts = echoCounts(before.threads, details.thread);
  await ref.current.reloadComments();
  // The commit wait only guarantees the UI has caught up before the agent
  // reads the echo; it can never change the counts above.
  try {
    await waitFor(
      ref,
      (candidate) => !candidate.loading && candidate.threads.some((thread) =>
        thread.id === threadId
        && thread.state === details.thread.state
        && thread.replyCount === details.thread.replyCount
      ),
      5_000,
    );
  } catch {
    // A slow commit delays the UI, not the correctness of the echo.
  }
  return {counts, thread: toolThread(details.thread, details.replies)};
}

function describeFailure(operation: string, caught: Error): Error {
  return caught instanceof ApiError
    ? new Error(`${operation} was refused (${caught.code}): ${caught.message}`)
    : caught;
}

function openView(snapshot: WebmcpSnapshot) {
  if (snapshot.projectId === "" || snapshot.artifact === null || snapshot.version === null) {
    throw new Error(
      "No artifact is open in the review view. Call artifact_server_open first.",
    );
  }
  return {
    artifactId: snapshot.artifact.id,
    projectId: snapshot.projectId,
    versionId: snapshot.version.id,
  };
}

// ---------------------------------------------------------------------------
// The seven tools.
// ---------------------------------------------------------------------------

const provenance = "Artifact Server review tool.";

function reviewTools(ref: BindingsRef): readonly ModelContextToolLike[] {
  return [
    {
      annotations: {readOnlyHint: true},
      description:
        `${provenance} The one situational call: the open project, artifact, `
        + "and version, comment threads with replies (open first, bounded), "
        + "connected agents, and review work already sent to agents.",
      execute: async (input) => assembleView(ref, parseInput(viewInputSchema, input)),
      inputSchema: {
        properties: {
          cursor: {description: "Continue a previous thread page.", type: "string"},
          limit: {description: "Threads per page, default 20.", type: "number"},
          state: {enum: ["open", "resolved"], type: "string"},
        },
        type: "object",
      },
      name: "artifact_server_get_view",
      title: "Get review view",
    },
    {
      annotations: {readOnlyHint: true},
      description:
        `${provenance} List the current project's artifacts with their `
        + "current version ids, for choosing what to open.",
      execute: async () => {
        const snapshot = await settledSnapshot(ref);
        if (snapshot.projectId === "") throw new Error("No project is open.");
        try {
          const page = await api.artifacts(snapshot.projectId, null, [], "");
          return {
            artifacts: page.artifacts.map(({artifact, versionCount}) => ({
              currentVersionId: artifact.currentVersionId,
              id: artifact.id,
              name: artifact.name,
              tags: artifact.tags,
              versionCount,
            })),
            nextCursor: page.nextCursor,
          };
        } catch (caught) {
          throw describeFailure("Listing artifacts", caught instanceof Error ? caught : new Error("The tool call failed."));
        }
      },
      name: "artifact_server_list_artifacts",
      title: "List artifacts",
    },
    {
      description:
        `${provenance} Create a new comment thread on the version open in `
        + "the review view.",
      execute: async (input) => {
        const {body, path} = parseInput(commentInputSchema, input);
        const view = openView(await settledSnapshot(ref));
        try {
          const created = await api.createComment(
            view.projectId,
            view.artifactId,
            view.versionId,
            {
              anchor: null,
              body,
              path: path === undefined || path === "" ? null : path,
            },
            crypto.randomUUID(),
          );
          if (created.thread.versionId !== view.versionId) {
            ref.current.openArtifact(view.artifactId, created.thread.versionId);
            await settledSnapshot(ref);
          }
          return mutationEcho(ref, created.thread.id);
        } catch (caught) {
          throw describeFailure("Commenting", caught instanceof Error ? caught : new Error("The tool call failed."));
        }
      },
      inputSchema: {
        properties: {
          body: {description: "The comment text.", type: "string"},
          path: {description: "Optional file path inside the version.", type: "string"},
        },
        required: ["body"],
        type: "object",
      },
      name: "artifact_server_comment",
      title: "Comment",
    },
    {
      description: `${provenance} Reply to an open comment thread.`,
      execute: async (input) => {
        const {body, threadId} = parseInput(replyInputSchema, input);
        const view = openView(await settledSnapshot(ref));
        try {
          await api.createCommentReply(
            view.projectId,
            view.artifactId,
            threadId,
            body,
            crypto.randomUUID(),
          );
          return mutationEcho(ref, threadId);
        } catch (caught) {
          throw describeFailure("Replying", caught instanceof Error ? caught : new Error("The tool call failed."));
        }
      },
      inputSchema: {
        properties: {
          body: {description: "The reply text.", type: "string"},
          threadId: {description: "The thread to reply to.", type: "string"},
        },
        required: ["threadId", "body"],
        type: "object",
      },
      name: "artifact_server_reply",
      title: "Reply",
    },
    stateTool(ref, "resolve", "resolved"),
    stateTool(ref, "reopen", "open"),
    {
      description:
        `${provenance} Open an artifact (and optionally a version) in the `
        + "review view, and return the new view.",
      execute: async (input) => {
        const {artifactId, versionId} = parseInput(openInputSchema, input);
        const target = versionId === undefined || versionId === "" ? null : versionId;
        ref.current.openArtifact(artifactId, target);
        await waitFor(ref, (snapshot) =>
          !snapshot.loading
          && snapshot.artifact?.id === artifactId
          && (target === null || snapshot.version?.id === target));
        return assembleView(ref, {});
      },
      inputSchema: {
        properties: {
          artifactId: {description: "The artifact to open.", type: "string"},
          versionId: {description: "Optional version to open.", type: "string"},
        },
        required: ["artifactId"],
        type: "object",
      },
      name: "artifact_server_open",
      title: "Open artifact",
    },
  ];
}

function stateTool(
  ref: BindingsRef,
  operation: "reopen" | "resolve",
  target: "open" | "resolved",
): ModelContextToolLike {
  return {
    description: operation === "resolve"
      ? `${provenance} Resolve an open comment thread.`
      : `${provenance} Reopen a resolved comment thread.`,
    execute: async (input) => {
      const {threadId} = parseInput(threadInputSchema, input);
      const view = openView(await settledSnapshot(ref));
      try {
        const current = await api.comment(view.projectId, view.artifactId, threadId);
        if (current.thread.state !== target) {
          await api.updateComment(view.projectId, view.artifactId, threadId, {
            state: target,
          });
        }
        return mutationEcho(ref, threadId);
      } catch (caught) {
        throw describeFailure(operation === "resolve" ? "Resolving" : "Reopening", caught instanceof Error ? caught : new Error("The tool call failed."));
      }
    },
    inputSchema: {
      properties: {
        threadId: {description: "The target thread.", type: "string"},
      },
      required: ["threadId"],
      type: "object",
    },
    name: `artifact_server_${operation}`,
    title: operation === "resolve" ? "Resolve thread" : "Reopen thread",
  };
}

const viewInputSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().optional(),
  state: z.enum(["open", "resolved"]).optional(),
}).loose();
const commentInputSchema = z.object({
  body: z.string().trim().min(1, "comment requires a non-empty body."),
  path: z.string().optional(),
}).loose();
const replyInputSchema = z.object({
  body: z.string().trim().min(1, "reply requires a non-empty body."),
  threadId: z.string().min(1, "reply requires threadId."),
}).loose();
const threadInputSchema = z.object({
  threadId: z.string().min(1, "threadId is required."),
}).loose();
const openInputSchema = z.object({
  artifactId: z.string().min(1, "open requires artifactId."),
  versionId: z.string().optional(),
}).loose();

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: ToolInput,
): z.infer<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Registration lifecycle.
// ---------------------------------------------------------------------------

/**
 * Register the review tools while a WebMCP-capable browser and the user's
 * toggle both allow it; unregister by aborting on disable or unmount.
 */
export function useWebmcp(ref: BindingsRef): void {
  const [enabled, setEnabled] = useState(webmcpEnabled);
  useEffect(() => {
    const follow = (): void => setEnabled(webmcpEnabled());
    window.addEventListener(changeEvent, follow);
    window.addEventListener("storage", follow);
    return () => {
      window.removeEventListener(changeEvent, follow);
      window.removeEventListener("storage", follow);
    };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const modelContext = readModelContext();
    if (modelContext === null) return undefined;
    const registration = new AbortController();
    for (const tool of reviewTools(ref)) {
      try {
        void Promise.resolve(
          modelContext.registerTool(tool, {signal: registration.signal}),
        ).catch(() => undefined);
      } catch {
        // A partial implementation never disturbs the review application.
      }
    }
    return () => registration.abort();
  }, [enabled, ref]);
}

/** The per-user browser-agent preference shown on the WebMCP settings page. */
export function WebmcpSettingsCard() {
  const [enabled, setEnabled] = useState(webmcpEnabled);
  return (
    <label className="as-settings__webmcp">
      <input
        checked={enabled}
        onChange={(event) => {
          setEnabled(event.currentTarget.checked);
          setWebmcpEnabled(event.currentTarget.checked);
        }}
        type="checkbox"
      />
      <span>
        <strong>Browser agent tools</strong>
        <small>
          Let a browser-resident AI agent operate Review through WebMCP tools in this session.
          Dispatching to coding agents stays a human action.
        </small>
      </span>
    </label>
  );
}
