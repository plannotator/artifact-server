import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchPageSchema,
  failureSchema,
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

const maximumBundleSize = 100;

describe("agent dispatch send", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let agent: RegisteredAgent;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Send</title>",
      idempotencyKey: "dispatch-send-publish-artifact",
      name: "Send report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-send",
      connectionKey: "dispatch-send-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-003-B: one send becomes one ordered dispatch, and the same idempotency key replays the original", async () => {
    expect.hasAssertions();
    const first = await client.openThread(
      published,
      "The first annotation.",
      "dispatch-send-thread-first",
    );
    const second = await client.openThread(
      published,
      "The second annotation.",
      "dispatch-send-thread-second",
    );
    const third = await client.openThread(
      published,
      "The third annotation.",
      "dispatch-send-thread-third",
    );

    // The bundle carries the order the human selected, not creation order.
    const requestedOrder = [third.id, first.id, second.id];
    const response = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-send-ordered-bundle-key",
      note: "Address these in the order given.",
      projectId,
      threadIds: requestedOrder,
    });
    expect(response.status).toBe(201);
    const created = dispatchCreationSchema.parse(await response.json());
    expect(created.replayed).toBe(false);
    expect(created.dispatch).toMatchObject({
      addressedAt: null,
      agentDisplayName: "site",
      agentId: agent.id,
      canceledAt: null,
      claimedAt: null,
      deliveredAt: null,
      failedAt: null,
      failureReason: null,
      idempotencyKey: "dispatch-send-ordered-bundle-key",
      leaseExpiresAt: null,
      note: "Address these in the order given.",
      projectId,
      sender: {
        authorizedByPrincipalId: null,
        principalId: "local-api-token",
        principalKind: "service",
      },
      state: "queued",
      threadIds: requestedOrder,
    });

    // A retry of the same confirm answers with the original bundle.
    const replay = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-send-ordered-bundle-key",
      note: "Address these in the order given.",
      projectId,
      threadIds: requestedOrder,
    });
    expect(replay.status).toBe(201);
    const replayed = dispatchCreationSchema.parse(await replay.json());
    expect(replayed.replayed).toBe(true);
    expect(replayed.dispatch).toEqual(created.dispatch);

    // One send is one dispatch: the replay created nothing.
    const afterReplay = dispatchPageSchema.parse(
      await (await client.listDispatches(projectId)).json(),
    );
    expect(afterReplay.items.map((dispatch) => dispatch.id))
      .toEqual([created.dispatch.id]);

    // The bounds are inclusive at both ends: one thread and one hundred.
    const single = await client.openThread(
      published,
      "A single-annotation bundle.",
      "dispatch-send-thread-single",
    );
    const singleSend = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-send-single-thread-key",
      projectId,
      threadIds: [single.id],
    });
    expect(singleSend.status).toBe(201);
    expect(dispatchCreationSchema.parse(await singleSend.json()).dispatch
      .threadIds).toEqual([single.id]);

    const wholeVersion = await openThreads(maximumBundleSize, "sendall");
    const sendAll = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-send-all-open-threads-key",
      projectId,
      threadIds: wholeVersion,
    });
    expect(sendAll.status).toBe(201);
    expect(dispatchCreationSchema.parse(await sendAll.json()).dispatch
      .threadIds).toEqual(wholeVersion);
  });

  test("DSP-003-F: an empty, oversized, cross-project, resolved, or already dispatched bundle is rejected without marking a thread", async () => {
    expect.hasAssertions();
    const first = (await client.openThread(
      published,
      "The annotation every rejected bundle names first.",
      "dispatch-send-reject-thread-first",
    )).id;
    const second = (await client.openThread(
      published,
      "The annotation that never enters a bundle.",
      "dispatch-send-reject-thread-second",
    )).id;
    const third = (await client.openThread(
      published,
      "The annotation the one accepted bundle carries.",
      "dispatch-send-reject-thread-third",
    )).id;
    const resolvedThread = await client.openThread(
      published,
      "An annotation the reviewer already closed.",
      "dispatch-send-thread-resolved",
    );
    expect((await client.setThreadState(
      published,
      resolvedThread.id,
      "resolved",
    )).status).toBe(200);

    const otherProjectId = await client.createProject(
      "Other project",
      "dispatch-send-other-project-key",
    );
    const otherPublished = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Other</title>",
      idempotencyKey: "dispatch-send-other-publish-key",
      name: "Other report",
      projectId: otherProjectId,
    })).body;
    const foreignThread = await client.openThread(
      otherPublished,
      "An annotation that belongs to another project.",
      "dispatch-send-thread-foreign",
    );

    // The one legitimate send, kept aside so the rejections can be measured
    // against a project whose only marker belongs to it.
    const accepted = dispatchCreationSchema.parse(
      await (await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "dispatch-send-accepted-bundle-key",
        projectId,
        threadIds: [third],
      })).json(),
    ).dispatch;

    const oversized = Array.from(
      {length: maximumBundleSize + 1},
      (_unused, index) => `thread_oversized_${index}`,
    );
    await expectEveryBundleRejected([
      {label: "empty", threadIds: []},
      {label: "oversized", threadIds: oversized},
      {label: "cross-project", threadIds: [first, foreignThread.id]},
      {label: "resolved", threadIds: [first, resolvedThread.id]},
      {label: "already-dispatched", threadIds: [first, third]},
      {label: "repeated", threadIds: [first, first]},
    ]);

    // Nothing partial survived: only the accepted bundle exists, and every
    // thread a rejected bundle touched is still listed and still sendable.
    const dispatches = dispatchPageSchema.parse(
      await (await client.listDispatches(projectId)).json(),
    );
    expect(dispatches.items.map((dispatch) => dispatch.id))
      .toEqual([accepted.id]);
    expect((await client.listThreadIds(published)).toSorted())
      .toEqual([first, second, resolvedThread.id].toSorted());
    expect(await client.listThreadIds(otherPublished))
      .toEqual([foreignThread.id]);

    const recovered = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-send-recovered-bundle-key",
      projectId,
      threadIds: [first, second],
    });
    expect(recovered.status).toBe(201);
    expect(dispatchCreationSchema.parse(await recovered.json()).dispatch
      .threadIds).toEqual([first, second]);
  });

  /** Send each bundle in turn and require every one of them to be refused. */
  async function expectEveryBundleRejected(
    bundles: readonly RejectedBundle[],
  ): Promise<void> {
    const [next, ...rest] = bundles;
    if (next === undefined) return;
    const rejected = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: `dispatch-send-rejected-${next.label}-key`,
      projectId,
      threadIds: next.threadIds,
    });
    expect(rejected.status).toBe(422);
    expect(failureSchema.parse(await rejected.json()).error.code)
      .toBe("INVALID_DISPATCH");
    return expectEveryBundleRejected(rest);
  }

  /** Open a numbered run of open threads on the published version. */
  async function openThreads(
    count: number,
    label: string,
    opened: readonly string[] = [],
  ): Promise<readonly string[]> {
    if (opened.length === count) return opened;
    const thread = await client.openThread(
      published,
      `Annotation ${opened.length} of the ${label} run.`,
      `dispatch-send-${label}-thread-${String(opened.length).padStart(3, "0")}`,
    );
    return openThreads(count, label, [...opened, thread.id]);
  }
});

/** One bundle the send route must refuse, with the reason it is refused. */
interface RejectedBundle {
  readonly label: string;
  readonly threadIds: readonly string[];
}
