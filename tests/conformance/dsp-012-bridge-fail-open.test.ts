import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ApiClient,
  agentListSchema,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  type BridgeHandle,
  type BridgeTimers,
  dormantNotice,
  type FollowUpDelivery,
  initialBackoffMilliseconds,
  maximumBackoffMilliseconds,
  type HostPort,
  startBridge,
  type StartBridgeOptions,
} from "@plannotator/agent-bridge";

/** A scripted Pi that records notices and messages, and can turn hostile. */
class RecordingHostPort implements HostPort {
  compacting = false;
  sendResult: Promise<void> | null = null;
  sendThrows: Error | null = null;
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];
  readonly notices: string[] = [];

  isCompacting(): boolean {
    return this.compacting;
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  sendUserMessage(
    text: string,
    delivery: FollowUpDelivery,
  ): void | Promise<void> {
    if (this.sendThrows !== null) throw this.sendThrows;
    this.messages.push({delivery, text});
    const result = this.sendResult;
    this.sendResult = null;
    return result ?? undefined;
  }
}

/** Observable network traffic: counts calls through to the real fetch. */
interface CountedTraffic {
  readonly count: () => number;
  readonly fetch: typeof fetch;
}

function countingFetch(): CountedTraffic {
  let calls = 0;
  const counted: typeof fetch = (input, init) => {
    calls += 1;
    return fetch(input, init);
  };
  return {count: () => calls, fetch: counted};
}

async function eventually<Value>(
  probe: () => Promise<Value | null>,
  timeoutMilliseconds = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error("The awaited condition was not reached in time.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("bridge fail-open discipline", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let bridges: BridgeHandle[];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>FailOpen</title>",
      idempotencyKey: "bridge-fail-open-publish-artifact",
      name: "Fail-open report",
    })).body;
    projectId = published.artifact.projectId;
    bridges = [];
  });

  afterEach(async () => {
    for (const bridge of bridges) {
      // eslint-disable-next-line no-await-in-loop
      await bridge.stop();
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  function startTracked(options: StartBridgeOptions): BridgeHandle {
    const bridge = startBridge(options);
    bridges.push(bridge);
    return bridge;
  }

  function bridgeOptions(
    port: HostPort,
    fetchImplementation: typeof fetch,
    displayName: string,
  ): StartBridgeOptions {
    return {
      agentSessionId: "pi-session-fail-open",
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName,
      fetchImplementation,
      host: port,
      hostname: "fail-open-host",
      kind: "pi",
      waitSeconds: 1,
      workingDirectory: `/work/${displayName}`,
    };
  }

  test("DSP-012-B: without configuration one notice and no polling; configured, it registers, claims, holds through compaction, reports delivery, and shuts down cleanly", async () => {
    expect.hasAssertions();

    // Dormant: no origin or credential resolved.
    const dormantPort = new RecordingHostPort();
    const dormantTraffic = countingFetch();
    const dormant = startTracked({
      agentSessionId: null,
      credentials: null,
      displayName: "dormant",
      fetchImplementation: dormantTraffic.fetch,
      host: dormantPort,
      hostname: "fail-open-host",
      kind: "pi",
      waitSeconds: 1,
      workingDirectory: "/work/dormant",
    });
    expect(dormant.dormant).toBe(true);
    expect(dormantPort.notices).toEqual([dormantNotice]);
    await pause(300);
    expect(dormantTraffic.count()).toBe(0);
    expect(dormantPort.messages).toHaveLength(0);
    await dormant.stop();

    // Configured: registration, claim, compaction hold, delivery, shutdown.
    const port = new RecordingHostPort();
    port.compacting = true;
    const traffic = countingFetch();
    const bridge = startTracked(bridgeOptions(port, traffic.fetch, "live"));
    const agentId = await eventually(async () => {
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      const listed = agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "live");
      return listed === undefined ? null : listed.id;
    });
    expect(bridge.agentId()).toBe(agentId);

    const thread = await client.openThread(
      published,
      "Adjust the heading.",
      "bridge-fail-open-thread-live",
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-fail-open-dispatch-live",
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // The claim happens, but delivery holds while the session compacts.
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const current = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch;
      return current.state === "claimed" ? true : null;
    });
    await pause(600);
    expect(port.messages).toHaveLength(0);

    port.compacting = false;
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const current = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch;
      return current.state === "delivered" ? true : null;
    });
    expect(port.messages).toHaveLength(1);

    // Clean shutdown: the loop stops polling and the row is disconnected.
    await bridge.stop();
    const afterStop = await client.listAgents();
    const listedAfter = agentListSchema.parse(await afterStop.json()).items
      .find((item) => item.id === agentId);
    expect(listedAfter).toBeUndefined();
    const settledCount = traffic.count();
    await pause(1_500);
    expect(traffic.count()).toBe(settledCount);
  });

  test("DSP-013-B: delivery waits for host admission, an asynchronous refusal fails only that dispatch, and the loop accepts the next bundle", async () => {
    expect.hasAssertions();
    const port = new RecordingHostPort();
    const firstHandoff = Promise.withResolvers<void>();
    port.sendResult = firstHandoff.promise;
    startTracked(bridgeOptions(port, fetch, "truthful-delivery"));
    const agentId = await eventually(async () => {
      const response = await client.listAgents();
      const listed = agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "truthful-delivery");
      return listed === undefined ? null : listed.id;
    });
    const firstThread = await client.openThread(
      published,
      "Reject this handoff.",
      "bridge-truthful-delivery-thread-rejected",
    );
    const firstSent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-truthful-delivery-dispatch-rejected",
      projectId,
      threadIds: [firstThread.id],
    });
    const firstDispatchId = dispatchCreationSchema.parse(await firstSent.json())
      .dispatch.id;

    await eventually(() =>
      Promise.resolve(port.messages.length === 1 ? true : null)
    );
    const awaitingAdmission = await client.getDispatch(
      firstDispatchId,
      projectId,
    );
    expect(
      dispatchEnvelopeSchema.parse(await awaitingAdmission.json()).dispatch
        .state,
    ).toBe("claimed");
    firstHandoff.reject(new Error("The host refused the message."));
    await eventually(async () => {
      const response = await client.getDispatch(firstDispatchId, projectId);
      return dispatchEnvelopeSchema.parse(await response.json()).dispatch
        .state === "failed" ? true : null;
    });
    expect(await client.listThreadIds(published)).toEqual([firstThread.id]);

    const secondThread = await client.openThread(
      published,
      "Accept this handoff.",
      "bridge-truthful-delivery-thread-accepted",
    );
    const secondSent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-truthful-delivery-dispatch-accepted",
      projectId,
      threadIds: [secondThread.id],
    });
    const secondDispatchId = dispatchCreationSchema.parse(
      await secondSent.json(),
    ).dispatch.id;
    await eventually(async () => {
      const response = await client.getDispatch(secondDispatchId, projectId);
      return dispatchEnvelopeSchema.parse(await response.json()).dispatch
        .state === "delivered" ? true : null;
    });
    expect(port.messages).toHaveLength(2);
    expect(port.messages[1]?.text).toContain(secondThread.id);
  });

  test("DSP-012-F: an unreachable backend backs off within bounds and a stale host handle ends the loop, with no error reaching the host", async () => {
    expect.hasAssertions();

    // Backend down: bounded, capped backoff and a clean stop, no throw.
    const deadPort = await reserveLoopbackPort();
    const sleeps: number[] = [];
    const instantTimers: BridgeTimers = {
      random: () => 0.5,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    };
    const unreachablePort = new RecordingHostPort();
    const unreachable = startTracked({
      agentSessionId: null,
      credentials: {
        origin: `http://127.0.0.1:${deadPort}`,
        token: "an-irrelevant-credential-value",
      },
      displayName: "unreachable",
      fetchImplementation: fetch,
      host: unreachablePort,
      hostname: "fail-open-host",
      kind: "pi",
      timers: instantTimers,
      waitSeconds: 1,
      workingDirectory: "/work/unreachable",
    });
    await eventually(() => Promise.resolve(sleeps.length >= 8 ? true : null));
    await unreachable.stop();
    expect(sleeps.length).toBeGreaterThanOrEqual(8);
    for (const slept of sleeps) {
      expect(slept).toBeGreaterThanOrEqual(initialBackoffMilliseconds);
      expect(slept).toBeLessThanOrEqual(maximumBackoffMilliseconds);
    }
    expect(Math.max(...sleeps)).toBe(maximumBackoffMilliseconds);
    expect(unreachablePort.messages).toHaveLength(0);

    // Stale handle: a throwing port ends the loop before any delivery report.
    const stalePort = new RecordingHostPort();
    stalePort.sendThrows = new Error(
      "This extension ctx is stale after session replacement or reload",
    );
    const traffic = countingFetch();
    startTracked(bridgeOptions(stalePort, traffic.fetch, "stale"));
    const agentId = await eventually(async () => {
      const response = await client.listAgents();
      const listed = agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "stale");
      return listed === undefined ? null : listed.id;
    });
    const thread = await client.openThread(
      published,
      "Tighten the footer.",
      "bridge-fail-open-thread-stale",
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-fail-open-dispatch-stale",
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // The claim lands, the injection throws, and the loop ends silently:
    // the dispatch is never reported delivered and polling stops.
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const current = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch;
      return current.state === "claimed" ? true : null;
    });
    await pause(500);
    const settledCount = traffic.count();
    await pause(1_500);
    expect(traffic.count()).toBe(settledCount);
    const answer = await client.getDispatch(dispatchId, projectId);
    const final = dispatchEnvelopeSchema.parse(await answer.json()).dispatch;
    expect(final.state).toBe("claimed");
    expect(stalePort.messages).toHaveLength(0);
  });
});
