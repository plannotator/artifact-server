import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  dispatchPageSchema,
  failureSchema,
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

const leaseMilliseconds = 5 * 60 * 1_000;

describe("dispatch claim lease", () => {
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
      content: "<!doctype html><title>Lease</title>",
      idempotencyKey: "dispatch-lease-publish-artifact",
      name: "Lease report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-lease",
      connectionKey: "dispatch-lease-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-006-B: an expired lease returns the bundle to the queue and the restarted agent claims it again", async () => {
    expect.hasAssertions();
    const threadId = await openThread("lease-behavior");
    const dispatchId = await queueBundle(threadId, "behavior");

    const claimed = dispatchEnvelopeSchema.parse(
      await (await client.claim(agent.id)).json(),
    ).dispatch;
    expect(claimed).toMatchObject({id: dispatchId, state: "claimed"});
    const firstClaimedAt = claimed.claimedAt;
    expect(claimed.leaseExpiresAt).toBe(
      new Date(clock.now().getTime() + leaseMilliseconds).toISOString(),
    );

    // The lease holds for its whole term: nothing reclaims it early.
    clock.advance(leaseMilliseconds - 1_000);
    expect((await client.claim(agent.id)).status).toBe(204);
    expect(await readDispatch(dispatchId)).toMatchObject({
      claimedAt: firstClaimedAt,
      state: "claimed",
    });

    // The claimer died without reporting: the lease expires and the next read
    // returns the bundle to the queue instead of losing the work.
    clock.advance(2_000);
    const reclaimable = await readDispatch(dispatchId);
    expect(reclaimable).toMatchObject({
      claimedAt: null,
      deliveredAt: null,
      failedAt: null,
      leaseExpiresAt: null,
      state: "queued",
    });
    const listed = dispatchPageSchema.parse(
      await (await client.listDispatches(projectId, "&state=queued")).json(),
    );
    expect(listed.items.map((dispatch) => dispatch.id)).toEqual([dispatchId]);
    // A queued redelivery is still a live send: the thread stays off screen.
    expect(await client.listThreadIds(published)).toEqual([]);

    // The agent restarts under the same connection key and claims it again.
    const restarted = await client.registerAgent({
      agentSessionId: "pi-session-lease-restarted",
      connectionKey: "dispatch-lease-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    expect(restarted.id).toBe(agent.id);
    const redelivered = dispatchEnvelopeSchema.parse(
      await (await client.claim(restarted.id)).json(),
    ).dispatch;
    expect(redelivered).toMatchObject({id: dispatchId, state: "claimed"});
    expect(redelivered.claimedAt).toBe(clock.now().toISOString());
    expect(redelivered.leaseExpiresAt).toBe(
      new Date(clock.now().getTime() + leaseMilliseconds).toISOString(),
    );

    // Redelivered exactly once in effect: the report completes it and no
    // further poll hands the same bundle out again.
    expect((await client.reportDelivered(dispatchId, agent.id)).status)
      .toBe(200);
    clock.advance(leaseMilliseconds + 60_000);
    expect((await client.claim(agent.id)).status).toBe(204);
    expect(await readDispatch(dispatchId)).toMatchObject({state: "delivered"});
  });

  test("DSP-006-F: a claimer that returns after its lease expired cannot report, and a reclaim never leaves two claims active", async () => {
    expect.hasAssertions();
    const threadId = await openThread("lease-failure");
    const dispatchId = await queueBundle(threadId, "failure");

    expect((await client.claim(agent.id)).status).toBe(200);
    clock.advance(leaseMilliseconds + 1_000);
    expect(await readDispatch(dispatchId)).toMatchObject({state: "queued"});

    // The stale claimer comes back and reports on a bundle it no longer holds.
    const lateDelivery = await client.reportDelivered(dispatchId, agent.id);
    expect(lateDelivery.status).toBe(409);
    expect(failureSchema.parse(await lateDelivery.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    const lateFailure = await client.reportFailed(
      dispatchId,
      agent.id,
      "A stale claimer must not close this bundle.",
    );
    expect(lateFailure.status).toBe(409);
    expect(failureSchema.parse(await lateFailure.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    expect(await readDispatch(dispatchId)).toMatchObject({
      deliveredAt: null,
      failedAt: null,
      failureReason: null,
      state: "queued",
    });

    // Two polls racing over the reclaim: one claim, never two.
    const [raceOne, raceTwo] = await Promise.all([
      client.claim(agent.id),
      client.claim(agent.id),
    ]);
    expect([raceOne.status, raceTwo.status].toSorted((left, right) =>
      left - right
    )).toEqual([200, 204]);
    const winner = raceOne.status === 200 ? raceOne : raceTwo;
    const reclaimed = dispatchEnvelopeSchema.parse(await winner.json())
      .dispatch;
    expect(reclaimed).toMatchObject({id: dispatchId, state: "claimed"});
    expect((await client.claim(agent.id)).status).toBe(204);

    // The reclaiming poll owns the only active claim, and it can report.
    expect((await client.reportDelivered(dispatchId, agent.id)).status)
      .toBe(200);
    const afterDelivery = await readDispatch(dispatchId);
    expect(afterDelivery).toMatchObject({state: "delivered"});
    expect(afterDelivery.claimedAt).toBe(reclaimed.claimedAt);
    expect(Date.parse(afterDelivery.deliveredAt ?? ""))
      .toBeGreaterThanOrEqual(Date.parse(reclaimed.claimedAt ?? ""));
  });

  async function openThread(label: string): Promise<string> {
    const thread = await client.openThread(
      published,
      `An annotation sent under the ${label} lease.`,
      `dispatch-lease-thread-${label}`,
    );
    return thread.id;
  }

  async function queueBundle(
    threadId: string,
    label: string,
  ): Promise<string> {
    const response = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: `dispatch-lease-send-bundle-${label}`,
      projectId,
      threadIds: [threadId],
    });
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }

  async function readDispatch(dispatchId: string) {
    const response = await client.getDispatch(dispatchId, projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
  }
});
