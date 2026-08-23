/**
 * PI-LIVE 2 — three bundles sent during one unit of work drain one per work
 * boundary, in the order they were sent. The proof is Pi's own conversation:
 * each completion request must add exactly one new bundle message, and the
 * order of those messages must be the order of the sends.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
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
  startScriptedModel,
} from "./support/scripted-model.js";
import {
  createPiEnvironment,
  type PiEnvironment,
  scriptedModel,
} from "./support/pi-environment.js";
import {type LivePi, resolvePiCli, startLivePi} from "./support/live-pi.js";
import {createWorkGate} from "./support/work-gate.js";
import {
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/pi/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

describe("live Pi bridge FIFO drain", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: PiEnvironment;
  let model: ScriptedModel;
  let pi: LivePi;
  const work = createWorkGate();

  beforeAll(async () => {
    const cliPath = await resolvePiCli();
    if (cliPath === null) throw new Error("No pi CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live FIFO</title>",
      idempotencyKey: "pi-live-fifo-publish",
      name: "Live FIFO report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (turn.index === 1) {
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      // Every bundle turn ends the run without tool calls, so Pi's follow-up
      // queue drains the next bundle at the next work boundary.
      return {kind: "text", text: `Handled bundle ${turn.index - 1}.`};
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
    "PI-LIVE 2: three bundles queued during one unit of work drain one per boundary, in order",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      const threads = [];
      for (const label of ["first", "second", "third"]) {
        threads.push(
          // eslint-disable-next-line no-await-in-loop
          await client.openThread(
            published,
            `Annotation ${label}.`,
            `pi-live-fifo-thread-${label}`,
          ),
        );
      }

      pi.submit("Do the scripted long task and report when finished.");
      await model.waitForTurns(1);

      // Three separate sends, each one bundle, all while Pi is busy.
      const dispatchIds: string[] = [];
      for (const [position, thread] of threads.entries()) {
        const created = dispatchCreationSchema.parse(
          // eslint-disable-next-line no-await-in-loop
          await (await client.sendDispatch({
            agentId: agent.id,
            idempotencyKey: `pi-live-fifo-dispatch-${position + 1}`,
            projectId,
            threadIds: [thread.id],
          })).json(),
        );
        dispatchIds.push(created.dispatch.id);
        // The one-active-claim rule means the next claim only follows this
        // dispatch's delivery report.
        // eslint-disable-next-line no-await-in-loop
        await waitForDispatchState(client, projectId, created.dispatch.id, [
          "delivered",
        ]);
      }
      expect(dispatchIds).toHaveLength(3);
      // Nothing reached the model yet: Pi is still inside its first unit of work.
      expect(model.turns()).toHaveLength(1);

      work.open();
      await model.waitForTurns(4, 60_000);

      // One bundle per boundary, in send order.
      for (const [position, thread] of threads.entries()) {
        const turn = model.turns()[position + 1] ?? emptyTurn;
        expect(bundleMessages(turn)).toHaveLength(position + 1);
        const latest = latestUserMessage(turn);
        expect(latest.startsWith("Artifact Server:")).toBe(true);
        expect(latest).toContain("sent 1 annotation(s) to address");
        expect(latest).toContain(`(thread ${thread.id})`);
      }

      // Three sends produced three deliveries and nothing else: no bundle was
      // duplicated or merged into another turn.
      await new Promise((resolve) => {
        setTimeout(resolve, 2_000);
      });
      expect(model.turns()).toHaveLength(4);
    },
  );
});
