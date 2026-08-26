import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-linked-test-api-token-000000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-linked-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare Worker linked-artifact absence", () => {
  it("never advertises linked artifacts and answers the stable capability-unavailable shape on every linked route", async () => {
    const session = await worker.fetch(`${origin}/api/v1/session`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(session.status).toBe(200);
    const sessionBody = z.object({
      capabilities: z.object({linkedArtifacts: z.boolean()}).loose(),
    }).loose().parse(await session.json());
    expect(sessionBody.capabilities.linkedArtifacts).toBe(false);

    const routes: ReadonlyArray<readonly [string, string, unknown]> = [
      ["POST", "/api/v1/artifacts/link", {path: "/etc/passwd"}],
      [
        "POST",
        "/api/v1/artifacts/art_missing/capture",
        {expectedCurrentVersionId: "ver_missing"},
      ],
      [
        "PUT",
        "/api/v1/artifacts/art_missing/source",
        {expectedSha256: "a".repeat(64), path: "/etc/passwd"},
      ],
      ["POST", "/api/v1/artifacts/art_missing/live-sessions", {}],
    ];
    const results = await Promise.all(routes.map(async ([method, pathname, body]) => {
      const response = await worker.fetch(`${origin}${pathname}`, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `linked-absent-${method}-${pathname.length}`,
        },
        method,
      });
      return {code: failureSchema.parse(await response.json()).error.code, status: response.status};
    }));
    for (const result of results) {
      expect(result.status).toBe(501);
      expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    }
  });

  it("exposes no live origin: a live-labelled content host never serves a live document", async () => {
    const liveHost = await worker.fetch(`${origin}/`, {
      headers: {Host: `live-00000000000000000000000000000000.${contentDomain}`},
      redirect: "manual",
    });
    // The worker has no per-artifact live origin and no disk to stream from. A
    // live document is recognisable by the freshness header only the live view
    // emits; the worker never emits it, whatever it does with an unknown host.
    expect(liveHost.headers.get("artifact-source-freshness")).toBeNull();
  });
});

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-linked-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-linked-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
