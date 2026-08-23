/**
 * PI-LIVE 3 — a Pi session replacement (`/new`) mid-flight. The bridge must
 * re-register the same connection, and a bundle that was still queued in the
 * mailbox at the moment of the replacement must reach the new session.
 *
 * The claim gate is what makes this deterministic: with claims closed the
 * dispatch is provably still `queued` when `/new` runs, instead of racing the
 * bridge's claim loop.
 *
 * KNOWN DIVERGENCE (reproduced on every run, 2026-08-18, pi 0.84.1): this test
 * fails against the bridge as shipped. Pi emits `session_shutdown` with reason
 * "new" before the replacement session starts; the bridge answers it with the
 * courtesy disconnect, which deletes the registration row, so the replacement
 * registers under a NEW agent id and the queued bundle — still addressed to the
 * old id — is failed as `agent_unavailable` on the next read instead of being
 * delivered. Specification section 8 promises the opposite ("restarts and
 * /new//resume reclaim the same agent id and its pending FIFO"). Disconnecting
 * only when the shutdown reason is "quit" makes this test pass unchanged
 * (verified against a patched copy of the extension).
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
  type ClaimGateProxy,
  startClaimGateProxy,
} from "./support/claim-gate-proxy.js";
import {
  createPiEnvironment,
  type PiEnvironment,
  scriptedModel,
} from "./support/pi-environment.js";
import {type LivePi, resolvePiCli, startLivePi} from "./support/live-pi.js";
import {createWorkGate} from "./support/work-gate.js";
import {
  readDispatch,
  waitForConnectedAgent,
  waitForRegistrationChange,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/pi/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};
const workPrompt = "Do the scripted long task and report when finished.";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live Pi bridge session replacement", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: ClaimGateProxy;
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
    proxy = await startClaimGateProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live rebind</title>",
      idempotencyKey: "pi-live-rebind-publish",
      name: "Live rebind report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (turn.index === 1) {
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      return {kind: "text", text: "Handled the bundle after the rebind."};
    });
    environment = await createPiEnvironment(model.baseUrl);
    pi = await startLivePi({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      origin: proxy.origin,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
  });

  afterAll(async () => {
    work.open();
    await pi.stop();
    await model.stop();
    await proxy.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "PI-LIVE 3: /new re-registers the same connection and the queued bundle reaches the new session",
    async () => {
      expect.hasAssertions();
      const projectId = published.artifact.projectId;
      const before = await waitForConnectedAgent(client);

      const thread = await client.openThread(
        published,
        "Check the figure caption on page two.",
        "pi-live-rebind-thread",
      );

      pi.submit(workPrompt);
      await model.waitForTurns(1);

      // With the gate closed the send provably stays in the mailbox: the poll
      // already in flight is cut, and the bridge's next poll is answered here.
      proxy.closeClaims();
      await sleep(1_500);
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: before.id,
          idempotencyKey: "pi-live-rebind-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      await sleep(2_500);
      expect(
        (await readDispatch(client, projectId, created.dispatch.id)).state,
      ).toBe("queued");

      // Replace the session while that work is still in flight.
      pi.submit("/new");
      await sleep(500);
      pi.submit("");
      const after = await waitForRegistrationChange(client, before);

      // Observe the whole outcome before asserting, so one divergence does not
      // hide the rest of the sequence.
      proxy.openClaims();
      await sleep(8_000);
      const settled = await readDispatch(client, projectId, created.dispatch.id);
      const turn = model.turns()[1] ?? emptyTurn;

      // The replacement session re-registered the same connection: same
      // working directory, new Pi session id.
      expect(after.workingDirectory).toBe(before.workingDirectory);
      expect(after.agentSessionId).not.toBe(before.agentSessionId);

      // Specification section 8: the connection key is stable, "so restarts and
      // /new//resume reclaim the same agent id and its pending FIFO".
      expect(
        after.id,
        "the re-registered agent must keep the id its queued dispatches address",
      ).toBe(before.id);

      // And the bundle that was queued across the replacement must arrive in
      // the new session.
      expect(
        settled.state,
        `the queued bundle must reach the replacement session, not stay ${settled.state}`,
      ).toBe("delivered");
      const latest = latestUserMessage(turn);
      expect(latest.startsWith("Artifact Server:")).toBe(true);
      expect(latest).toContain(`(thread ${thread.id})`);
      expect(bundleMessages(turn)).toHaveLength(1);
      // The replacement session starts clean: the pre-`/new` prompt is gone.
      expect(turn.messages.map((message) => message.text)).not.toContain(
        workPrompt,
      );
    },
  );
});
