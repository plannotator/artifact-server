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

const leaseMilliseconds = 5 * 60 * 1_000;

describe("dispatch claim order", () => {
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
      content: "<!doctype html><title>Queue</title>",
      idempotencyKey: "dispatch-claim-publish-artifact",
      name: "Queue report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-queue",
      connectionKey: "dispatch-claim-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-005-B: three queued bundles are claimed oldest first, one at a time, and a waiting poll answers inside its bound", async () => {
    expect.hasAssertions();
    const first = await queueBundle("first");
    const second = await queueBundle("second");
    const third = await queueBundle("third");

    const claimedInOrder = [
      await claimAndReport(),
      await claimAndReport(),
      await claimAndReport(),
    ];
    expect(claimedInOrder).toEqual([first, second, third]);

    // An empty mailbox answers empty at the requested bound, not later.
    const emptyStartedAt = Date.now();
    const empty = await client.claim(agent.id, 1);
    const emptyElapsed = Date.now() - emptyStartedAt;
    expect(empty.status).toBe(204);
    expect(emptyElapsed).toBeGreaterThanOrEqual(900);
    expect(emptyElapsed).toBeLessThan(5_000);

    // A bundle sent while the poll is held is answered inside the same wait.
    const heldStartedAt = Date.now();
    const held = client.claim(agent.id, 8);
    await new Promise((resolve) => setTimeout(resolve, 250));
    clock.advance(5_000);
    const late = await queueBundle("late");
    const answered = await held;
    const heldElapsed = Date.now() - heldStartedAt;
    expect(answered.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await answered.json()).dispatch.id)
      .toBe(late);
    expect(heldElapsed).toBeLessThan(8_000);
    // The re-check that claimed the late bundle refreshed liveness with it:
    // a successful claim always carries the heartbeat.
    const afterHeldClaim = agentListSchema.parse(
      await (await client.listAgents()).json(),
    );
    expect(afterHeldClaim.items.map(({id, lastSeenAt}) => ({id, lastSeenAt})))
      .toEqual([{id: agent.id, lastSeenAt: clock.now().toISOString()}]);
  });

  test("DSP-005-F: a second claim while one is held answers empty, and simultaneous claims never hand one bundle to two agents", async () => {
    expect.hasAssertions();
    const other = await client.registerAgent({
      agentSessionId: "pi-session-other",
      connectionKey: "dispatch-claim-other-connection-key",
      displayName: "other",
      workingDirectory: "/work/other",
    });
    const held = await queueBundle("held");
    const waiting = await queueBundle("waiting");

    const firstClaim = await client.claim(agent.id);
    expect(firstClaim.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await firstClaim.json()).dispatch.id)
      .toBe(held);

    // The one-active-claim rule holds even across a waiting poll.
    expect((await client.claim(agent.id)).status).toBe(204);
    expect((await client.claim(agent.id, 1)).status).toBe(204);

    // Another agent never receives a bundle addressed to this one.
    expect((await client.claim(other.id)).status).toBe(204);
    expect((await client.claim(other.id, 1)).status).toBe(204);

    expect((await client.reportDelivered(held, agent.id)).status).toBe(200);

    // Two polls landing together share one queued bundle: exactly one wins.
    const [raceOne, raceTwo] = await Promise.all([
      client.claim(agent.id),
      client.claim(agent.id),
    ]);
    expect([raceOne.status, raceTwo.status].toSorted((left, right) =>
      left - right
    )).toEqual([200, 204]);
    const winner = raceOne.status === 200 ? raceOne : raceTwo;
    expect(dispatchEnvelopeSchema.parse(await winner.json()).dispatch)
      .toMatchObject({agentId: agent.id, id: waiting, state: "claimed"});

    // The losing poll took nothing with it: the mailbox is empty and the
    // bundle is still held by the single winner.
    expect((await client.claim(agent.id)).status).toBe(204);
    expect((await client.claim(other.id)).status).toBe(204);
    const read = dispatchEnvelopeSchema.parse(
      await (await client.getDispatch(waiting, projectId)).json(),
    ).dispatch;
    expect(read).toMatchObject({agentId: agent.id, state: "claimed"});
  });

  /**
   * Take the next bundle the mailbox hands over, prove nothing else can be
   * claimed while it is held, report it delivered, and answer with its id.
   */
  async function claimAndReport(): Promise<string> {
    const startedAt = Date.now();
    const claim = await client.claim(agent.id, 2);
    // Work already waiting is handed over immediately, not on a timer.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(claim.status).toBe(200);
    const dispatch = dispatchEnvelopeSchema.parse(await claim.json()).dispatch;
    expect(dispatch.state).toBe("claimed");
    expect(dispatch.claimedAt).toBe(clock.now().toISOString());
    expect(dispatch.leaseExpiresAt).toBe(
      new Date(clock.now().getTime() + leaseMilliseconds).toISOString(),
    );

    // One bundle at a time: the next one waits for this one's report.
    const whileHeld = await client.claim(agent.id);
    expect(whileHeld.status).toBe(204);

    const delivered = await client.reportDelivered(dispatch.id, agent.id);
    expect(delivered.status).toBe(200);
    clock.advance(1_000);
    return dispatch.id;
  }

  /** Send one bundle to the registered agent and answer with its id. */
  async function queueBundle(label: string): Promise<string> {
    const thread = await client.openThread(
      published,
      `An annotation queued in the ${label} bundle.`,
      `dispatch-claim-thread-${label}`,
    );
    const response = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: `dispatch-claim-send-bundle-${label}`,
      projectId,
      threadIds: [thread.id],
    });
    expect(response.status).toBe(201);
    // Distinct send times keep the queue's oldest-first order unambiguous.
    clock.advance(1_000);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }
});
