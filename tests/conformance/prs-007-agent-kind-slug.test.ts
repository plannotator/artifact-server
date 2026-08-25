import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  agentRegistrationSchema,
  ApiClient,
  failureSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

describe("registered agent kind widening", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let agents: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    agents = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRS-007-B: any valid kind slug registers, round-trips through the listing, and the response carries protocol version 1", async () => {
    expect.hasAssertions();
    const response = await agents.fetch("/api/v1/agents", {
      body: JSON.stringify({
        connectionKey: "slug-widening-connection",
        displayName: "opencode session",
        kind: "opencode-v2",
        workingDirectory: "/work/opencode",
      }),
      method: "POST",
    });
    expect(response.status).toBe(200);
    const registration = agentRegistrationSchema.parse(await response.json());
    expect(registration.protocolVersion).toBe(1);
    expect(registration.agent.kind).toBe("opencode-v2");

    // The slug survives storage: the listing reads the same kind back.
    const listed = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(listed.items).toEqual([
      {
        ...registration.agent,
        activeDispatchId: null,
        activity: "idle",
        beacon: null,
        connected: true,
        lastActivityAt: registration.agent.createdAt,
      },
    ]);

    // The full 40-character shape is accepted, not just short names.
    const longest = `a${"b2-".repeat(13)}`;
    expect(longest).toHaveLength(40);
    const edge = await agents.registerAgent({
      connectionKey: "slug-widening-longest",
      displayName: "longest slug",
      kind: longest,
      workingDirectory: "/work/longest",
    });
    expect(edge.kind).toBe(longest);
  });

  test("PRS-007-F: a kind that is not a slug is refused with 422 and registers nothing", async () => {
    expect.hasAssertions();
    const invalidKinds = [
      "Pi", // no uppercase
      "-pi", // must start with a letter
      "1pi", // must start with a letter
      "pi_bridge", // no underscores
      "pi bridge", // no spaces
      "", // never empty
      `a${"b".repeat(40)}`, // 41 characters is past the cap
    ];
    const refusals = await Promise.all(invalidKinds.map(async (kind, index) => {
      const response = await agents.fetch("/api/v1/agents", {
        body: JSON.stringify({
          connectionKey: `slug-widening-invalid-${index}`,
          displayName: "refused agent",
          kind,
          workingDirectory: "/work/refused",
        }),
        method: "POST",
      });
      return {
        failure: failureSchema.parse(await response.json()),
        status: response.status,
      };
    }));
    for (const refusal of refusals) {
      expect(refusal.status).toBe(422);
      expect(refusal.failure.error.code).toBe("INVALID_DISPATCH");
    }
    const listed = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(listed.items).toEqual([]);
  });

  test("PRS-007: declared capabilities normalize to known keys, unknown keys are ignored, and an absent declaration defaults to the native tier", async () => {
    expect.hasAssertions();
    const declared = await agents.registerAgent({
      capabilities: {
        beacon: true,
        evidence: "mailbox",
        futureCapability: "ignored", // unknown keys are forward compatibility
      },
      connectionKey: "capability-declaring",
      displayName: "mailbox agent",
      kind: "mcp-mailbox",
      workingDirectory: "/work/mailbox",
    });
    expect(declared.capabilities).toEqual({beacon: true, evidence: "mailbox"});

    const undeclared = await agents.registerAgent({
      connectionKey: "capability-defaulting",
      displayName: "native bridge",
      workingDirectory: "/work/native",
    });
    expect(undeclared.capabilities).toEqual({beacon: false, evidence: "native"});

    // A partial declaration keeps its declared key and defaults the rest.
    const partial = await agents.registerAgent({
      capabilities: {beacon: true},
      connectionKey: "capability-partial",
      displayName: "beacon only",
      workingDirectory: "/work/beacon",
    });
    expect(partial.capabilities).toEqual({beacon: true, evidence: "native"});

    // The stored normalization round-trips through the listing unchanged.
    const listed = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(
      listed.items.map(({connectionKey, capabilities}) => ({
        capabilities,
        connectionKey,
      })),
    ).toEqual([
      {
        capabilities: {beacon: true, evidence: "mailbox"},
        connectionKey: "capability-declaring",
      },
      {
        capabilities: {beacon: false, evidence: "native"},
        connectionKey: "capability-defaulting",
      },
      {
        capabilities: {beacon: true, evidence: "native"},
        connectionKey: "capability-partial",
      },
    ]);

    // Re-registration replaces the stored capabilities rather than merging.
    const redeclared = await agents.registerAgent({
      capabilities: {evidence: "channel"},
      connectionKey: "capability-declaring",
      displayName: "mailbox agent",
      kind: "mcp-mailbox",
      workingDirectory: "/work/mailbox",
    });
    expect(redeclared.id).toBe(declared.id);
    expect(redeclared.capabilities).toEqual({
      beacon: false,
      evidence: "channel",
    });
  });
});
