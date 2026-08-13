import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import { publishNew } from "../support/publishing.js";

describe("local publishing security boundaries", () => {
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

  test("MAN-003-B MAN-003-F: portable paths round-trip through URLs and unsafe paths are rejected", async () => {
    const unsafePaths = [
      "/absolute.html",
      "../escape.html",
      "nested/../escape.html",
      "nested//empty.html",
      "nested\\windows.html",
      ".git/config",
      "nested/%2f/encoded.html",
      "nested/\0/nul.html",
      "cafe\u0301.html",
    ];

    const rejected = await Promise.all(
      unsafePaths.map(async (unsafePath, index) => {
        const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
          body: JSON.stringify({
            accessSetting: "public_link",
            file: {
              contentBase64: Buffer.from("unsafe").toString("base64"),
              mediaType: "text/html",
              path: unsafePath,
            },
            name: "Unsafe path",
          }),
          headers: apiHeaders(installation, `unsafe-manifest-path-${index}-key`),
          method: "POST",
        });
        return {
          body: await response.json(),
          path: unsafePath,
          status: response.status,
        };
      }),
    );
    for (const rejection of rejected) {
      expect(rejection.status).toBe(422);
      expect(rejection.body).toMatchObject({
        error: {code: "INVALID_MANIFEST_PATH"},
      });
    }

    const portablePath = "nested/café report.html";
    const valid = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Safe</title>",
      idempotencyKey: "safe-after-hostile-paths",
      path: portablePath,
    });
    const direct = new URL(valid.body.links.version);
    direct.pathname = `/${portablePath}`;
    const directResponse = await fetchVersion(server, direct.toString());
    expect(directResponse.status).toBe(200);
    expect(await directResponse.text()).toBe("<!doctype html><title>Safe</title>");

    const missing = new URL(valid.body.links.version);
    missing.pathname = "/not-in-the-manifest";
    const response = await fetchVersion(server, missing.toString());
    expect(response.status).toBe(404);
  });

  test("foundation: API publication requires the configured token and creates nothing on rejection", async () => {
    const idempotencyKey = "authentication-rejection-does-not-write";
    const requestBody = JSON.stringify({
      accessSetting: "public_link",
      file: {
        contentBase64: Buffer.from("<title>Protected mutation</title>").toString("base64"),
        mediaType: "text/html",
        path: "index.html",
      },
      name: "Protected mutation",
    });
    const unauthorized = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      body: requestBody,
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
    expect(authorized.status).toBe(201);
  });

  test("foundation: malformed and oversized API requests fail as client errors without destabilizing the server", async () => {
    const malformed = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      body: "{",
      headers: apiHeaders(installation, "malformed-json-request-key"),
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: {code: "INVALID_INPUT"},
    });

    const oversized = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      body: "x".repeat(1_500_001),
      headers: apiHeaders(installation, "oversized-json-request-key"),
      method: "POST",
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: {code: "INVALID_INPUT"},
    });

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  test("foundation: the local server binds only to IPv4 loopback", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("AUTH-002-F: account-required bytes do not open through stable or exact links", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Private</title>",
      idempotencyKey: "private-artifact-cannot-open-publicly",
    });
    const stable = await fetch(published.body.links.artifact, {redirect: "manual"});
    const exact = await fetchVersion(server, published.body.links.version);
    expect(stable.status).toBe(401);
    expect(exact.status).toBe(401);
  });

  test("foundation: version responses have safe immutable HTTP behavior", async () => {
    const html = "<!doctype html><title>Headers</title>";
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: html,
      idempotencyKey: "content-http-contract-headers",
    });
    const get = await fetchVersion(server, published.body.links.version);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(await get.text()).toBe(html);

    const head = await fetchVersion(server, published.body.links.version, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(await head.text()).toBe("");

    const post = await fetchVersion(server, published.body.links.version, "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
