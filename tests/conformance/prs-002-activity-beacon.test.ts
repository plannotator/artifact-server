import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  ApiClient,
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

describe("agent activity beacon", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let agent: RegisteredAgent;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
    agent = await client.registerAgent({
      agentSessionId: "pi-session-beacon",
      connectionKey: "activity-beacon-connection",
      displayName: "beacon",
      workingDirectory: "/work/beacon",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRS-002-B: a fresh beacon reports working with its finer state, decays to the derived state after the 60 s TTL, and an idle beacon clears it at once", async () => {
    expect.hasAssertions();
    expect((await beacon("thinking")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activeDispatchId: null,
      activity: "working",
      beacon: "thinking",
      connected: true,
    });

    // A newer beacon overwrites the finer state in place.
    expect((await beacon("replying")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "working",
      beacon: "replying",
    });

    // Keep the heartbeat fresh without touching the beacon: an empty claim
    // poll bumps lastSeenAt, so only the beacon's own TTL is in play.
    clock.advance(30_000);
    expect((await client.claim(agent.id)).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "working",
      beacon: "replying",
    });

    // 61 s after the last beacon it is stale; the heartbeat (31 s) is not.
    // With no dispatch held, the derived state is idle.
    clock.advance(31_000);
    expect(await listAgent()).toMatchObject({
      activeDispatchId: null,
      activity: "idle",
      beacon: null,
      connected: true,
    });

    // An explicit idle beacon clears the finer state without waiting out
    // the TTL.
    expect((await beacon("thinking")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "working",
      beacon: "thinking",
    });
    expect((await beacon("idle")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "idle",
      beacon: null,
    });
  });

  test("PRS-002-F: a beacon from an agent whose heartbeat is stale is accepted with 204 but never surfaces in the listing", async () => {
    expect.hasAssertions();
    clock.advance(91_000);
    expect(await listAgent()).toMatchObject({
      activity: "disconnected",
      connected: false,
    });

    // Accepted best-effort — the write is not an error — yet the read side
    // refuses to decorate an agent the server cannot verify is alive.
    expect((await beacon("thinking")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "disconnected",
      beacon: null,
      connected: false,
    });

    clock.advance(10_000);
    expect((await beacon("replying")).status).toBe(204);
    expect(await listAgent()).toMatchObject({
      activity: "disconnected",
      beacon: null,
      connected: false,
    });
  });

  function beacon(state: "idle" | "replying" | "thinking"): Promise<Response> {
    return client.fetch(`/api/v1/agents/${agent.id}/activity`, {
      body: JSON.stringify({state}),
      method: "POST",
    });
  }

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
});
