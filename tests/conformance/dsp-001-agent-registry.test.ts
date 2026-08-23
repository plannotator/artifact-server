import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  dispatchPageSchema,
  failureSchema,
  issueApiKey,
  MutableClock,
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

const connectedWindowMilliseconds = 90 * 1_000;
const retentionMilliseconds = 7 * 24 * 60 * 60 * 1_000;

describe("registered agent registry", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let agents: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    agents = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Registry</title>",
      idempotencyKey: "dispatch-registry-publish-artifact",
      name: "Registry report",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-001-B: one connection key upserts one self-named agent whose connected state follows its claim polling", async () => {
    expect.hasAssertions();
    const registered = await agents.registerAgent({
      agentSessionId: "pi-session-one",
      connectionKey: "sha256-host-and-working-directory",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    expect(registered).toMatchObject({
      agentSessionId: "pi-session-one",
      connectionKey: "sha256-host-and-working-directory",
      displayName: "site",
      kind: "pi",
      principalId: "local-api-token",
      workingDirectory: "/work/site",
    });
    expect(registered.lastSeenAt).toBe(registered.createdAt);

    const afterRegistration = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterRegistration.items).toEqual([
      {...registered, connected: true},
    ]);

    // Liveness is derived, not stored: the row stays listed and simply stops
    // reading as connected once its last claim poll falls out of the window.
    clock.advance(connectedWindowMilliseconds + 1_000);
    const afterSilence = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterSilence.items).toEqual([{...registered, connected: false}]);

    // The claim poll is the heartbeat, so an empty poll restores liveness.
    const emptyPoll = await agents.claim(registered.id);
    expect(emptyPoll.status).toBe(204);
    const afterPolling = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterPolling.items).toEqual([{
      ...registered,
      connected: true,
      lastSeenAt: clock.now().toISOString(),
    }]);

    // One held poll is one heartbeat: the request stamps lastSeenAt when it
    // arrives, and the bounded re-checks inside the same held request write
    // nothing while the mailbox stays empty — probed mid-poll and after it.
    const heartbeatStamp = clock.now().toISOString();
    const heldPoll = agents.claim(registered.id, 3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    clock.advance(45_000);
    const duringHeldPoll = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(duringHeldPoll.items).toEqual([{
      ...registered,
      connected: true,
      lastSeenAt: heartbeatStamp,
    }]);
    expect((await heldPoll).status).toBe(204);
    const afterHeldPoll = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterHeldPoll.items).toEqual([{
      ...registered,
      connected: true,
      lastSeenAt: heartbeatStamp,
    }]);

    const thread = await agents.openThread(
      published,
      "The registry heading is wrong.",
      "dispatch-registry-thread-one",
    );
    const created = dispatchCreationSchema.parse(
      await (await agents.sendDispatch({
        agentId: registered.id,
        idempotencyKey: "dispatch-registry-send-before-restart",
        projectId: published.artifact.projectId,
        threadIds: [thread.id],
      })).json(),
    );
    expect(created.dispatch.state).toBe("queued");

    // A restart re-registers under the same connection key: one row, the same
    // id, a refreshed name and session, and the queued dispatch still waiting.
    clock.advance(60_000);
    const reRegistered = await agents.registerAgent({
      agentSessionId: "pi-session-two",
      connectionKey: "sha256-host-and-working-directory",
      displayName: "site (renamed)",
      workingDirectory: "/work/site",
    });
    expect(reRegistered).toMatchObject({
      agentSessionId: "pi-session-two",
      createdAt: registered.createdAt,
      displayName: "site (renamed)",
      id: registered.id,
    });
    const afterRestart = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterRestart.items).toEqual([{...reRegistered, connected: true}]);

    const claimed = await agents.claim(registered.id);
    expect(claimed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await claimed.json()).dispatch)
      .toMatchObject({
        agentId: registered.id,
        id: created.dispatch.id,
        state: "claimed",
      });
  });

  test("DSP-001-F: reaping a stale agent row leaves its dispatch attributed, and another installation's agent never appears", async () => {
    expect.hasAssertions();
    const registered = await agents.registerAgent({
      agentSessionId: "pi-session-local",
      connectionKey: "shared-connection-key-across-installations",
      displayName: "site",
      workingDirectory: "/work/site",
    });

    const foreignInstallation = await createTestInstallation();
    const foreignServer = await startTestServer(foreignInstallation);
    try {
      const foreignAgents = new ApiClient(
        foreignServer,
        foreignInstallation.apiToken,
      );
      const foreign = await foreignAgents.registerAgent({
        agentSessionId: "pi-session-foreign",
        connectionKey: "shared-connection-key-across-installations",
        displayName: "site",
        workingDirectory: "/work/site",
      });
      expect(foreign.id).not.toBe(registered.id);
      const listedHere = agentListSchema.parse(
        await (await agents.listAgents()).json(),
      );
      expect(listedHere.items.map((entry) => entry.id))
        .toEqual([registered.id]);
      const listedThere = agentListSchema.parse(
        await (await foreignAgents.listAgents()).json(),
      );
      expect(listedThere.items.map((entry) => entry.id)).toEqual([foreign.id]);
    } finally {
      await foreignServer.stop();
      await removeTestInstallation(foreignInstallation);
    }

    const thread = await agents.openThread(
      published,
      "The registry footer link is broken.",
      "dispatch-registry-thread-reaped",
    );
    const created = dispatchCreationSchema.parse(
      await (await agents.sendDispatch({
        agentId: registered.id,
        idempotencyKey: "dispatch-registry-send-before-reaping",
        note: "Fix this before the review.",
        projectId: published.artifact.projectId,
        threadIds: [thread.id],
      })).json(),
    );
    const claimed = await agents.claim(registered.id);
    expect(claimed.status).toBe(200);
    const delivered = await agents.reportDelivered(
      created.dispatch.id,
      registered.id,
    );
    expect(delivered.status).toBe(200);

    // The agent row is disposable: silence past the retention window deletes
    // it on the next listing read.
    clock.advance(retentionMilliseconds + 60_000);
    const afterReaping = agentListSchema.parse(
      await (await agents.listAgents()).json(),
    );
    expect(afterReaping.items).toEqual([]);

    // The dispatch is the durable record and keeps the snapshotted name.
    const page = dispatchPageSchema.parse(
      await (await agents.listDispatches(published.artifact.projectId)).json(),
    );
    expect(page.items).toEqual([expect.objectContaining({
      agentDisplayName: "site",
      agentId: registered.id,
      id: created.dispatch.id,
      note: "Fix this before the review.",
      state: "delivered",
      threadIds: [thread.id],
    })]);
    const read = await agents.getDispatch(
      created.dispatch.id,
      published.artifact.projectId,
    );
    expect(read.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await read.json()).dispatch)
      .toMatchObject({
        agentDisplayName: "site",
        deliveredAt: created.dispatch.createdAt,
        state: "delivered",
      });

    // The connection key is scoped to the principal that registered it. A
    // second agent-connect principal presenting the same key registers its
    // own agent; it never reclaims the first row, and the bundle queued for
    // that row stays claimable only by the principal that registered it.
    const administrator = await signInAdministrator(server, installation);
    const owner = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Owner bridge"),
    );
    const other = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Other bridge"),
    );
    const owned = await owner.registerAgent({
      connectionKey: "shared-connection-key-across-principals",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const queuedThread = await agents.openThread(
      published,
      "The registry sidebar is stale.",
      "dispatch-registry-thread-scoped-key",
    );
    const queued = dispatchCreationSchema.parse(
      await (await agents.sendDispatch({
        agentId: owned.id,
        idempotencyKey: "dispatch-registry-send-before-takeover",
        projectId: published.artifact.projectId,
        threadIds: [queuedThread.id],
      })).json(),
    );
    const impostor = await other.registerAgent({
      connectionKey: "shared-connection-key-across-principals",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    expect(impostor.id).not.toBe(owned.id);
    expect(impostor.principalId).not.toBe(owned.principalId);
    const takeover = await other.claim(owned.id);
    expect(takeover.status).toBe(403);
    expect(failureSchema.parse(await takeover.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await other.claim(impostor.id)).status).toBe(204);
    const ownerClaim = await owner.claim(owned.id);
    expect(ownerClaim.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await ownerClaim.json()).dispatch.id)
      .toBe(queued.dispatch.id);
  });
});
