/**
 * Artifact Server agent-bridge core.
 *
 * A pure, host-agnostic library: everything host-shaped arrives through the
 * explicit {@link HostPort} contract, and every network call goes through the
 * injected fetch implementation. The bridge is fail-open by design — a
 * missing configuration leaves it dormant after one notice, a dead backend
 * only produces bounded backoff, and no failure is ever thrown back into the
 * host that called {@link startBridge}.
 */

import {createHash, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {setTimeout as scheduledDelay} from "node:timers/promises";

import {z} from "zod";

// ---------------------------------------------------------------------------
// Host-facing port
// ---------------------------------------------------------------------------

/** The only delivery option the bridge may ever hand to the host. */
export interface FollowUpDelivery {
  readonly deliverAs: "followUp";
}

/** Notification severities the host surfaces to its user. */
export type BridgeNoticeKind = "error" | "info" | "warning";

/**
 * The narrow host surface the bridge core uses. The host-facing entry wires
 * it to a live extension handle; tests inject a recording object. A
 * synchronous throw from any port method is treated as a lost host handle
 * (hosts invalidate captured handles across session replacement and reload),
 * which ends the claim loop without raising into the host.
 */
export interface HostPort {
  /** True while the host session is compacting and cannot accept a prompt. */
  isCompacting(): boolean;
  /** Surface one short informational notice to the user. */
  notify(message: string, kind: BridgeNoticeKind): void;
  /** Inject one user message; the bridge always names follow-up delivery. */
  sendUserMessage(text: string, delivery: FollowUpDelivery): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Environment-provided configuration, already read from process.env. */
export interface EnvironmentConfiguration {
  /** `ARTIFACT_SERVER_AGENT_NAME`: optional display-name override. */
  readonly agentDisplayName: string | undefined;
  /** `ARTIFACT_SERVER_AGENT_TOKEN`: bearer credential for the server. */
  readonly agentToken: string | undefined;
  /** `ARTIFACT_SERVER_ORIGIN`: the server origin, e.g. http://127.0.0.1:4873. */
  readonly origin: string | undefined;
}

/** One resolved server connection: origin plus bearer credential. */
export interface BridgeCredentials {
  readonly origin: string;
  readonly token: string;
}

const localServiceRecordSchema = z.object({origin: z.url()}).loose();

function parsedOrigin(candidate: string): URL | null {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function normalizedOrigin(candidate: string): string | null {
  const url = parsedOrigin(candidate);
  if (url === null) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

/** The local discovery record promises a loopback-only HTTP origin. */
function loopbackOrigin(candidate: string): string | null {
  const url = parsedOrigin(candidate);
  if (url === null || url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return url.origin;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the server connection, environment first, then the local install's
 * discovery contract (`~/.artifact-server/local-service.json` next to
 * `local-api-token`). Returns null when nothing resolves — the caller then
 * starts the bridge dormant.
 */
export async function resolveBridgeCredentials(
  environment: EnvironmentConfiguration,
  homeDirectory: string,
): Promise<BridgeCredentials | null> {
  const environmentOrigin = environment.origin?.trim() ?? "";
  const environmentToken = environment.agentToken?.trim() ?? "";
  if (environmentOrigin !== "" && environmentToken !== "") {
    const origin = normalizedOrigin(environmentOrigin);
    return origin === null ? null : {origin, token: environmentToken};
  }

  const dataDirectory = path.join(homeDirectory, ".artifact-server");
  const rawRecord = await readOptionalFile(
    path.join(dataDirectory, "local-service.json"),
  );
  const rawToken = await readOptionalFile(
    path.join(dataDirectory, "local-api-token"),
  );
  if (rawRecord === null || rawToken === null) return null;
  const token = rawToken.trim();
  if (token.length < 20 || token.length > 200) return null;
  let recordJson: unknown;
  try {
    recordJson = JSON.parse(rawRecord);
  } catch {
    return null;
  }
  const record = localServiceRecordSchema.safeParse(recordJson);
  if (!record.success) return null;
  const origin = loopbackOrigin(record.data.origin);
  return origin === null ? null : {origin, token};
}

/** The self-chosen agent name: the override, or the directory's basename. */
export function chooseDisplayName(
  environment: EnvironmentConfiguration,
  workingDirectory: string,
): string {
  const override = environment.agentDisplayName?.trim() ?? "";
  if (override !== "") return override.slice(0, 120);
  const basename = path.basename(workingDirectory).trim();
  return basename === "" ? "pi" : basename.slice(0, 120);
}

/** Stable upsert identity: the same machine and directory reclaim one row. */
export function connectionKeyFor(
  hostname: string,
  workingDirectory: string,
): string {
  return createHash("sha256")
    .update(`${hostname}\u0000${workingDirectory}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Untrusted-text sanitization
// ---------------------------------------------------------------------------

/**
 * Bidirectional controls (U+202A–202E, U+2066–2069) and zero-width or
 * otherwise invisible characters (U+200B–200F, U+2060, U+FEFF) that hostile
 * comment text could use to reorder or hide what the host agent reads.
 */
const invisibleDirectivePattern =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/gu;

/**
 * Strip bidirectional-override and invisible Unicode from one piece of
 * untrusted text before it is composed into a bundle message. Pure and
 * idempotent; every visible character passes through unchanged.
 */
export function sanitizeBundleText(text: string): string {
  return text.replace(invisibleDirectivePattern, "");
}

// ---------------------------------------------------------------------------
// Bundle rendering
// ---------------------------------------------------------------------------

/** Longest quoted selection the rendered message reproduces. */
export const maximumQuotedSelectionCharacters = 300;

/** One rendered line item of a bundle. */
export interface BundleItem {
  readonly artifactName: string;
  readonly body: string;
  readonly path: string | null;
  readonly quotedSelection: string | null;
  readonly threadId: string;
  readonly versionNumber: number;
}

/** Everything the message template needs, already fetched and ordered. */
export interface RenderableBundle {
  readonly items: readonly BundleItem[];
  readonly note: string | null;
  readonly senderDisplayName: string;
}

function quotedSelectionFragment(selection: string): string {
  const collapsed = sanitizeBundleText(selection).replace(/\s+/gu, " ").trim();
  const bounded = collapsed.length <= maximumQuotedSelectionCharacters
    ? collapsed
    : `${collapsed.slice(0, maximumQuotedSelectionCharacters - 1)}…`;
  return `"${bounded}"`;
}

/**
 * Render one bundle as one message in the recorded template. The message
 * always starts with the constant `Artifact Server:` prefix, so no rendered
 * message can ever begin with a slash and be intercepted as a host command,
 * and every untrusted field is stripped of bidirectional and invisible
 * Unicode before composition.
 */
export function renderBundleMessage(bundle: RenderableBundle): string {
  const lines: string[] = [];
  lines.push(
    `Artifact Server: ${bundle.senderDisplayName} sent ` +
      `${bundle.items.length} annotation(s) to address.`,
  );
  const note = sanitizeBundleText(bundle.note ?? "").trim();
  if (note !== "") lines.push(note);
  lines.push("");
  bundle.items.forEach((item, index) => {
    const place = item.path === null
      ? `[${item.artifactName} · version ${item.versionNumber}]`
      : `[${item.artifactName} · version ${item.versionNumber} · ${item.path}]`;
    const quoted = item.quotedSelection === null
      ? ""
      : ` ${quotedSelectionFragment(item.quotedSelection)}`;
    lines.push(`${index + 1}. ${place}${quoted}`);
    for (const bodyLine of sanitizeBundleText(item.body).split("\n")) {
      lines.push(`   ${bodyLine}`);
    }
    lines.push(`   (thread ${item.threadId})`);
  });
  lines.push("");
  lines.push(
    "When each item is done: use the artifact_comments tool to reply to its thread",
  );
  lines.push(
    "with what you did, then resolve it. Do not wait for confirmation.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** The protocol version this client implements. */
export const clientProtocolVersion = 1;

/**
 * The capability set this client advertises at registration: the best-effort
 * activity beacon, and native delivery evidence (the host itself accepts
 * each message before the bridge reports `delivered`).
 */
export const clientCapabilities = {
  beacon: true,
  evidence: "native",
} as const;

const registeredAgentSchema = z.object({id: z.string()}).loose();
const agentRegistrationSchema = z.object({
  agent: registeredAgentSchema,
  protocolVersion: z.number().optional(),
}).loose();
const dispatchSchema = z.object({
  id: z.string(),
  note: z.string().nullable(),
  projectId: z.string(),
  sender: z.object({displayName: z.string()}).loose(),
  threadIds: z.array(z.string()),
}).loose();
const claimAnswerSchema = z.object({dispatch: dispatchSchema}).loose();
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string()}).loose(),
  }).loose()),
  nextCursor: z.string().nullable(),
}).loose();
const threadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  body: z.string(),
  id: z.string(),
  path: z.string().nullable(),
  state: z.enum(["open", "resolved"]),
  versionId: z.string(),
}).loose();
const threadPageSchema = z.object({
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
}).loose();
const threadDetailsSchema = z.object({
  replies: z.array(z.object({
    author: z.object({displayName: z.string()}).loose(),
    body: z.string(),
    createdAt: z.string(),
    id: z.string(),
  }).loose()),
  thread: threadSchema,
}).loose();
const versionListSchema = z.object({
  versions: z.array(z.object({
    version: z.object({id: z.string(), number: z.number()}).loose(),
  }).loose()),
}).loose();
const projectListSchema = z.object({
  projects: z.array(z.object({id: z.string()}).loose()),
}).loose();
const anchorSelectionSchema = z.object({originalText: z.string()}).loose();

/** One claimed dispatch as the bridge reads it off the wire. */
export type ClaimedDispatch = z.infer<typeof dispatchSchema>;

/** A semantic bundle failure the bridge reports back as `failed`. */
export class BundleFetchError extends Error {}

/** Raised internally when a host port call throws — the handle is gone. */
class HostHandleLostError extends Error {}

interface HttpSession {
  readonly credentials: BridgeCredentials;
  readonly fetchImplementation: typeof fetch;
}

interface ApiRequest {
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "PATCH" | "POST";
  readonly signal?: AbortSignal;
}

function apiFetch(
  session: HttpSession,
  pathnameAndQuery: string,
  request: ApiRequest,
): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${session.credentials.token}`,
    "Content-Type": "application/json",
  });
  if (request.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", request.idempotencyKey);
  }
  const init: RequestInit = {headers, method: request.method};
  if (request.body !== undefined) init.body = request.body;
  if (request.signal !== undefined) init.signal = request.signal;
  return session.fetchImplementation(
    `${session.credentials.origin}${pathnameAndQuery}`,
    init,
  );
}

async function failureDescription(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status} ${text}`.trim().slice(0, 300);
}

/** Bound every cursor walk so a server bug can never spin the loop forever. */
const maximumListingPages = 50;

async function listArtifacts(
  session: HttpSession,
  projectId: string,
): Promise<readonly {readonly id: string; readonly name: string}[]> {
  const artifacts: {id: string; name: string}[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maximumListingPages; page += 1) {
    const query: string = cursor === null ? "" : `&cursor=${cursor}`;
    // eslint-disable-next-line no-await-in-loop
    const response = await apiFetch(
      session,
      `/api/v1/artifacts?projectId=${projectId}&limit=100${query}`,
      {method: "GET"},
    );
    if (!response.ok) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await failureDescription(response);
      throw new BundleFetchError(`Listing artifacts answered ${answer}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const parsed = artifactPageSchema.parse(await response.json());
    for (const item of parsed.artifacts) {
      artifacts.push({id: item.artifact.id, name: item.artifact.name});
    }
    cursor = parsed.nextCursor;
    if (cursor === null) break;
  }
  return artifacts;
}

async function collectThreads(
  session: HttpSession,
  projectId: string,
  artifactId: string,
  dispatched: "include" | "only",
  collect: (thread: z.infer<typeof threadSchema>) => void,
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < maximumListingPages; page += 1) {
    const query: string = cursor === null ? "" : `&cursor=${cursor}`;
    // eslint-disable-next-line no-await-in-loop
    const response = await apiFetch(
      session,
      `/api/v1/artifacts/${artifactId}/comments` +
        `?projectId=${projectId}&dispatched=${dispatched}&limit=100${query}`,
      {method: "GET"},
    );
    if (!response.ok) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await failureDescription(response);
      throw new BundleFetchError(`Listing comment threads answered ${answer}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const parsed = threadPageSchema.parse(await response.json());
    for (const thread of parsed.items) collect(thread);
    cursor = parsed.nextCursor;
    if (cursor === null) break;
  }
}

async function versionNumbersFor(
  session: HttpSession,
  projectId: string,
  artifactId: string,
): Promise<ReadonlyMap<string, number>> {
  const response = await apiFetch(
    session,
    `/api/v1/artifacts/${artifactId}/versions?projectId=${projectId}`,
    {method: "GET"},
  );
  if (!response.ok) {
    const answer = await failureDescription(response);
    throw new BundleFetchError(`Listing versions answered ${answer}`);
  }
  const parsed = versionListSchema.parse(await response.json());
  const numbers = new Map<string, number>();
  for (const entry of parsed.versions) {
    numbers.set(entry.version.id, entry.version.number);
  }
  return numbers;
}

// ---------------------------------------------------------------------------
// Thread location cache (shared with the artifact_comments tool)
// ---------------------------------------------------------------------------

/** Where one comment thread lives, enough to address the comment routes. */
export interface ThreadLocation {
  readonly artifactId: string;
  readonly projectId: string;
}

/**
 * Remembers where threads live, filled by every bundle fetch, so the
 * registered tool can reply and resolve without re-scanning the server.
 */
export class ThreadLocationCache {
  readonly #locations = new Map<string, ThreadLocation>();

  find(threadId: string): ThreadLocation | null {
    return this.#locations.get(threadId) ?? null;
  }

  remember(threadId: string, location: ThreadLocation): void {
    this.#locations.set(threadId, location);
  }
}

async function locateThread(
  session: HttpSession,
  cache: ThreadLocationCache,
  threadId: string,
): Promise<ThreadLocation> {
  const cached = cache.find(threadId);
  if (cached !== null) return cached;
  const projectsResponse = await apiFetch(session, "/api/v1/projects", {
    method: "GET",
  });
  if (!projectsResponse.ok) {
    const answer = await failureDescription(projectsResponse);
    throw new BundleFetchError(`Listing projects answered ${answer}`);
  }
  const projects = projectListSchema.parse(await projectsResponse.json());
  for (const project of projects.projects) {
    // eslint-disable-next-line no-await-in-loop
    for (const artifact of await listArtifacts(session, project.id)) {
      let found: ThreadLocation | null = null;
      // eslint-disable-next-line no-await-in-loop
      await collectThreads(
        session,
        project.id,
        artifact.id,
        "include",
        (thread) => {
          cache.remember(thread.id, {
            artifactId: thread.artifactId,
            projectId: project.id,
          });
          if (thread.id === threadId) {
            found = {artifactId: thread.artifactId, projectId: project.id};
          }
        },
      );
      if (found !== null) return found;
    }
  }
  throw new BundleFetchError(`Thread ${threadId} was not found on the server.`);
}

// ---------------------------------------------------------------------------
// Bundle fetch
// ---------------------------------------------------------------------------

async function fetchThread(
  session: HttpSession,
  location: ThreadLocation,
  threadId: string,
): Promise<z.infer<typeof threadDetailsSchema>> {
  const response = await apiFetch(
    session,
    `/api/v1/artifacts/${location.artifactId}/comments/${threadId}` +
      `?projectId=${location.projectId}`,
    {method: "GET"},
  );
  if (!response.ok) {
    const answer = await failureDescription(response);
    throw new BundleFetchError(
      `Reading thread ${threadId} answered ${answer}`,
    );
  }
  return threadDetailsSchema.parse(await response.json());
}

/**
 * Assemble everything the message template needs for one claimed dispatch:
 * thread locations via the dispatched-thread listing, one comment read per
 * thread, and artifact names plus version numbers for the headers.
 */
export async function fetchBundle(
  session: HttpSession,
  dispatch: ClaimedDispatch,
  cache: ThreadLocationCache,
): Promise<RenderableBundle> {
  const wanted = new Set(dispatch.threadIds);
  const artifacts = await listArtifacts(session, dispatch.projectId);
  const artifactNames = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.name]),
  );
  const located = new Map<string, ThreadLocation>();
  for (const artifact of artifacts) {
    if (located.size === wanted.size) break;
    // eslint-disable-next-line no-await-in-loop
    await collectThreads(
      session,
      dispatch.projectId,
      artifact.id,
      "only",
      (thread) => {
        if (!wanted.has(thread.id)) return;
        const location: ThreadLocation = {
          artifactId: thread.artifactId,
          projectId: dispatch.projectId,
        };
        located.set(thread.id, location);
        cache.remember(thread.id, location);
      },
    );
  }

  const versionNumbers = new Map<string, ReadonlyMap<string, number>>();
  const items: BundleItem[] = [];
  for (const threadId of dispatch.threadIds) {
    const location = located.get(threadId);
    if (location === undefined) {
      throw new BundleFetchError(
        `Thread ${threadId} is not readable in project ${dispatch.projectId}.`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const details = await fetchThread(session, location, threadId);
    let numbers = versionNumbers.get(location.artifactId);
    if (numbers === undefined) {
      // eslint-disable-next-line no-await-in-loop
      numbers = await versionNumbersFor(
        session,
        dispatch.projectId,
        location.artifactId,
      );
      versionNumbers.set(location.artifactId, numbers);
    }
    const anchor = anchorSelectionSchema.safeParse(details.thread.anchor);
    items.push({
      artifactName: artifactNames.get(location.artifactId) ??
        location.artifactId,
      body: details.thread.body,
      path: details.thread.path,
      quotedSelection: anchor.success ? anchor.data.originalText : null,
      threadId,
      versionNumber: numbers.get(details.thread.versionId) ?? 0,
    });
  }
  return {
    items,
    note: dispatch.note,
    senderDisplayName: dispatch.sender.displayName,
  };
}

// ---------------------------------------------------------------------------
// Comment operations for the registered tool
// ---------------------------------------------------------------------------

/** One thread with its replies, shaped for the `artifact_comments` tool. */
export interface ToolThreadDetails {
  readonly body: string;
  readonly path: string | null;
  readonly replies: readonly {
    readonly authorDisplayName: string;
    readonly body: string;
    readonly createdAt: string;
  }[];
  readonly state: "open" | "resolved";
  readonly threadId: string;
}

/** Dependencies shared by the tool-facing comment operations. */
export interface CommentOperations {
  getThread(threadId: string): Promise<ToolThreadDetails>;
  reply(threadId: string, body: string): Promise<void>;
  resolve(threadId: string): Promise<void>;
}

/**
 * Build the comment operations the `artifact_comments` tool wraps. Pass the
 * bridge's {@link ActivityBeacon} so a successful reply or resolve reports
 * the matching activity transition; without one, no beacon is sent.
 */
export function createCommentOperations(
  credentials: BridgeCredentials,
  fetchImplementation: typeof fetch,
  cache: ThreadLocationCache,
  beacon?: ActivityBeacon,
): CommentOperations {
  const session: HttpSession = {credentials, fetchImplementation};
  return {
    async getThread(threadId) {
      const location = await locateThread(session, cache, threadId);
      const details = await fetchThread(session, location, threadId);
      return {
        body: details.thread.body,
        path: details.thread.path,
        replies: details.replies.map((reply) => ({
          authorDisplayName: reply.author.displayName,
          body: reply.body,
          createdAt: reply.createdAt,
        })),
        state: details.thread.state,
        threadId,
      };
    },
    async reply(threadId, body) {
      const location = await locateThread(session, cache, threadId);
      const response = await apiFetch(
        session,
        `/api/v1/artifacts/${location.artifactId}/comments/${threadId}` +
          `/replies?projectId=${location.projectId}`,
        {
          body: JSON.stringify({body}),
          idempotencyKey: randomUUID(),
          method: "POST",
        },
      );
      if (!response.ok) {
        const answer = await failureDescription(response);
        throw new BundleFetchError(
          `Replying to thread ${threadId} answered ${answer}`,
        );
      }
      beacon?.replySent(threadId);
    },
    async resolve(threadId) {
      const location = await locateThread(session, cache, threadId);
      const response = await apiFetch(
        session,
        `/api/v1/artifacts/${location.artifactId}/comments/${threadId}` +
          `?projectId=${location.projectId}`,
        {body: JSON.stringify({state: "resolved"}), method: "PATCH"},
      );
      if (!response.ok) {
        const answer = await failureDescription(response);
        throw new BundleFetchError(
          `Resolving thread ${threadId} answered ${answer}`,
        );
      }
      beacon?.threadResolved(threadId);
    },
  };
}

// ---------------------------------------------------------------------------
// Activity beacon
// ---------------------------------------------------------------------------

/** The fine-grained states the best-effort activity beacon reports. */
export type BeaconActivityState = "idle" | "replying" | "thinking";

type BeaconSender = (
  state: BeaconActivityState,
  dispatchId: string | null,
) => void;

/**
 * Turns the bridge's natural work boundaries into at most one activity
 * beacon per state transition: a bundle the host accepted reports
 * `thinking`, the first comment reply for that bundle reports `replying`,
 * and resolving the bundle's last thread reports `idle`. The beacon is
 * display metadata sent fire-and-forget — an unattached or failing sender
 * drops the beacon silently, and no send is ever awaited, retried, or
 * surfaced to the host. Share one instance between {@link startBridge} and
 * {@link createCommentOperations} so replies and resolves count against the
 * delivered bundle.
 */
export class ActivityBeacon {
  readonly #pending = new Map<
    string,
    {replied: boolean; readonly threads: Set<string>}
  >();
  #send: BeaconSender | null = null;

  /** Wired by the bridge once registration has produced an agent id. */
  attach(send: BeaconSender): void {
    this.#send = send;
  }

  /** The host accepted a bundle: report `thinking` and track its threads. */
  bundleAccepted(dispatchId: string, threadIds: readonly string[]): void {
    this.#pending.set(dispatchId, {
      replied: false,
      threads: new Set(threadIds),
    });
    this.#emit("thinking", dispatchId);
  }

  /** A reply landed: the first one per tracked bundle reports `replying`. */
  replySent(threadId: string): void {
    for (const [dispatchId, entry] of this.#pending) {
      if (entry.replied || !entry.threads.has(threadId)) continue;
      entry.replied = true;
      this.#emit("replying", dispatchId);
      return;
    }
  }

  /** A thread resolved: emptying the last tracked bundle reports `idle`. */
  threadResolved(threadId: string): void {
    if (this.#pending.size === 0) return;
    for (const [dispatchId, entry] of this.#pending) {
      entry.threads.delete(threadId);
      if (entry.threads.size === 0) this.#pending.delete(dispatchId);
    }
    if (this.#pending.size === 0) this.#emit("idle", null);
  }

  #emit(state: BeaconActivityState, dispatchId: string | null): void {
    if (this.#send === null) return;
    try {
      this.#send(state, dispatchId);
    } catch {
      // Fail open: a beacon can be lost, never felt.
    }
  }
}

// ---------------------------------------------------------------------------
// The claim loop
// ---------------------------------------------------------------------------

/** Default long-poll wait, matching the server's transport cap. */
export const defaultClaimWaitSeconds = 25;
/** First backoff step after an error. */
export const initialBackoffMilliseconds = 1_000;
/** Backoff ceiling; no recorded sleep after an error may exceed it. */
export const maximumBackoffMilliseconds = 30_000;
const compactionPollMilliseconds = 250;
/**
 * The hold must end well inside the server's five-minute claim lease. A hold
 * that outlives the lease would let the server requeue the bundle underneath
 * the bridge, so the late injection would land and its delivery report would
 * be refused, and the next claim would deliver the same annotations twice.
 */
const maximumCompactionHoldMilliseconds = 2 * 60 * 1_000;
const maximumFailureReasonCharacters = 500;

/** Time sources the tests replace with instant, recording fakes. */
export interface BridgeTimers {
  random(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

async function realSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await scheduledDelay(milliseconds, undefined, {signal});
  } catch {
    // An aborted sleep simply ends early; stopping is not an error.
  }
}

const defaultTimers: BridgeTimers = {
  random: () => Math.random(),
  sleep: realSleep,
};

/** Everything one bridge session needs; only the host and network are live. */
export interface StartBridgeOptions {
  readonly agentSessionId: string | null;
  /**
   * The activity-beacon coordinator, shared with
   * {@link createCommentOperations} so reply and resolve transitions count
   * against delivered bundles. Omitted, the bridge still beacons `thinking`
   * on each accepted bundle through a private instance.
   */
  readonly beacon?: ActivityBeacon;
  /** Null when nothing resolved: the bridge stays dormant after one notice. */
  readonly credentials: BridgeCredentials | null;
  readonly displayName: string;
  readonly fetchImplementation: typeof fetch;
  readonly host: HostPort;
  readonly hostname: string;
  /** The registered agent kind, a lowercase slug naming the host harness. */
  readonly kind: string;
  readonly locations?: ThreadLocationCache;
  readonly log?: (message: string) => void;
  readonly timers?: BridgeTimers;
  readonly waitSeconds?: number;
  readonly workingDirectory: string;
}

/** A running (or dormant) bridge session. */
export interface BridgeHandle {
  /** True when no configuration resolved and the loop never started. */
  readonly dormant: boolean;
  /** The registered agent id, once registration has succeeded. */
  agentId(): string | null;
  /**
   * The protocol version the server reported at registration, once known.
   * A server that predates the handshake reports nothing and is treated as
   * version 1.
   */
  protocolVersion(): number | null;
  /**
   * End the loop and abort the held poll. The courtesy disconnect (which
   * deletes the registration row) is sent only when `disconnect` is true —
   * a session replacement keeps the row so the successor reclaims the same
   * agent id and its queued dispatches.
   */
  stop(options?: BridgeStopOptions): Promise<void>;
}

/** How a bridge session ends: a real departure disconnects, a rebind does not. */
export interface BridgeStopOptions {
  readonly disconnect?: boolean;
}

/** The one dormancy notice, surfaced exactly once per unconfigured start. */
export const dormantNotice =
  "Artifact Server bridge: no server configured " +
  "(set ARTIFACT_SERVER_ORIGIN and ARTIFACT_SERVER_AGENT_TOKEN, " +
  "or run the local server); staying dormant.";

/**
 * Start the bridge. Never throws and never blocks: configuration was already
 * resolved by the caller, registration and claiming happen inside a detached
 * loop, and every failure is contained inside the returned handle.
 */
export function startBridge(options: StartBridgeOptions): BridgeHandle {
  const log = options.log ?? (() => undefined);
  if (options.credentials === null) {
    try {
      options.host.notify(dormantNotice, "info");
    } catch {
      log("The dormancy notice could not be shown.");
    }
    return {
      agentId: () => null,
      dormant: true,
      protocolVersion: () => null,
      stop: () => Promise.resolve(),
    };
  }

  const session: HttpSession = {
    credentials: options.credentials,
    fetchImplementation: options.fetchImplementation,
  };
  const timers = options.timers ?? defaultTimers;
  const waitSeconds = Math.max(
    1,
    Math.trunc(options.waitSeconds ?? defaultClaimWaitSeconds),
  );
  const cache = options.locations ?? new ThreadLocationCache();
  const beacon = options.beacon ?? new ActivityBeacon();
  const controller = new AbortController();
  let stopped = false;
  let agentId: string | null = null;
  let protocolVersion: number | null = null;

  const callPort = <Value>(action: () => Value): Value => {
    try {
      return action();
    } catch (error) {
      throw new HostHandleLostError(describeError(error));
    }
  };

  const register = async (): Promise<string> => {
    const registration = {
      agentSessionId: options.agentSessionId,
      connectionKey: connectionKeyFor(
        options.hostname,
        options.workingDirectory,
      ),
      displayName: options.displayName,
      kind: options.kind,
      workingDirectory: options.workingDirectory,
    };
    let response = await apiFetch(session, "/api/v1/agents", {
      body: JSON.stringify({
        ...registration,
        capabilities: clientCapabilities,
      }),
      method: "POST",
      signal: controller.signal,
    });
    if (response.status === 422) {
      // A server that predates the capability handshake refuses the field
      // outright; register without it and treat the server as version 1.
      response = await apiFetch(session, "/api/v1/agents", {
        body: JSON.stringify(registration),
        method: "POST",
        signal: controller.signal,
      });
    }
    if (!response.ok) {
      const answer = await failureDescription(response);
      throw new Error(`Agent registration answered ${answer}`);
    }
    const answer = agentRegistrationSchema.parse(await response.json());
    protocolVersion = answer.protocolVersion ?? 1;
    const registeredId = answer.agent.id;
    // The beacon is fire-and-forget by contract: the send is never awaited,
    // and any refusal or transport failure is dropped without notice.
    beacon.attach((state, dispatchId) => {
      void apiFetch(session, `/api/v1/agents/${registeredId}/activity`, {
        body: JSON.stringify(
          dispatchId === null ? {state} : {dispatchId, state},
        ),
        method: "POST",
        signal: controller.signal,
      }).then((answered) => answered.body?.cancel(), () => undefined)
        .catch(() => undefined);
    });
    return registeredId;
  };

  const claimNext = async (agent: string): Promise<ClaimedDispatch | null> => {
    const response = await apiFetch(
      session,
      `/api/v1/agents/${agent}/claims?wait=${waitSeconds}`,
      {method: "POST", signal: controller.signal},
    );
    if (response.status === 204) return null;
    if (!response.ok) {
      // A reaped agent row answers not-found, and a row that now belongs to
      // another principal answers denied: re-register on the next pass rather
      // than polling a handle this session can never use again.
      if (response.status === 404 || response.status === 403) agentId = null;
      const answer = await failureDescription(response);
      throw new Error(`The claim poll answered ${answer}`);
    }
    return claimAnswerSchema.parse(await response.json()).dispatch;
  };

  const reportOutcome = async (
    dispatchId: string,
    agent: string,
    outcome: "delivered" | "failed",
    reason: string | null,
  ): Promise<void> => {
    // Reports are tolerant: a lost report only costs one lease redelivery
    // (at-least-once, the documented posture), never a stuck loop.
    try {
      const body = outcome === "failed"
        ? JSON.stringify({
          agentId: agent,
          reason: (reason ?? "unspecified").slice(
            0,
            maximumFailureReasonCharacters,
          ),
        })
        : JSON.stringify({agentId: agent});
      const response = await apiFetch(
        session,
        `/api/v1/agent-dispatches/${dispatchId}/${outcome}`,
        {body, method: "POST", signal: controller.signal},
      );
      if (!response.ok) {
        const answer = await failureDescription(response);
        log(`Reporting ${outcome} for ${dispatchId} answered ${answer}`);
      }
    } catch (error) {
      log(`Reporting ${outcome} for ${dispatchId} failed: ${
        describeError(error)
      }`);
    }
  };

  const holdWhileCompacting = async (): Promise<void> => {
    let heldMilliseconds = 0;
    while (callPort(() => options.host.isCompacting())) {
      if (stopped) return;
      if (heldMilliseconds >= maximumCompactionHoldMilliseconds) {
        throw new BundleFetchError(
          "The host session compacted for too long to deliver the bundle.",
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await timers.sleep(compactionPollMilliseconds, controller.signal);
      heldMilliseconds += compactionPollMilliseconds;
    }
  };

  const deliver = async (
    dispatch: ClaimedDispatch,
    agent: string,
  ): Promise<void> => {
    let message: string;
    try {
      message = renderBundleMessage(await fetchBundle(session, dispatch, cache));
      await holdWhileCompacting();
    } catch (error) {
      if (error instanceof BundleFetchError) {
        await reportOutcome(dispatch.id, agent, "failed", error.message);
        return;
      }
      throw error;
    }
    if (stopped) return;
    callPort(() => {
      options.host.notify(
        `Artifact Server: delivering ${dispatch.threadIds.length} ` +
          `annotation(s) from ${dispatch.sender.displayName}.`,
        "info",
      );
      options.host.sendUserMessage(message, {deliverAs: "followUp"});
    });
    beacon.bundleAccepted(dispatch.id, dispatch.threadIds);
    await reportOutcome(dispatch.id, agent, "delivered", null);
  };

  const loop = (async () => {
    let backoff = 0;
    while (!controller.signal.aborted) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (agentId === null) agentId = await register();
        // eslint-disable-next-line no-await-in-loop
        const dispatch = await claimNext(agentId);
        backoff = 0;
        if (dispatch === null) continue;
        // eslint-disable-next-line no-await-in-loop
        await deliver(dispatch, agentId);
      } catch (error) {
        if (stopped || controller.signal.aborted) break;
        if (error instanceof HostHandleLostError) {
          log(
            `The host handle is gone; ending the claim loop: ${error.message}`,
          );
          break;
        }
        backoff = backoff === 0
          ? initialBackoffMilliseconds
          : Math.min(backoff * 2, maximumBackoffMilliseconds);
        const jittered = Math.min(
          Math.round(backoff * (1 + timers.random() * 0.25)),
          maximumBackoffMilliseconds,
        );
        log(
          `Bridge loop error (retrying in ${jittered} ms): ${
            describeError(error)
          }`,
        );
        // eslint-disable-next-line no-await-in-loop
        await timers.sleep(jittered, controller.signal);
      }
    }
  })();

  const stop = async (stopOptions?: BridgeStopOptions): Promise<void> => {
    if (stopped) {
      await loop;
      return;
    }
    stopped = true;
    controller.abort();
    await loop;
    if (agentId !== null && (stopOptions?.disconnect ?? true)) {
      try {
        await apiFetch(session, `/api/v1/agents/${agentId}/disconnect`, {
          method: "POST",
        });
      } catch (error) {
        log(`The courtesy disconnect failed: ${describeError(error)}`);
      }
    }
  };

  return {
    agentId: () => agentId,
    dormant: false,
    protocolVersion: () => protocolVersion,
    stop,
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
