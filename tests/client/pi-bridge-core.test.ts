import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";

import {
  chooseDisplayName,
  connectionKeyFor,
  maximumQuotedSelectionCharacters,
  renderBundleMessage,
  resolveBridgeCredentials,
} from "../../integrations/bridge-core/index.js";

const emptyEnvironment = {
  agentDisplayName: undefined,
  agentToken: undefined,
  origin: undefined,
};

async function writeDiscovery(
  home: string,
  origin: string,
  token: string,
): Promise<void> {
  const dataDirectory = path.join(home, ".artifact-server");
  await mkdir(dataDirectory, {recursive: true});
  await writeFile(
    path.join(dataDirectory, "local-service.json"),
    JSON.stringify({
      dataDirectory,
      origin,
      pid: 4242,
      productVersion: "0.0.0",
      schemaVersion: 1,
      startedAt: "2026-08-18T00:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(
    path.join(dataDirectory, "local-api-token"),
    `${token}\n`,
    "utf8",
  );
}

describe("pi bridge core building blocks", () => {
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    for (const home of temporaryHomes.splice(0)) {
      // eslint-disable-next-line no-await-in-loop
      await rm(home, {force: true, recursive: true});
    }
  });

  async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), "pi-bridge-home-"));
    temporaryHomes.push(home);
    return home;
  }

  test("renders the recorded bundle template with note, paths, selections, and instruction", () => {
    const message = renderBundleMessage({
      items: [
        {
          artifactName: "Queue report",
          body: "Line one.\nLine two.",
          path: "index.html",
          quotedSelection: "  the   header  ",
          threadId: "cmt_one",
          versionNumber: 3,
        },
        {
          artifactName: "Queue report",
          body: "Whole-version remark.",
          path: null,
          quotedSelection: null,
          threadId: "cmt_two",
          versionNumber: 3,
        },
      ],
      note: "Please finish today.",
      senderDisplayName: "Ada",
    });
    expect(message).toBe([
      "Artifact Server: Ada sent 2 annotation(s) to address.",
      "Please finish today.",
      "",
      "1. [Queue report · version 3 · index.html] \"the header\"",
      "   Line one.",
      "   Line two.",
      "   (thread cmt_one)",
      "2. [Queue report · version 3]",
      "   Whole-version remark.",
      "   (thread cmt_two)",
      "",
      "When each item is done: use the artifact_comments tool to reply to its thread",
      "with what you did, then resolve it. Do not wait for confirmation.",
    ].join("\n"));
  });

  test("omits the note line when absent and bounds long selections to the cap", () => {
    const message = renderBundleMessage({
      items: [{
        artifactName: "Plan",
        body: "Trim it.",
        path: "plan.html",
        quotedSelection: "x".repeat(2_000),
        threadId: "cmt_long",
        versionNumber: 1,
      }],
      note: null,
      senderDisplayName: "Grace",
    });
    const lines = message.split("\n");
    expect(lines[1]).toBe("");
    const quoteLine = lines[2] ?? "";
    const quoted = quoteLine.slice(
      quoteLine.indexOf("\"") + 1,
      quoteLine.lastIndexOf("\""),
    );
    expect(quoted.length).toBe(maximumQuotedSelectionCharacters);
    expect(quoted.endsWith("…")).toBe(true);
  });

  test("hostile slash-leading fields can never produce a slash-leading message", () => {
    const message = renderBundleMessage({
      items: [{
        artifactName: "/etc",
        body: "/steer\n/compact",
        path: null,
        quotedSelection: "/quote",
        threadId: "cmt_slash",
        versionNumber: 9,
      }],
      note: "/new",
      senderDisplayName: "/resume",
    });
    expect(message.startsWith("Artifact Server: ")).toBe(true);
    expect(message.startsWith("/")).toBe(false);
  });

  test("connection keys are stable sha-256 digests of host and directory", () => {
    const key = connectionKeyFor("machine", "/work/site");
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(connectionKeyFor("machine", "/work/site")).toBe(key);
    expect(connectionKeyFor("machine", "/work/other")).not.toBe(key);
    expect(connectionKeyFor("other", "/work/site")).not.toBe(key);
  });

  test("the display name prefers the override and falls back to the basename", () => {
    expect(chooseDisplayName(
      {...emptyEnvironment, agentDisplayName: "  named  "},
      "/work/site",
    )).toBe("named");
    expect(chooseDisplayName(emptyEnvironment, "/work/site")).toBe("site");
    expect(chooseDisplayName(emptyEnvironment, "/")).toBe("pi");
  });

  test("environment configuration wins over local discovery and normalizes the origin", async () => {
    const home = await temporaryHome();
    await writeDiscovery(
      home,
      "http://127.0.0.1:4100/",
      "local-token-with-sufficient-length",
    );
    const resolved = await resolveBridgeCredentials({
      agentDisplayName: undefined,
      agentToken: "environment-token",
      origin: "https://artifacts.example.test/base/path",
    }, home);
    expect(resolved).toEqual({
      origin: "https://artifacts.example.test",
      token: "environment-token",
    });
  });

  test("local discovery resolves the loopback service record and token", async () => {
    const home = await temporaryHome();
    await writeDiscovery(
      home,
      "http://127.0.0.1:4100/",
      "local-token-with-sufficient-length",
    );
    const resolved = await resolveBridgeCredentials(emptyEnvironment, home);
    expect(resolved).toEqual({
      origin: "http://127.0.0.1:4100",
      token: "local-token-with-sufficient-length",
    });
  });

  test("no configuration, a non-loopback record, or a short token stays dormant", async () => {
    const bare = await temporaryHome();
    expect(await resolveBridgeCredentials(emptyEnvironment, bare)).toBeNull();

    const hostile = await temporaryHome();
    await writeDiscovery(
      hostile,
      "http://attacker.example.test/",
      "local-token-with-sufficient-length",
    );
    expect(await resolveBridgeCredentials(emptyEnvironment, hostile))
      .toBeNull();

    const short = await temporaryHome();
    await writeDiscovery(short, "http://127.0.0.1:4100/", "tiny");
    expect(await resolveBridgeCredentials(emptyEnvironment, short)).toBeNull();
  });
});
