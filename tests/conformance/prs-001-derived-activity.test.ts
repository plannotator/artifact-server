import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  MutableClock,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

describe("derived agent activity", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let agent: RegisteredAgent;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Derived activity</title>",
      idempotencyKey: "derived-activity-publish",
      name: "Derived activity report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-derived-activity",
      connectionKey: "derived-activity-connection",
      displayName: "derived",
      workingDirectory: "/work/derived",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRS-001-B: a fresh agent reads idle, a claimed bundle reads working with its dispatch id, and full resolution returns it to idle with the dispatch addressed", async () => {
    expect.hasAssertions();
    // No dispatch anywhere: the fresh heartbeat derives idle.
    expect(await listAgent()).toMatchObject({
      activeDispatchId: null,
      activity: "idle",
      beacon: null,
      connected: true,
      lastActivityAt: agent.lastSeenAt,
    });

    const first = await openThread("Sharpen the intro.", "b-one");
    const second = await openThread("Sharpen the outro.", "b-two");
    clock.advance(1_000);
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "derived-activity-send",
      projectId,
      threadIds: [first, second],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // A queued bundle is not yet the agent's work: still idle.
    expect(await listAgent()).toMatchObject({
      activeDispatchId: null,
      activity: "idle",
    });

    clock.advance(1_000);
    const claimTime = clock.now().toISOString();
    const claim = await client.claim(agent.id);
    expect(claim.status).toBe(200);
    expect(await listAgent()).toMatchObject({
      activeDispatchId: dispatchId,
      activity: "working",
      beacon: null,
      lastActivityAt: claimTime,
    });

    // The delivery report is a dispatch transition, not a heartbeat: the
    // derived lastActivityAt moves past lastSeenAt on its own.
    clock.advance(1_000);
    const deliveryTime = clock.now().toISOString();
    expect((await client.reportDelivered(dispatchId, agent.id)).status)
      .toBe(200);
    const delivered = await listAgent();
    expect(delivered).toMatchObject({
      activeDispatchId: dispatchId,
      activity: "working",
      lastActivityAt: deliveryTime,
    });
    expect(delivered.lastSeenAt).toBe(claimTime);

    // A half-resolved bundle still holds the agent working.
    clock.advance(1_000);
    expect((await client.setThreadState(published, first, "resolved")).status)
      .toBe(200);
    expect(await listAgent()).toMatchObject({
      activeDispatchId: dispatchId,
      activity: "working",
    });

    clock.advance(1_000);
    expect((await client.setThreadState(published, second, "resolved")).status)
      .toBe(200);
    expect(await listAgent()).toMatchObject({
      activeDispatchId: null,
      activity: "idle",
    });
    const read = await client.getDispatch(dispatchId, projectId);
    expect(read.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await read.json()).dispatch.state)
      .toBe("addressed");
  });

  test("PRS-001-F: a stale heartbeat reads disconnected while the agent still holds a claim, and repeated reads write no activity", async () => {
    expect.hasAssertions();
    const threadId = await openThread("Stale-heartbeat annotation.", "f-one");
    clock.advance(1_000);
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "derived-activity-send-stale",
      projectId,
      threadIds: [threadId],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;
    clock.advance(1_000);
    expect((await client.claim(agent.id)).status).toBe(200);

    // Past the 90 s liveness window the agent is disconnected even though
    // its claim lease is still running.
    clock.advance(91_000);
    const stale = await listAgent();
    expect(stale).toMatchObject({
      activity: "disconnected",
      beacon: null,
      connected: false,
    });
    const dispatch = await client.getDispatch(dispatchId, projectId);
    expect(dispatch.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await dispatch.json()).dispatch.state)
      .toBe("claimed");

    // Reads derive, never write: with the clock moving between listings the
    // stored heartbeat and derived activity timestamps stay exactly put.
    clock.advance(30_000);
    const reread = await listAgent();
    expect(reread.lastSeenAt).toBe(stale.lastSeenAt);
    expect(reread.lastActivityAt).toBe(stale.lastActivityAt);
    expect(reread.activity).toBe("disconnected");
    clock.advance(30_000);
    const third = await listAgent();
    expect(third.lastSeenAt).toBe(stale.lastSeenAt);
    expect(third.lastActivityAt).toBe(stale.lastActivityAt);
  });

  async function listAgent() {
    const response = await client.listAgents();
    expect(response.status).toBe(200);
    const listed = agentListSchema.parse(await response.json());
    const item = listed.items.find((entry) => entry.id === agent.id);
    if (item === undefined) {
      throw new Error("The registered agent vanished from the listing.");
    }
    return item;
  }

  async function openThread(body: string, key: string): Promise<string> {
    clock.advance(1_000);
    const thread = await client.openThread(
      published,
      body,
      `derived-activity-thread-${key}`,
    );
    return thread.id;
  }
});
