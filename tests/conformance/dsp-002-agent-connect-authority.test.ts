import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Principal} from "../../src/core/identity.js";
import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  failureSchema,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const memberCredential = "dispatch-authority-admitted-member";

describe("agent connection authority", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let sender: ApiClient;
  let published: PublishResponse;
  let agentKeyClient: ApiClient;
  let readOnlyClient: ApiClient;
  let memberClient: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: memberVerifier,
    });
    sender = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Authority</title>",
      idempotencyKey: "dispatch-authority-publish-artifact",
      name: "Authority report",
    })).body;
    const administrator = await signInAdministrator(server, installation);
    agentKeyClient = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["agent:connect"],
        "Pi bridge connection",
      ),
    );
    readOnlyClient = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["artifact:read"],
        "Read-only automation",
      ),
    );
    memberClient = new ApiClient(server, memberCredential);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-002-B: an agent-connect key and the local all-capability token register, claim, and report delivered and failed", async () => {
    expect.hasAssertions();
    await exerciseAgentPrincipal(agentKeyClient, "issued-key");
    await exerciseAgentPrincipal(sender, "local-token");
  });

  test("DSP-002-F: a read-only key and a direct human are refused every agent operation, and a report from a non-holder is a state conflict", async () => {
    expect.hasAssertions();
    const holder = await agentKeyClient.registerAgent({
      connectionKey: "dispatch-authority-holder",
      displayName: "holder",
      workingDirectory: "/work/holder",
    });
    const bystander = await agentKeyClient.registerAgent({
      connectionKey: "dispatch-authority-bystander",
      displayName: "bystander",
      workingDirectory: "/work/bystander",
    });
    const thread = await sender.openThread(
      published,
      "Only the claim holder may report on this bundle.",
      "dispatch-authority-thread-holder",
    );
    const created = dispatchCreationSchema.parse(
      await (await sender.sendDispatch({
        agentId: holder.id,
        idempotencyKey: "dispatch-authority-send-to-holder",
        projectId: published.artifact.projectId,
        threadIds: [thread.id],
      })).json(),
    );
    const claimed = await agentKeyClient.claim(holder.id);
    expect(claimed.status).toBe(200);

    await expectEveryAgentOperationDenied(readOnlyClient, holder.id, created.dispatch.id);
    await expectEveryAgentOperationDenied(memberClient, holder.id, created.dispatch.id);

    // The bundle is still held by the agent that claimed it, so a report that
    // names any other agent is a state conflict rather than a silent write.
    const wrongDelivery = await agentKeyClient.reportDelivered(
      created.dispatch.id,
      bystander.id,
    );
    expect(wrongDelivery.status).toBe(409);
    expect(failureSchema.parse(await wrongDelivery.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    const wrongFailure = await agentKeyClient.reportFailed(
      created.dispatch.id,
      bystander.id,
      "A bystander must not fail another agent's bundle.",
    );
    expect(wrongFailure.status).toBe(409);
    expect(failureSchema.parse(await wrongFailure.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");

    const stillHeld = dispatchEnvelopeSchema.parse(
      await (await sender.getDispatch(
        created.dispatch.id,
        published.artifact.projectId,
      )).json(),
    ).dispatch;
    expect(stillHeld).toMatchObject({
      agentId: holder.id,
      deliveredAt: null,
      failedAt: null,
      state: "claimed",
    });
    const rightfulDelivery = await agentKeyClient.reportDelivered(
      created.dispatch.id,
      holder.id,
    );
    expect(rightfulDelivery.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await rightfulDelivery.json()).dispatch)
      .toMatchObject({state: "delivered"});
  });

  /** Drive the whole agent-side contract with one agent-connect principal. */
  async function exerciseAgentPrincipal(
    client: ApiClient,
    label: string,
  ): Promise<void> {
    const agent = await client.registerAgent({
      agentSessionId: `pi-session-${label}`,
      connectionKey: `dispatch-authority-${label}`,
      displayName: label,
      workingDirectory: `/work/${label}`,
    });
    const deliveredDispatch = await queueBundle(agent.id, label, "delivered");
    const failedDispatch = await queueBundle(agent.id, label, "failed");

    const firstClaim = await client.claim(agent.id);
    expect(firstClaim.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await firstClaim.json()).dispatch.id)
      .toBe(deliveredDispatch);
    const delivered = await client.reportDelivered(deliveredDispatch, agent.id);
    expect(delivered.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await delivered.json()).dispatch)
      .toMatchObject({id: deliveredDispatch, state: "delivered"});

    const secondClaim = await client.claim(agent.id);
    expect(secondClaim.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await secondClaim.json()).dispatch.id)
      .toBe(failedDispatch);
    const failed = await client.reportFailed(
      failedDispatch,
      agent.id,
      "The working directory disappeared.",
    );
    expect(failed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await failed.json()).dispatch)
      .toMatchObject({
        failureReason: "The working directory disappeared.",
        id: failedDispatch,
        state: "failed",
      });

    const disconnected = await client.fetch(
      `/api/v1/agents/${agent.id}/disconnect`,
      {method: "POST"},
    );
    expect(disconnected.status).toBe(204);
  }

  /** Send one single-thread bundle to an agent and answer with its id. */
  async function queueBundle(
    agentId: string,
    label: string,
    suffix: string,
  ): Promise<string> {
    const thread = await sender.openThread(
      published,
      `A bundle for the ${label} principal to report ${suffix}.`,
      `dispatch-authority-thread-${label}-${suffix}`,
    );
    const response = await sender.sendDispatch({
      agentId,
      idempotencyKey: `dispatch-authority-send-${label}-${suffix}`,
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }

});

/** Every agent-side operation must refuse a principal without the capability. */
async function expectEveryAgentOperationDenied(
  client: ApiClient,
  agentId: string,
  dispatchId: string,
): Promise<void> {
  const denied = await Promise.all([
    client.fetch("/api/v1/agents", {
      body: JSON.stringify({
        connectionKey: "dispatch-authority-refused",
        displayName: "impostor",
        kind: "pi",
        workingDirectory: "/work/impostor",
      }),
      method: "POST",
    }),
    client.claim(agentId),
    client.reportDelivered(dispatchId, agentId),
    client.reportFailed(
      dispatchId,
      agentId,
      "A refused principal must not report a failure.",
    ),
    client.fetch(`/api/v1/agents/${agentId}/disconnect`, {method: "POST"}),
  ]);
  const codes = await Promise.all(denied.map(async (response) => ({
    code: failureSchema.parse(await response.json()).error.code,
    status: response.status,
  })));
  for (const outcome of codes) {
    expect(outcome).toEqual({code: "AUTHORIZATION_DENIED", status: 403});
  }
}

const memberPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Priya Member",
  id: "member_dispatch_authority",
  installationId: "local",
  kind: "human",
  membershipRole: "member",
};

const memberVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === memberCredential
      ? Effect.succeed(memberPrincipal)
      : Effect.fail(new AuthenticationRequired({
        message: "The external dispatch credential is invalid.",
      })),
};
