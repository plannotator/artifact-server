import {createServer, type Server} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-oidc-test-api-token-00000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const clientId = "artifact-server-cloudflare";

const assignedAddressSchema = z.object({
  port: z.number().int().positive(),
});
const notReadySchema = z.object({
  error: z.string(),
  message: z.string(),
}).loose();

let issuerOrigin: string;
let issuer: Server;

beforeAll(async () => {
  issuer = await startDiscoveryStub();
  const address = assignedAddressSchema.parse(issuer.address());
  issuerOrigin = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    issuer.close((cause) => cause === undefined ? resolve() : reject(cause));
  });
});

describe("Cloudflare Worker browser-login provider", () => {
  it("starts a generic OIDC login from the configured issuer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
    });
    try {
      const started = await worker.fetch(`${origin}/auth/login`, {
        redirect: "manual",
      });
      expect(started.status).toBe(302);
      const location = new URL(started.headers.get("location") ?? "");
      expect(location.origin).toBe(issuerOrigin);
      expect(location.pathname).toBe("/authorize");
      expect(location.searchParams.get("client_id")).toBe(clientId);
      expect(location.searchParams.get("redirect_uri"))
        .toBe(`${origin}/auth/callback`);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("scope")).toBe("openid email profile");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toBeTruthy();
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(location.searchParams.get("nonce")).toBeTruthy();
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("refuses to start with both WorkOS and OIDC configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-both-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
      ARTIFACT_SERVER_WORKOS_API_KEY: "sk_workos_test",
      ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_workos_test",
      ARTIFACT_SERVER_WORKOS_ISSUER: "https://workos.example.test",
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(notReadySchema.parse(await ready.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("refuses to start with a partial OIDC configuration", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "artifact-server-oidc-partial-"),
    );
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(notReadySchema.parse(await ready.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("fails private-team runtime initialization when no provider is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-none-"));
    const worker = await startWorker(directory, {});
    try {
      const started = await worker.fetch(`${origin}/auth/login`, {
        redirect: "manual",
      });
      expect(started.status).toBe(503);
      expect(notReadySchema.parse(await started.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);
});

function startDiscoveryStub(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== "/.well-known/openid-configuration") {
      response.writeHead(404).end();
      return;
    }
    const host = request.headers.host ?? "127.0.0.1";
    const document = {
      authorization_endpoint: `http://${host}/authorize`,
      issuer: `http://${host}`,
      jwks_uri: `http://${host}/jwks`,
      token_endpoint: `http://${host}/token`,
    };
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify(document));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startWorker(
  persistenceDirectory: string,
  loginVariables: Record<string, string>,
): Promise<Unstable_DevWorker> {
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
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-oidc-test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
      ...loginVariables,
    },
  });
}
