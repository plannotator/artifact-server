/**
 * Agent dispatch against the deployed Cloudflare Worker: the real HTTP routes
 * from the shared app, driven over `unstable_dev` so every mailbox operation
 * runs through real D1 batches, mutation guards, and lazy transitions inside
 * workerd instead of a simulated database.
 *
 * There is no probe seam and no injected clock here. The Worker runs on the
 * system clock, so the two time-driven transitions the mailbox owns — claim
 * lease expiry (5 minutes) and `agent_unavailable` auto-failure (15 minutes) —
 * are proved by the conformance suite (`tests/conformance/dsp-006`, `dsp-009`),
 * which drives the same routes with a movable clock. Everything a real agent
 * does inside one session is proved here, on D1.
 */
import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

/**
 * The harness answers with its own runtime's Response, which is not the
 * Workers `Response` this project compiles against, so every helper here
 * names the harness type instead of the ambient one.
 */
type WorkerResponse = Awaited<ReturnType<Unstable_DevWorker["fetch"]>>;

const apiToken = "cloudflare-dispatch-test-api-token-000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const installationId = "cloudflare-dispatch-test";
/** The server cap on one held claim poll, per the dispatch transport contract. */
const maximumClaimWaitSeconds = 25;

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()})).length(1),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), projectId: z.string()}).loose(),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
}).loose();
const threadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: z.object({id: z.string(), state: z.string()}).loose(),
}).loose();
const threadPageSchema = z.object({
  items: z.array(z.object({id: z.string()}).loose()),
  nextCursor: z.string().nullable(),
}).loose();
const agentSchema = z.object({
  agentSessionId: z.string().nullable(),
  capabilities: z.object({
    beacon: z.boolean(),
    evidence: z.enum(["channel", "mailbox", "native"]),
  }).strict(),
  connectionKey: z.string(),
  createdAt: z.iso.datetime(),
  displayName: z.string(),
  id: z.string().startsWith("agt_"),
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  lastSeenAt: z.iso.datetime(),
  principalId: z.string(),
  workingDirectory: z.string(),
}).strict();
const agentRegistrationSchema = z.object({
  agent: agentSchema,
  protocolVersion: z.literal(1),
}).strict();
const agentListSchema = z.object({
  items: z.array(agentSchema.extend({
    activeDispatchId: z.string().nullable(),
    activity: z.enum(["disconnected", "idle", "working"]),
    beacon: z.enum(["replying", "thinking"]).nullable(),
    connected: z.boolean(),
    lastActivityAt: z.iso.datetime(),
  }).strict()),
}).strict();
const dispatchSchema = z.object({
  addressedAt: z.iso.datetime().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.iso.datetime().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  id: z.string().startsWith("dsp_"),
  idempotencyKey: z.string(),
  installationId: z.string().optional(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  sender: z.object({
    authorizedByPrincipalId: z.string().nullable(),
    displayName: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
  }).strict(),
  state: z.enum([
    "addressed",
    "canceled",
    "claimed",
    "delivered",
    "failed",
    "queued",
  ]),
  threadIds: z.array(z.string()),
  updatedAt: z.iso.datetime(),
}).strict();
const dispatchEnvelopeSchema = z.object({dispatch: dispatchSchema}).strict();
const dispatchCreationSchema = z.object({
  dispatch: dispatchSchema,
  replayed: z.boolean(),
}).strict();
const dispatchPageSchema = z.object({
  items: z.array(dispatchSchema),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();
const schemaVersionRowSchema = z.object({version: z.number().int().positive()});
const tableColumnRowSchema = z.object({name: z.string()});
const tableNameRowSchema = z.object({name: z.string()});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(
    join(tmpdir(), "artifact-server-cloudflare-dispatch-"),
  );
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 agent dispatch", () => {
  it("runs the dispatch mailbox lifecycle over the real routes and keeps sent annotations out of the default listings", async () => {
    const agent = await registerAgent(worker, {
      agentSessionId: "pi-session-one",
      connectionKey: "connection-key-one",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const listed = await readBody(
      await request(worker, "/api/v1/agents"),
      agentListSchema,
    );
    expect(listed.items.map(({id}) => id)).toEqual([agent.id]);
    // The registration is the first heartbeat, so the agent reads as connected.
    expect(listed.items[0]?.connected).toBe(true);

    const published = await publishArtifact(worker, "dispatch-lifecycle-pub-1");
    const projectId = published.artifact.projectId;
    const first = await createThread(worker, published, "The heading is wrong.");
    const second = await createThread(
      worker,
      published,
      "The footnote has no source.",
    );
    const third = await createThread(
      worker,
      published,
      "The legend overlaps the axis.",
    );

    const sent = await readBody(
      await sendDispatch(worker, {
        agentId: agent.id,
        idempotencyKey: "dispatch-bundle-one",
        projectId,
        threadIds: [first, second],
      }),
      dispatchCreationSchema,
    );
    expect(sent.replayed).toBe(false);
    expect(sent.dispatch.state).toBe("queued");
    expect(sent.dispatch.threadIds).toEqual([first, second]);
    expect(sent.dispatch.agentDisplayName).toBe("site");
    const dispatchId = sent.dispatch.id;

    const replay = await sendDispatch(worker, {
      agentId: agent.id,
      idempotencyKey: "dispatch-bundle-one",
      projectId,
      threadIds: [first, second],
    });
    expect(replay.status).toBe(201);
    expect(await readBody(replay, dispatchCreationSchema))
      .toMatchObject({dispatch: {id: dispatchId}, replayed: true});

    // A thread already inside an active dispatch cannot be double-booked, and
    // the refused bundle leaves no dispatch row and no new markers behind.
    const doubleBooked = await sendDispatch(worker, {
      agentId: agent.id,
      idempotencyKey: "dispatch-bundle-double",
      projectId,
      threadIds: [second, third],
    });
    expect(doubleBooked.status).toBe(422);
    expect(await readFailureCode(doubleBooked)).toBe("INVALID_DISPATCH");

    // Send is consumptive: the bundle threads leave the default listing on the
    // real HTTP surface, and only the "only" filter brings them back.
    expect(await listThreadIds(worker, published)).toEqual([third]);
    expect(await listThreadIds(worker, published, "only"))
      .toEqual([second, first]);
    expect(await listThreadIds(worker, published, "include"))
      .toEqual([third, second, first]);

    // A restarted agent re-registers under the same connection key, keeps its
    // id, and therefore keeps the queue that was addressed to it.
    const restarted = await registerAgent(worker, {
      agentSessionId: "pi-session-two",
      connectionKey: "connection-key-one",
      displayName: "site (restarted)",
      workingDirectory: "/work/site",
    });
    expect(restarted.id).toBe(agent.id);
    expect(restarted.displayName).toBe("site (restarted)");
    expect(restarted.agentSessionId).toBe("pi-session-two");

    const claimed = await claimDispatch(worker, agent.id);
    expect(claimed.status).toBe(200);
    const claimedDispatch =
      (await readBody(claimed, dispatchEnvelopeSchema)).dispatch;
    expect(claimedDispatch.id).toBe(dispatchId);
    expect(claimedDispatch.state).toBe("claimed");
    expect(claimedDispatch.claimedAt).not.toBeNull();
    expect(leaseMinutes(claimedDispatch)).toBe(5);
    // One-active-claim: the next poll answers empty while a claim is held.
    expect((await claimDispatch(worker, agent.id)).status).toBe(204);

    // A report from a registered agent that does not hold the claim is a state
    // conflict, not a silent success.
    const bystander = await registerAgent(worker, {
      connectionKey: "connection-key-bystander",
      displayName: "bystander",
      workingDirectory: "/work/bystander",
    });
    const foreignReport = await reportDelivered(worker, dispatchId, bystander.id);
    expect(foreignReport.status).toBe(409);
    expect(await readFailureCode(foreignReport)).toBe("DISPATCH_STATE_CONFLICT");
    // A bundle addressed to another agent is never handed over.
    expect((await claimDispatch(worker, bystander.id)).status).toBe(204);

    const delivered = await reportDelivered(worker, dispatchId, agent.id);
    expect(delivered.status).toBe(200);
    const deliveredDispatch =
      (await readBody(delivered, dispatchEnvelopeSchema)).dispatch;
    expect(deliveredDispatch.state).toBe("delivered");
    expect(deliveredDispatch.deliveredAt).not.toBeNull();

    // Addressed is inferred from thread resolution on the read path, and only
    // once every bundle thread is resolved.
    await resolveThread(worker, published, first);
    expect((await getDispatch(worker, dispatchId, projectId)).state)
      .toBe("delivered");
    await resolveThread(worker, published, second);
    const addressed = await getDispatch(worker, dispatchId, projectId);
    expect(addressed.state).toBe("addressed");
    expect(addressed.addressedAt).not.toBeNull();
    // Terminal states never transition again.
    const afterTerminal = await reportDelivered(worker, dispatchId, agent.id);
    expect(afterTerminal.status).toBe(409);
    expect(await readFailureCode(afterTerminal)).toBe("DISPATCH_STATE_CONFLICT");
    // Addressed clears no markers: the threads are resolved and invisible.
    expect(await listThreadIds(worker, published, "only"))
      .toEqual([second, first]);

    // Cancellation returns its annotations to the default listings.
    const canceledBundle = (await readBody(
      await sendDispatch(worker, {
        agentId: agent.id,
        idempotencyKey: "dispatch-bundle-cancel",
        projectId,
        threadIds: [third],
      }),
      dispatchCreationSchema,
    )).dispatch;
    expect(await listThreadIds(worker, published)).toEqual([]);
    const canceled = await cancelDispatch(worker, canceledBundle.id, projectId);
    expect(canceled.status).toBe(200);
    expect((await readBody(canceled, dispatchEnvelopeSchema)).dispatch.state)
      .toBe("canceled");
    expect(await listThreadIds(worker, published)).toEqual([third]);
    const recancel = await cancelDispatch(worker, canceledBundle.id, projectId);
    expect(recancel.status).toBe(409);
    expect(await readFailureCode(recancel)).toBe("DISPATCH_STATE_CONFLICT");

    // A permanent failure also returns the annotation to the artifact surfaces.
    const failingBundle = (await readBody(
      await sendDispatch(worker, {
        agentId: agent.id,
        idempotencyKey: "dispatch-bundle-failed",
        note: "The chart legend needs a rebuild.",
        projectId,
        threadIds: [third],
      }),
      dispatchCreationSchema,
    )).dispatch;
    expect(failingBundle.note).toBe("The chart legend needs a rebuild.");
    // The name snapshot follows the agent's name at send time, not at read time.
    expect(failingBundle.agentDisplayName).toBe("site (restarted)");
    expect((await claimDispatch(worker, agent.id)).status).toBe(200);
    const failed = await reportFailed(
      worker,
      failingBundle.id,
      agent.id,
      "the working tree was dirty",
    );
    expect(failed.status).toBe(200);
    const failedDispatch =
      (await readBody(failed, dispatchEnvelopeSchema)).dispatch;
    expect(failedDispatch.state).toBe("failed");
    expect(failedDispatch.failureReason).toBe("the working tree was dirty");
    expect(await listThreadIds(worker, published)).toEqual([third]);

    // Keyset paging is newest first and walks the whole project history.
    const page = await listDispatches(worker, projectId, "&limit=2");
    expect(page.items.map(({id}) => id))
      .toEqual([failingBundle.id, canceledBundle.id]);
    expect(page.nextCursor).not.toBeNull();
    const rest = await listDispatches(
      worker,
      projectId,
      `&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
    );
    expect(rest.items.map(({id}) => id)).toEqual([dispatchId]);
    expect(rest.nextCursor).toBeNull();
    const addressedOnly = await listDispatches(
      worker,
      projectId,
      `&state=addressed&agentId=${agent.id}`,
    );
    expect(addressedOnly.items.map(({id}) => id)).toEqual([dispatchId]);

    // The agent row is disposable; dispatch history keeps its own snapshot.
    const disconnected = await request(
      worker,
      `/api/v1/agents/${agent.id}/disconnect`,
      {method: "POST"},
    );
    expect(disconnected.status).toBe(204);
    const remaining = await readBody(
      await request(worker, "/api/v1/agents"),
      agentListSchema,
    );
    expect(remaining.items.map(({id}) => id)).toEqual([bystander.id]);

    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = await listDispatches(worker, projectId);
    expect(afterRestart.items.map(({id}) => id)).toEqual([
      failingBundle.id,
      canceledBundle.id,
      dispatchId,
    ]);
    const oldest = afterRestart.items.at(-1);
    expect(oldest?.agentDisplayName).toBe("site");
    expect(oldest?.state).toBe("addressed");

    // Reopening a thread of an addressed bundle releases that one marker, so
    // the annotation returns to the default listings instead of being stranded
    // off every surface with no route that clears it.
    await setThreadState(worker, published, first, "open");
    expect(await listThreadIds(worker, published)).toEqual([third, first]);
    expect(await listThreadIds(worker, published, "only")).toEqual([second]);
    expect((await getDispatch(worker, dispatchId, projectId)).state)
      .toBe("addressed");
  }, 180_000);

  it("holds one claim poll open for its full wait on the Worker runtime and answers it early when a bundle arrives", async () => {
    // Spec section 13 open item: "that a 25 s held request is acceptable on the
    // Cloudflare worker". Measured here rather than assumed. Observed under
    // wrangler 4.123.0 `unstable_dev` (workerd, local mode) on macOS: an
    // over-cap wait=30 poll answered 204 after 25008 ms — held for the full
    // server cap, clamped rather than refused, with no proxy or runtime cutoff
    // and no truncated response. A bundle created 1500 ms into a held poll was
    // answered 200 at 2014 ms, which is the next 1 s re-check boundary, and the
    // send itself was served while the poll was still open.
    const agent = await registerAgent(worker, {
      connectionKey: "connection-key-poll",
      displayName: "poller",
      workingDirectory: "/work/poller",
    });
    const published = await publishArtifact(worker, "dispatch-poll-pub-1");
    const projectId = published.artifact.projectId;
    const thread = await createThread(
      worker,
      published,
      "The poll target annotation.",
    );

    const idleStartedAt = Date.now();
    const idle = await claimDispatch(worker, agent.id, 30);
    const idleElapsed = Date.now() - idleStartedAt;
    expect(idle.status).toBe(204);
    // Held for the full clamped cap: no early cutoff, no truncated response.
    expect(idleElapsed)
      .toBeGreaterThanOrEqual(maximumClaimWaitSeconds * 1_000 - 1_000);
    // And no longer than the cap plus generous runtime slack: an over-cap wait
    // is clamped to 25 s, never carried to the requested 30 s.
    expect(idleElapsed).toBeLessThan(30_000);

    const heldStartedAt = Date.now();
    const held = claimDispatch(worker, agent.id, maximumClaimWaitSeconds);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const late = (await readBody(
      await sendDispatch(worker, {
        agentId: agent.id,
        idempotencyKey: "dispatch-bundle-poll",
        projectId,
        threadIds: [thread],
      }),
      dispatchCreationSchema,
    )).dispatch;
    const answered = await held;
    const heldElapsed = Date.now() - heldStartedAt;
    expect(answered.status).toBe(200);
    expect((await readBody(answered, dispatchEnvelopeSchema)).dispatch.id)
      .toBe(late.id);
    // The bounded re-check answered inside the same wait, and the send that
    // arrived while the poll was held was served concurrently by the isolate.
    expect(heldElapsed).toBeGreaterThanOrEqual(1_500);
    expect(heldElapsed).toBeLessThan(maximumClaimWaitSeconds * 1_000);
  }, 180_000);

  it("upgrades a version 4 database in place and then accepts dispatches", async () => {
    const upgradeDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-dispatch-upgrade-"),
    );
    let upgradeWorker = await startWorker(upgradeDirectory);
    try {
      const published = await publishArtifact(
        upgradeWorker,
        "dispatch-upgrade-publish-1",
      );
      const preserved = await createThread(
        upgradeWorker,
        published,
        "Written before the dispatch upgrade.",
      );
      await upgradeWorker.stop();

      const d1File = await findD1DatabaseFile(upgradeDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP INDEX comment_threads_dispatch;
          ALTER TABLE comment_threads DROP COLUMN dispatch_id;
          DROP INDEX agent_dispatches_claim;
          DROP INDEX agent_dispatches_project_created;
          DROP TABLE agent_dispatches;
          DROP TABLE registered_agents;
          UPDATE artifact_server_schema SET version = 4 WHERE component = 'runtime';
        `);
      } finally {
        database.close();
      }

      upgradeWorker = await startWorker(upgradeDirectory);
      expect((await upgradeWorker.fetch(`${origin}/ready`)).status).toBe(200);

      const agent = await registerAgent(upgradeWorker, {
        connectionKey: "connection-key-upgrade",
        displayName: "upgraded",
        workingDirectory: "/work/upgraded",
      });
      const created = await readBody(
        await sendDispatch(upgradeWorker, {
          agentId: agent.id,
          idempotencyKey: "dispatch-after-upgrade",
          projectId: published.artifact.projectId,
          threadIds: [preserved],
        }),
        dispatchCreationSchema,
      );
      expect(created.dispatch.state).toBe("queued");
      expect(await listThreadIds(upgradeWorker, published)).toEqual([]);
      await upgradeWorker.stop();

      const upgraded = new DatabaseSync(d1File);
      try {
        expect(schemaVersionRowSchema.parse(upgraded.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(9);
        expect(z.array(tableColumnRowSchema)
          .parse(upgraded.prepare("PRAGMA table_info(comment_threads)").all())
          .map(({name}) => name)).toContain("dispatch_id");
        expect(z.array(tableNameRowSchema).parse(upgraded.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table'
            AND name IN ('agent_dispatches', 'registered_agents')
        `).all()).map(({name}) => name).toSorted())
          .toEqual(["agent_dispatches", "registered_agents"]);
      } finally {
        upgraded.close();
      }
    } finally {
      await upgradeWorker.stop();
      await rm(upgradeDirectory, {force: true, recursive: true});
    }
  }, 180_000);
});

/** Minutes between a claim and its lease expiry, as the wire reports them. */
function leaseMinutes(dispatch: z.infer<typeof dispatchSchema>): number {
  if (dispatch.claimedAt === null || dispatch.leaseExpiresAt === null) {
    throw new Error("The claimed dispatch carries no lease.");
  }
  return (new Date(dispatch.leaseExpiresAt).getTime() -
    new Date(dispatch.claimedAt).getTime()) / 60_000;
}

/** One authenticated call against the Worker under test. */
interface WorkerCall {
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly method?: string;
}

function request(
  target: Unstable_DevWorker,
  pathname: string,
  call: WorkerCall = {},
): Promise<WorkerResponse> {
  const credential = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const headers = call.idempotencyKey === undefined
    ? credential
    : {...credential, "Idempotency-Key": call.idempotencyKey};
  const method = call.method ?? "GET";
  return call.body === undefined
    ? target.fetch(`${origin}${pathname}`, {headers, method})
    : target.fetch(`${origin}${pathname}`, {body: call.body, headers, method});
}

/** Read one successful response body and parse it into its wire shape. */
async function readBody<Value>(
  response: WorkerResponse,
  schema: z.ZodType<Value>,
): Promise<Value> {
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`The route answered ${response.status}: ${text}`);
  }
  return schema.parse(JSON.parse(text));
}

/** Read one refused response body, which always carries an error code. */
async function readFailureCode(response: WorkerResponse): Promise<string> {
  return failureSchema.parse(JSON.parse(await response.text())).error.code;
}

async function registerAgent(
  target: Unstable_DevWorker,
  body: {
    readonly agentSessionId?: string;
    readonly connectionKey: string;
    readonly displayName: string;
    readonly workingDirectory: string;
  },
): Promise<z.infer<typeof agentSchema>> {
  const response = await request(target, "/api/v1/agents", {
    body: JSON.stringify({...body, kind: "pi"}),
    method: "POST",
  });
  return (await readBody(response, agentRegistrationSchema)).agent;
}

function claimDispatch(
  target: Unstable_DevWorker,
  agentId: string,
  waitSeconds?: number,
): Promise<WorkerResponse> {
  const query = waitSeconds === undefined ? "" : `?wait=${waitSeconds}`;
  return request(target, `/api/v1/agents/${agentId}/claims${query}`, {
    method: "POST",
  });
}

function sendDispatch(
  target: Unstable_DevWorker,
  input: {
    readonly agentId: string;
    readonly idempotencyKey: string;
    readonly note?: string;
    readonly projectId: string;
    readonly threadIds: readonly string[];
  },
): Promise<WorkerResponse> {
  const body = input.note === undefined
    ? {agentId: input.agentId, threadIds: [...input.threadIds]}
    : {
      agentId: input.agentId,
      note: input.note,
      threadIds: [...input.threadIds],
    };
  return request(
    target,
    `/api/v1/agent-dispatches?projectId=${input.projectId}`,
    {
      body: JSON.stringify(body),
      idempotencyKey: input.idempotencyKey,
      method: "POST",
    },
  );
}

function reportDelivered(
  target: Unstable_DevWorker,
  dispatchId: string,
  agentId: string,
): Promise<WorkerResponse> {
  return request(target, `/api/v1/agent-dispatches/${dispatchId}/delivered`, {
    body: JSON.stringify({agentId}),
    method: "POST",
  });
}

function reportFailed(
  target: Unstable_DevWorker,
  dispatchId: string,
  agentId: string,
  reason: string,
): Promise<WorkerResponse> {
  return request(target, `/api/v1/agent-dispatches/${dispatchId}/failed`, {
    body: JSON.stringify({agentId, reason}),
    method: "POST",
  });
}

function cancelDispatch(
  target: Unstable_DevWorker,
  dispatchId: string,
  projectId: string,
): Promise<WorkerResponse> {
  return request(
    target,
    `/api/v1/agent-dispatches/${dispatchId}/cancel?projectId=${projectId}`,
    {method: "POST"},
  );
}

async function getDispatch(
  target: Unstable_DevWorker,
  dispatchId: string,
  projectId: string,
): Promise<z.infer<typeof dispatchSchema>> {
  const response = await request(
    target,
    `/api/v1/agent-dispatches/${dispatchId}?projectId=${projectId}`,
  );
  return (await readBody(response, dispatchEnvelopeSchema)).dispatch;
}

async function listDispatches(
  target: Unstable_DevWorker,
  projectId: string,
  query = "",
): Promise<z.infer<typeof dispatchPageSchema>> {
  const response = await request(
    target,
    `/api/v1/agent-dispatches?projectId=${projectId}${query}`,
  );
  return readBody(response, dispatchPageSchema);
}

async function listThreadIds(
  target: Unstable_DevWorker,
  published: z.infer<typeof publicationSchema>,
  dispatched?: "exclude" | "include" | "only",
): Promise<readonly string[]> {
  const filter = dispatched === undefined ? "" : `&dispatched=${dispatched}`;
  const response = await request(
    target,
    `/api/v1/artifacts/${published.artifact.id}/comments` +
      `?projectId=${published.artifact.projectId}&limit=50${filter}`,
  );
  return (await readBody(response, threadPageSchema)).items.map(({id}) => id);
}

async function createThread(
  target: Unstable_DevWorker,
  published: z.infer<typeof publicationSchema>,
  body: string,
): Promise<string> {
  const key = createHash("sha256").update(body).digest("hex").slice(0, 20);
  const response = await request(
    target,
    `/api/v1/artifacts/${published.artifact.id}` +
      `/versions/${published.version.id}/comments` +
      `?projectId=${published.artifact.projectId}`,
    {body: JSON.stringify({body}), idempotencyKey: `thread-${key}`, method: "POST"},
  );
  return (await readBody(response, threadCreationSchema)).thread.id;
}

async function setThreadState(
  target: Unstable_DevWorker,
  published: z.infer<typeof publicationSchema>,
  threadId: string,
  state: "open" | "resolved",
): Promise<void> {
  const response = await request(
    target,
    `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
      `?projectId=${published.artifact.projectId}`,
    {body: JSON.stringify({state}), method: "PATCH"},
  );
  expect(response.status).toBe(200);
}

function resolveThread(
  target: Unstable_DevWorker,
  published: z.infer<typeof publicationSchema>,
  threadId: string,
): Promise<void> {
  return setThreadState(target, published, threadId, "resolved");
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries.find((entry) =>
    entry.isFile() && entry.name.endsWith(".sqlite") &&
    entry.parentPath.includes("D1")
  );
  if (found === undefined) {
    throw new Error("The Worker did not persist a local D1 database file.");
  }
  return join(found.parentPath, found.name);
}

async function publishArtifact(
  target: Unstable_DevWorker,
  idempotencyKey: string,
): Promise<z.infer<typeof publicationSchema>> {
  const bytes = new TextEncoder().encode("<h1>Dispatch target</h1>");
  const createUpload = await request(target, "/api/v1/uploads", {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    method: "POST",
  });
  const uploadPlan = await readBody(createUpload, uploadPlanSchema);
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await target.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${apiToken}`},
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  const committed = await target.fetch(uploadPlan.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Dispatch target",
      tags: [],
    }}),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
  return readBody(committed, publicationSchema);
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: installationId,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-dispatch-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
