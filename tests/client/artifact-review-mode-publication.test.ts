import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {expect, test} from "vitest";

import {publishPath} from "../../src/client/file-publication-client.js";
import {createTestInstallation, removeTestInstallation, startTestServer} from "../support/runtime-harness.js";

test("file publication forwards the review default and preserves default-mode retries", async () => {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-review-mode-client-"));
  try {
    const inputPath = path.join(directory, "report.html");
    await writeFile(inputPath, "<button>Interactive report</button>");
    const publish = (key: string, reviewMode?: "annotate" | "interact") => {
      const target = {accessSetting: "account_required" as const, kind: "new_artifact" as const, tags: []};
      return Effect.runPromise(publishPath({
        apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl,
      }, {
        idempotencyKey: key, inputPath,
        target: reviewMode === undefined ? target : {...target, reviewMode},
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
    };
    const interact = await publish("client_review_interact_001", "interact");
    expect(interact.artifact.reviewMode).toBe("interact");
    const omitted = await publish("client_review_default_001");
    const explicit = await publish("client_review_default_001", "annotate");
    expect(omitted.artifact.reviewMode).toBe("annotate");
    expect(explicit.replayed).toBe(true);
    expect(explicit.artifact.id).toBe(omitted.artifact.id);
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(directory, {recursive: true, force: true});
  }
});
