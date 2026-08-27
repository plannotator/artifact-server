import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  failureSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const clearingSchema = z.object({
  deleted: z.number().int().nonnegative(),
  skippedDispatched: z.number().int().nonnegative(),
}).strict();
const conflictMessage =
  "This comment has been sent to an agent and cannot be deleted until the dispatch is complete.";

describe("dispatched comment deletion", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Dispatch deletion</title>",
      idempotencyKey: "dispatch-deletion-publish",
      name: "Dispatch deletion",
    })).body;
    projectId = published.artifact.projectId;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-020-B: queued, claimed, and delivered dispatches hold comments while addressed, failed, and canceled dispatches release them", async () => {
    expect.hasAssertions();
    const agent = await client.registerAgent({
      agentSessionId: "pi-session-dispatch-deletion",
      connectionKey: "dispatch-deletion-connection",
      displayName: "comment worker",
      workingDirectory: "/work/comment-worker",
    });

    const addressedThread = await openThread("Address this comment.", "addressed");
    const addressedDispatch = await send(agent.id, addressedThread, "addressed");
    await expectDeleteBlocked(addressedThread);
    expect(clearingSchema.parse(await (await clearAll()).json()))
      .toEqual({deleted: 0, skippedDispatched: 1});

    expect((await client.claim(agent.id)).status).toBe(200);
    await expectDeleteBlocked(addressedThread);
    expect(clearingSchema.parse(await (await clearAll()).json()))
      .toEqual({deleted: 0, skippedDispatched: 1});

    expect((await client.reportDelivered(addressedDispatch, agent.id)).status)
      .toBe(200);
    await expectDeleteBlocked(addressedThread);
    expect(clearingSchema.parse(await (await clearAll()).json()))
      .toEqual({deleted: 0, skippedDispatched: 1});

    expect((await client.setThreadState(published, addressedThread, "resolved")).status)
      .toBe(200);
    const observed = await client.getDispatch(addressedDispatch, projectId);
    expect(observed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await observed.json()).dispatch.state)
      .toBe("addressed");
    expect((await deleteThread(addressedThread)).status).toBe(204);

    const failedThread = await openThread("This delivery fails.", "failed");
    const failedDispatch = await send(agent.id, failedThread, "failed");
    expect((await client.claim(agent.id)).status).toBe(200);
    const failed = await client.reportFailed(
      failedDispatch,
      agent.id,
      "Test delivery failure",
    );
    expect(failed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await failed.json()).dispatch.state)
      .toBe("failed");
    expect((await deleteThread(failedThread)).status).toBe(204);

    const canceledThread = await openThread("Cancel this delivery.", "canceled");
    const canceledDispatch = await send(agent.id, canceledThread, "canceled");
    const canceled = await client.cancelDispatch(canceledDispatch, projectId);
    expect(canceled.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await canceled.json()).dispatch.state)
      .toBe("canceled");
    expect((await deleteThread(canceledThread)).status).toBe(204);
    expect(await client.listThreadIds(published, "&dispatched=include"))
      .toEqual([]);
  });

  test("CMT-020-F: a concurrent send and delete commits only one complete SQLite outcome", async () => {
    expect.hasAssertions();
    const agent = await client.registerAgent({
      agentSessionId: "pi-session-dispatch-race",
      connectionKey: "dispatch-race-connection",
      displayName: "race worker",
      workingDirectory: "/work/race-worker",
    });
    const threadId = await openThread("Race this comment.", "race");

    const [sent, deleted] = await Promise.all([
      client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "dispatch-deletion-race-send",
        projectId,
        threadIds: [threadId],
      }),
      deleteThread(threadId),
    ]);

    expect(
      sent.status === 201 && deleted.status === 409 ||
        sent.status === 422 && deleted.status === 204,
    ).toBe(true);
    const outcome = sent.status === 201
      ? {
        deletedCode: failureSchema.parse(await deleted.json()).error.code,
        sentCode: "committed",
        threadIds: await client.listThreadIds(published, "&dispatched=only"),
      }
      : {
        deletedCode: "committed",
        sentCode: failureSchema.parse(await sent.json()).error.code,
        threadIds: await client.listThreadIds(published, "&dispatched=include"),
      };
    expect(outcome).toEqual(sent.status === 201
      ? {
        deletedCode: "DISPATCH_STATE_CONFLICT",
        sentCode: "committed",
        threadIds: [threadId],
      }
      : {deletedCode: "committed", sentCode: "INVALID_DISPATCH", threadIds: []});
  });

  function deleteThread(threadId: string): Promise<Response> {
    return client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
        `?projectId=${projectId}`,
      {method: "DELETE"},
    );
  }

  function clearAll(): Promise<Response> {
    return client.fetch(
      `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}` +
        "/comments/clear",
      {body: JSON.stringify({state: "all"}), method: "POST"},
    );
  }

  async function expectDeleteBlocked(threadId: string): Promise<void> {
    const response = await deleteThread(threadId);
    expect(response.status).toBe(409);
    expect(failureSchema.parse(await response.json()).error).toEqual({
      code: "DISPATCH_STATE_CONFLICT",
      message: conflictMessage,
    });
  }

  async function openThread(body: string, key: string): Promise<string> {
    return (await client.openThread(
      published,
      body,
      `dispatch-deletion-thread-${key}`,
    )).id;
  }

  async function send(
    agentId: string,
    threadId: string,
    key: string,
  ): Promise<string> {
    const response = await client.sendDispatch({
      agentId,
      idempotencyKey: `dispatch-deletion-send-${key}`,
      projectId,
      threadIds: [threadId],
    });
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }
});
