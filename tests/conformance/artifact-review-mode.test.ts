import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";

const stateSchema = z.object({
  artifact: z.object({id: z.string(), reviewMode: z.enum(["annotate", "interact"])}),
  replayed: z.boolean(),
  version: z.object({id: z.string()}),
});

describe("artifact review mode", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });
  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ART-012-B: publishing and updating the review default preserves saved version identity", async () => {
    const legacy = await publishNew(server, installation, {
      accessSetting: "account_required", content: "legacy", idempotencyKey: "artifact_review_mode_default",
    });
    expect(legacy.body.artifact.reviewMode).toBe("annotate");
    const published = await publishNew(server, installation, {
      accessSetting: "account_required", content: "<button>Interact</button>",
      idempotencyKey: "artifact_review_mode_interact", reviewMode: "interact",
    });
    expect(published.body.artifact.reviewMode).toBe("interact");
    const url = `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/review-mode`;
    const input = {expectedCurrentVersionId: published.body.version.id, reviewMode: "annotate"};
    const change = () => fetch(url, {
      body: JSON.stringify(input), headers: apiHeaders(installation, "artifact_review_mode_update"), method: "PATCH",
    });
    const response = await change();
    expect(response.status).toBe(200);
    expect(stateSchema.parse(await response.json())).toMatchObject({
      artifact: {reviewMode: "annotate"}, replayed: false, version: {id: published.body.version.id},
    });
    expect(stateSchema.parse(await (await change()).json()).replayed).toBe(true);
    const version = await publishVersion(server, installation, {
      artifactId: published.body.artifact.id, content: "<button>Updated</button>",
      expectedCurrentVersionId: published.body.version.id, idempotencyKey: "artifact_review_mode_version",
    });
    expect(version.body.artifact.reviewMode).toBe("annotate");
    await server.stop();
    server = await startTestServer(installation);
    const details = await fetch(`${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`, {
      headers: apiHeaders(installation, "artifact_review_read_001"),
    });
    expect(await details.json()).toMatchObject({artifact: {reviewMode: "annotate"}});
  });

  test("ART-012-F: invalid, stale, and unauthenticated mode mutations leave the artifact unchanged", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required", content: "mode rejection", idempotencyKey: "artifact_review_mode_reject",
    });
    const url = `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/review-mode`;
    await Promise.all(([
      ["artifact_review_invalid_mode", "INTERACT", published.body.version.id, 422],
      ["artifact_review_stale_mode", "interact", "ver_stale", 409],
    ] as const).map(async ([key, mode, versionId, expected]) => {
      const response = await fetch(url, {
        body: JSON.stringify({expectedCurrentVersionId: versionId, reviewMode: mode}),
        headers: apiHeaders(installation, key), method: "PATCH",
      });
      expect(response.status).toBe(expected);
    }));
    const denied = await fetch(url, {
      body: JSON.stringify({expectedCurrentVersionId: published.body.version.id, reviewMode: "interact"}),
      headers: {"Content-Type": "application/json"}, method: "PATCH",
    });
    expect(denied.status).toBe(401);
    const details = await fetch(`${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`, {
      headers: apiHeaders(installation, "artifact_review_read_002"),
    });
    expect(await details.json()).toMatchObject({artifact: {reviewMode: "annotate"}});
  });

  test("a conflicting publication retry cannot change the original review default", async () => {
    const input = {accessSetting: "account_required" as const, content: "same bytes", idempotencyKey: "artifact_review_mode_retry"};
    const first = await publishNew(server, installation, input);
    const explicit = await publishNew(server, installation, {...input, reviewMode: "annotate"});
    expect(explicit.body.replayed).toBe(true);
    expect(explicit.body.artifact.id).toBe(first.body.artifact.id);
    await expect(publishNew(server, installation, {...input, reviewMode: "interact"}))
      .rejects.toThrow("HTTP 409");
  });

  test("a publish-only credential cannot change the artifact's review default", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required", content: "scoped credential", idempotencyKey: "review_mode_scoped_001",
    });
    const administrator = await signInAdministrator(server, installation);
    const token = await issueApiKey(server, administrator, ["artifact:publish:any"], "Publisher only");
    const denied = await fetch(`${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/review-mode`, {
      body: JSON.stringify({expectedCurrentVersionId: published.body.version.id, reviewMode: "interact"}),
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "review_mode_scoped_denied",
      },
      method: "PATCH",
    });
    expect(denied.status).toBe(403);
    const details = await fetch(`${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`, {
      headers: apiHeaders(installation, "review_mode_scoped_read"),
    });
    expect(await details.json()).toMatchObject({artifact: {reviewMode: "annotate"}});
  });
});
