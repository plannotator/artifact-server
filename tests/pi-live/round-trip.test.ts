/**
 * PI-LIVE 1 — the full round trip against a REAL Pi process.
 *
 * A human publishes an artifact, annotates it, and sends the bundle while Pi is
 * mid-work. The suite proves, from the server and from Pi's own conversation,
 * that the bundle waits for Pi's work boundary, arrives as one message, and is
 * closed by the `artifact_comments` tool until the dispatch reads `addressed`.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  bundleMessages,
  latestUserMessage,
  type ModelTurn,
  type ScriptedModel,
  type ScriptedReply,
  startScriptedModel,
} from "./support/scripted-model.js";
import {
  createPiEnvironment,
  type PiEnvironment,
  scriptedModel,
} from "./support/pi-environment.js";
import {
  type LivePi,
  resolvePiCli,
  startLivePi,
} from "./support/live-pi.js";
import {createWorkGate} from "./support/work-gate.js";
import {
  readThread,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const emptyTurn: ModelTurn = {index: 0, messages: []};

const bridgeExtension = new URL(
  "../../integrations/pi/index.ts",
  import.meta.url,
).pathname;

describe("live Pi bridge round trip", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: PiEnvironment;
  let model: ScriptedModel;
  let pi: LivePi;
  const work = createWorkGate();
  const replies: ScriptedReply[] = [];

  beforeAll(async () => {
    const cliPath = await resolvePiCli();
    if (cliPath === null) throw new Error("No pi CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live round trip</title>",
      idempotencyKey: "pi-live-round-trip-publish",
      name: "Live round trip report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (turn.index === 1) {
        // The scripted slow work: Pi stays inside this unit of work until the
        // test has sent the bundle and watched it reach `delivered`.
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      return replies[turn.index - 2] ??
        {kind: "text", text: "Nothing further to do."};
    });
    environment = await createPiEnvironment(model.baseUrl);
    pi = await startLivePi({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      origin: server.baseUrl,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
  });

  afterAll(async () => {
    work.open();
    await pi.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "PI-LIVE 1: a bundle sent while Pi works arrives at the work boundary and is closed through artifact_comments",
    async () => {
      expect.hasAssertions();

      // The live extension registered this Pi session by itself.
      const agent = await waitForConnectedAgent(client);
      expect(agent.displayName).toBe("pi-live-suite");
      expect(agent.workingDirectory).toBe(environment.projectDirectory);

      const first = await client.openThread(
        published,
        "Tighten the opening paragraph.",
        "pi-live-round-trip-thread-first",
      );
      const second = await client.openThread(
        published,
        "The summary table needs a total row.",
        "pi-live-round-trip-thread-second",
      );
      replies.push(
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              operation: "get_bundle",
              threadIds: [first.id, second.id],
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              body: "Rewrote the opening paragraph.",
              operation: "reply",
              threadId: first.id,
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {operation: "resolve", threadId: first.id},
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              body: "Added the total row to the summary table.",
              operation: "reply",
              threadId: second.id,
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {operation: "resolve", threadId: second.id},
            name: "artifact_comments",
          }],
        },
        {kind: "text", text: "All annotations addressed."},
      );

      // Put Pi to work, and wait until the model is holding that turn open.
      pi.submit("Do the scripted long task and report when finished.");
      await model.waitForTurns(1);
      expect(bundleMessages(model.turns()[0] ?? emptyTurn)).toStrictEqual([]);

      // Send the bundle while Pi is busy.
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "pi-live-round-trip-dispatch",
          note: "Both of these are on the current version.",
          projectId: published.artifact.projectId,
          threadIds: [first.id, second.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The bridge claims it and injects it as follow-up work, all while Pi is
      // still inside the first unit of work.
      const delivered = await waitForDispatchState(
        client,
        published.artifact.projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(delivered.deliveredAt).not.toBeNull();
      expect(model.turns()).toHaveLength(1);

      // Releasing the work boundary is what lets Pi see the bundle.
      work.open();
      await model.waitForTurns(2, 30_000);
      const boundaryTurn = model.turns()[1];
      expect(boundaryTurn).toBeDefined();
      const bundle = latestUserMessage(boundaryTurn ?? emptyTurn);
      expect(bundle.startsWith("Artifact Server:")).toBe(true);
      expect(bundle).toContain("sent 2 annotation(s) to address");
      expect(bundle).toContain("Both of these are on the current version.");
      expect(bundle).toContain(`(thread ${first.id})`);
      expect(bundle).toContain(`(thread ${second.id})`);
      expect(bundle).toContain("use the artifact_comments tool");
      // One send is one message: the boundary delivered exactly one bundle.
      expect(bundleMessages(boundaryTurn ?? emptyTurn)).toHaveLength(1);

      // The registered tool really reads through the comment API: the
      // get_bundle result Pi fed back carries both annotation bodies.
      await model.waitForTurns(3, 30_000);
      const toolResults = (model.turns()[2] ?? emptyTurn).messages
        .filter((message) => message.role === "tool")
        .map((message) => message.text)
        .join("\n");
      expect(toolResults).toContain("Tighten the opening paragraph.");
      expect(toolResults).toContain("The summary table needs a total row.");

      // The agent then works the threads through the registered tool.
      await model.waitForTurns(replies.length + 1, 60_000);
      const firstDetails = await readThread(client, published, first.id);
      const secondDetails = await readThread(client, published, second.id);
      expect(firstDetails.thread.state).toBe("resolved");
      expect(secondDetails.thread.state).toBe("resolved");
      expect(firstDetails.replies.map((reply) => reply.body)).toStrictEqual([
        "Rewrote the opening paragraph.",
      ]);
      expect(secondDetails.replies.map((reply) => reply.body)).toStrictEqual([
        "Added the total row to the summary table.",
      ]);

      // Every thread resolved, so the dispatch reads addressed.
      const addressed = await waitForDispatchState(
        client,
        published.artifact.projectId,
        created.dispatch.id,
        ["addressed"],
      );
      expect(addressed.addressedAt).not.toBeNull();
    },
  );
});
