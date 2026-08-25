import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {
  agentListSchema,
  ApiClient,
  failureSchema,
  issueApiKey,
  signInAdministrator,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const memberCredential = "beacon-authority-admitted-member";
const fabricatedAgentId = "agt_00000000-0000-4000-8000-000000000000";

describe("activity beacon authority", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let directory: ApiClient;
  let owner: ApiClient;
  let stranger: ApiClient;
  let human: ApiClient;
  let agent: RegisteredAgent;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: memberVerifier,
    });
    directory = new ApiClient(server, installation.apiToken);
    const administrator = await signInAdministrator(server, installation);
    owner = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["agent:connect"],
        "Beacon owner bridge",
      ),
    );
    stranger = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["agent:connect"],
        "Beacon stranger bridge",
      ),
    );
    human = new ApiClient(server, memberCredential);
    agent = await owner.registerAgent({
      agentSessionId: "pi-session-beacon-authority",
      connectionKey: "beacon-authority-connection",
      displayName: "owned",
      workingDirectory: "/work/owned",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRS-003-B: an agent principal beacons its own agent and the finer state surfaces", async () => {
    expect.hasAssertions();
    const accepted = await beacon(owner, agent.id, "thinking");
    expect(accepted.status).toBe(204);
    const listing = await directory.listAgents();
    expect(listing.status).toBe(200);
    const listed = agentListSchema.parse(await listing.json());
    expect(listed.items.find((entry) => entry.id === agent.id))
      .toMatchObject({activity: "working", beacon: "thinking"});
  });

  test("PRS-003-F: another principal's beacon answers the same 404 as a missing agent and records nothing, and a direct human is refused outright", async () => {
    expect.hasAssertions();
    // A foreign agent id and a fabricated one must be indistinguishable, so
    // the beacon route discloses nothing about other principals' bridges.
    const foreign = await beacon(stranger, agent.id, "replying");
    expect(foreign.status).toBe(404);
    const foreignFailure = failureSchema.parse(await foreign.json());
    expect(foreignFailure.error.code).toBe("AGENT_NOT_FOUND");
    const missing = await beacon(stranger, fabricatedAgentId, "replying");
    expect(missing.status).toBe(404);
    expect(failureSchema.parse(await missing.json())).toEqual(foreignFailure);

    const humanAttempt = await beacon(human, agent.id, "replying");
    expect(humanAttempt.status).toBe(403);
    expect(failureSchema.parse(await humanAttempt.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");

    // None of the refused writes decorated the agent.
    const listing = await directory.listAgents();
    expect(listing.status).toBe(200);
    const listed = agentListSchema.parse(await listing.json());
    expect(listed.items.find((entry) => entry.id === agent.id))
      .toMatchObject({activity: "idle", beacon: null});
  });

});

function beacon(
  client: ApiClient,
  agentId: string,
  state: "replying" | "thinking",
): Promise<Response> {
  return client.fetch(`/api/v1/agents/${agentId}/activity`, {
    body: JSON.stringify({state}),
    method: "POST",
  });
}

const memberPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Priya Member",
  id: "member_beacon_authority",
  installationId: "local",
  kind: principalKinds.human,
  membershipRole: membershipRoles.member,
};

const memberVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === memberCredential
      ? Effect.succeed(memberPrincipal)
      : Effect.fail(new AuthenticationRequired({
        message: "The beacon authority credential is invalid.",
      })),
};
