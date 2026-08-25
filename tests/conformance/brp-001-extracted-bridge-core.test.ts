/**
 * BRP-001 — the extracted, host-agnostic bridge core. A fake host (not Pi)
 * drives the shared `@plannotator/agent-bridge` package through the full
 * loop against a real spawned server, and the core's module graph is proved
 * free of any Pi import.
 */

import {readFileSync} from "node:fs";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  type BridgeHandle,
  createCommentOperations,
  type FollowUpDelivery,
  type HostPort,
  startBridge,
  ThreadLocationCache,
} from "../../integrations/bridge-core/index.js";

/**
 * A fake host: not Pi, no Pi types, just the narrow HostPort contract. It
 * records every notice and injected message the bridge hands it.
 */
class FakeHost implements HostPort {
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];
  readonly notices: string[] = [];

  isCompacting(): boolean {
    return false;
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    this.messages.push({delivery, text});
  }
}

/**
 * Loose wire schemas: this test asserts only what BRP-001 needs, so the
 * server response gaining fields (capabilities, activity) never breaks it.
 */
const agentPageSchema = z.object({
  items: z.array(z.object({
    displayName: z.string(),
    id: z.string(),
  }).loose()),
}).loose();
const dispatchAnswerSchema = z.object({
  dispatch: z.object({
    id: z.string(),
    state: z.string(),
  }).loose(),
}).loose();
const threadAnswerSchema = z.object({
  replies: z.array(z.object({body: z.string()}).loose()),
  thread: z.object({state: z.string()}).loose(),
}).loose();

async function eventually<Value>(
  probe: () => Promise<Value | null>,
  timeoutMilliseconds = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error("The awaited condition was not reached in time.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("extracted bridge core", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let bridges: BridgeHandle[];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Extracted core</title>",
      idempotencyKey: "brp-extracted-core-publish-artifact",
      name: "Extraction report",
    })).body;
    projectId = published.artifact.projectId;
    bridges = [];
  });

  afterEach(async () => {
    for (const bridge of bridges) {
      // eslint-disable-next-line no-await-in-loop
      await bridge.stop();
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("BRP-001-B: the extracted core drives a fake host through register, claim, deliver, reply, and resolve against a real server", async () => {
    expect.hasAssertions();
    const first = await client.openThread(
      published,
      "Rename the heading.",
      "brp-extracted-core-thread-first",
    );
    const second = await client.openThread(
      published,
      "Tighten the intro.",
      "brp-extracted-core-thread-second",
    );

    const host = new FakeHost();
    const locations = new ThreadLocationCache();
    // The kind slug is display metadata; "pi" is the one slug every server
    // generation accepts while PRS-007 widens the validation server-side.
    const bridge = startBridge({
      agentSessionId: null,
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "fake-host",
      fetchImplementation: fetch,
      host,
      hostname: "brp-host",
      kind: "pi",
      locations,
      waitSeconds: 1,
      workingDirectory: "/work/fake-host",
    });
    bridges.push(bridge);

    // Register: the agent row appears and the handshake settles on version 1
    // (the literal answered by the server, or the default for one that
    // predates the protocolVersion field).
    const agentId = await eventually(async () => {
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      const listed = agentPageSchema.parse(await response.json()).items
        .find((item) => item.displayName === "fake-host");
      return listed === undefined ? null : listed.id;
    });
    expect(bridge.agentId()).toBe(agentId);
    expect(bridge.protocolVersion()).toBe(1);

    // Claim and deliver: the bundle lands on the fake host as follow-up.
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "brp-extracted-core-dispatch",
      note: "Both today, please.",
      projectId,
      threadIds: [first.id, second.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchAnswerSchema.parse(await sent.json())
      .dispatch.id;
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchAnswerSchema.parse(await answer.json())
        .dispatch.state;
      return state === "delivered" ? true : null;
    });
    expect(host.messages).toHaveLength(1);
    const message = host.messages[0];
    expect(message?.text.startsWith("Artifact Server: ")).toBe(true);
    expect(message?.text).toContain(first.id);
    expect(message?.text).toContain(second.id);
    expect(message?.delivery).toEqual({deliverAs: "followUp"});

    // Reply and resolve through the core's comment operations, then prove
    // the server recorded both and inferred the dispatch as addressed.
    const comments = createCommentOperations(
      {origin: server.baseUrl, token: installation.apiToken},
      fetch,
      locations,
    );
    await comments.reply(first.id, "Renamed the heading.");
    await comments.resolve(first.id);
    await comments.reply(second.id, "Tightened the intro.");
    await comments.resolve(second.id);

    for (const [threadId, replyBody] of [
      [first.id, "Renamed the heading."],
      [second.id, "Tightened the intro."],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await client.fetch(
        `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
          `?projectId=${projectId}`,
      );
      expect(answer.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const details = threadAnswerSchema.parse(await answer.json());
      expect(details.thread.state).toBe("resolved");
      expect(details.replies.map((reply) => reply.body))
        .toContain(replyBody);
    }
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchAnswerSchema.parse(await answer.json())
        .dispatch.state;
      return state === "addressed" ? true : null;
    });

    await bridge.stop();
  });

  test("BRP-001-F: the bridge core module graph reaches no Pi module and only host-neutral dependencies", () => {
    expect.hasAssertions();
    const packageDirectory = path.resolve(
      import.meta.dirname,
      "../../integrations/bridge-core",
    );
    const specifierPattern =
      /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/gu;
    const allowedBarePackages = new Set(["zod"]);
    const visited = new Set<string>();
    const queue = [path.join(packageDirectory, "index.ts")];

    while (queue.length > 0) {
      const filePath = queue.pop();
      if (filePath === undefined || visited.has(filePath)) continue;
      visited.add(filePath);
      expect(
        path.relative(packageDirectory, filePath).startsWith(".."),
        `${filePath} escapes the bridge-core package`,
      ).toBe(false);
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2] ?? "";
        if (specifier === "") continue;
        expect(
          /(^|\/)pi(\/|$)|integrations\/pi/u.test(specifier),
          `${filePath} imports a Pi module: ${specifier}`,
        ).toBe(false);
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(
            path.dirname(filePath),
            specifier.replace(/\.js$/u, ".ts"),
          );
          queue.push(resolved);
          continue;
        }
        expect(
          allowedBarePackages.has(specifier),
          `${filePath} imports an unexpected package: ${specifier}`,
        ).toBe(true);
      }
    }
    expect(visited.size).toBeGreaterThanOrEqual(1);
  });
});
