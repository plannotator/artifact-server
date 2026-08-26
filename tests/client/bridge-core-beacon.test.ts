/**
 * The bridge's best-effort activity beacon: at most one beacon per state
 * transition, fired at the natural work boundaries (bundle accepted →
 * thinking, first reply → replying, work settled → idle) against a real
 * spawned server, and dropped silently — never disturbing delivery — when
 * the beacon transport fails.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  agentListSchema,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  ActivityBeacon,
  type BridgeHandle,
  createCommentOperations,
  type FollowUpDelivery,
  type HostPort,
  startBridge,
  ThreadLocationCache,
} from "@plannotator/agent-bridge";

/** A quiet fake host recording every notice and injected message. */
class RecordingHost implements HostPort {
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];
  readonly notices: string[] = [];

  isCompacting(): boolean {
    return false;
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    this.messages.push({delivery, text});
  }
}

const activityRoutePattern = /\/api\/v1\/agents\/[^/]+\/activity$/u;

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  return input instanceof Request ? input.url : input;
}

const beaconBodySchema = z.object({state: z.string()}).loose();

/** The beacon state named by one request body, or "malformed". */
function recordedState(body: BodyInit | null | undefined): string {
  const raw = z.string().safeParse(body);
  if (!raw.success) return "malformed";
  try {
    const parsed = beaconBodySchema.safeParse(JSON.parse(raw.data));
    return parsed.success ? parsed.data.state : "malformed";
  } catch {
    return "malformed";
  }
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

describe("bridge activity beacon", () => {
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
      content: "<!doctype html><title>Beacon</title>",
      idempotencyKey: "bridge-beacon-publish-artifact",
      name: "Beacon report",
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

  async function serverBeaconFor(
    agentId: string,
  ): Promise<{activity: string; beacon: string | null}> {
    const response = await client.listAgents();
    expect(response.status).toBe(200);
    const listed = agentListSchema.parse(await response.json()).items
      .find((item) => item.id === agentId);
    if (listed === undefined) {
      throw new Error(`Agent ${agentId} disappeared from the listing.`);
    }
    return {activity: listed.activity, beacon: listed.beacon};
  }

  test("beacons fire once each at bundle acceptance, first reply, and settled work", async () => {
    expect.hasAssertions();
    const first = await client.openThread(
      published,
      "Rename the heading.",
      "bridge-beacon-thread-first",
    );
    const second = await client.openThread(
      published,
      "Tighten the intro.",
      "bridge-beacon-thread-second",
    );

    // Record every beacon body at the injected fetch seam while the request
    // still travels to the real server.
    const beaconStates: string[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (init?.method === "POST" && activityRoutePattern.test(url)) {
        beaconStates.push(recordedState(init.body));
      }
      return fetch(input, init);
    };

    const host = new RecordingHost();
    const beacon = new ActivityBeacon();
    const locations = new ThreadLocationCache();
    const bridge = startBridge({
      agentSessionId: null,
      beacon,
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "beacon-host",
      fetchImplementation: recordingFetch,
      host,
      hostname: "beacon-host",
      kind: "pi",
      locations,
      waitSeconds: 1,
      workingDirectory: "/work/beacon-host",
    });
    bridges.push(bridge);

    const agentId = await eventually(() =>
      Promise.resolve(bridge.agentId())
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-beacon-dispatch",
      projectId,
      threadIds: [first.id, second.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // Bundle accepted by the host → exactly one thinking beacon, visible on
    // the server's presence read.
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "delivered" ? true : null;
    });
    expect(host.messages).toHaveLength(1);
    await eventually(async () =>
      (await serverBeaconFor(agentId)).beacon === "thinking" ? true : null
    );
    expect(beaconStates).toEqual(["thinking"]);

    // First reply for the bundle → one replying beacon; the second reply and
    // the first resolve add none.
    const comments = createCommentOperations(
      {origin: server.baseUrl, token: installation.apiToken},
      recordingFetch,
      locations,
      beacon,
    );
    await comments.reply(first.id, "Renamed the heading.");
    await eventually(async () =>
      (await serverBeaconFor(agentId)).beacon === "replying" ? true : null
    );
    await comments.resolve(first.id);
    await comments.reply(second.id, "Tightened the intro.");
    expect(beaconStates).toEqual(["thinking", "replying"]);

    // Resolving the bundle's last thread settles the work → one idle beacon:
    // the server stops reporting a beacon well inside the 60 s decay window.
    await comments.resolve(second.id);
    expect(beaconStates).toEqual(["thinking", "replying", "idle"]);
    await eventually(async () => {
      const presence = await serverBeaconFor(agentId);
      return presence.beacon === null && presence.activity === "idle"
        ? true
        : null;
    });
  });

  test("a failing beacon transport never disturbs delivery, replies, or the host", async () => {
    expect.hasAssertions();
    const thread = await client.openThread(
      published,
      "Adjust the footer.",
      "bridge-beacon-failure-thread",
    );

    // Every beacon request dies on the wire; all other traffic is real.
    const beaconFailingFetch: typeof fetch = (input, init) =>
      init?.method === "POST" && activityRoutePattern.test(requestUrl(input))
        ? Promise.reject(new Error("The beacon transport is down."))
        : fetch(input, init);

    const host = new RecordingHost();
    const beacon = new ActivityBeacon();
    const locations = new ThreadLocationCache();
    const bridge = startBridge({
      agentSessionId: null,
      beacon,
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "beacon-blocked",
      fetchImplementation: beaconFailingFetch,
      host,
      hostname: "beacon-host",
      kind: "pi",
      locations,
      waitSeconds: 1,
      workingDirectory: "/work/beacon-blocked",
    });
    bridges.push(bridge);

    const agentId = await eventually(() =>
      Promise.resolve(bridge.agentId())
    );
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-beacon-failure-dispatch",
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // Delivery lands and is reported despite the dead beacon transport.
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "delivered" ? true : null;
    });
    expect(host.messages).toHaveLength(1);

    // Reply and resolve still succeed, closing the loop to addressed, and
    // the host saw only the one delivery notice — no beacon failure leaks.
    const comments = createCommentOperations(
      {origin: server.baseUrl, token: installation.apiToken},
      beaconFailingFetch,
      locations,
      beacon,
    );
    await comments.reply(thread.id, "Adjusted the footer.");
    await comments.resolve(thread.id);
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "addressed" ? true : null;
    });
    expect((await serverBeaconFor(agentId)).beacon).toBeNull();
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]).toContain("delivering");
  });
});
