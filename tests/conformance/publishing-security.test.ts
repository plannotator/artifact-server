import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { z } from "zod";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  parsePublishResponse,
  publishNew,
  uploadEveryStagedFile,
} from "../support/publishing.js";

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
        const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
          body: JSON.stringify({
            entryPath: unsafePath,
            files: [{
              mediaType: "text/html",
              path: unsafePath,
              sha256: "0".repeat(64),
              size: 0,
            }],
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

  test("ART-002-F: API publication requires a trusted principal and creates nothing on rejection", async () => {
    const requestBody = JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html",
        path: "index.html",
        sha256: "0".repeat(64),
        size: 0,
      }],
    });
    const unauthorized = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: requestBody,
      headers: {"Content-Type": "application/json"},
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const afterRejection = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    await expect(afterRejection.json()).resolves.toMatchObject({artifacts: []});

    const authorized = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<title>Protected mutation</title>",
      idempotencyKey: "authentication-rejection-does-not-write",
      name: "Protected mutation",
    });
    expect(authorized.response.status).toBe(201);
    expect(authorized.body.artifact.ownerPrincipalId).toBe("local-api-token");
  });

  test("AUTH-002-B: account-required is the default and an admitted principal can open it", async () => {
    const file = {
      bytes: new TextEncoder().encode("<title>Private by default</title>"),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    };
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
    );
    await uploadEveryStagedFile(installation, upload.body, [file]);
    const response = await fetch(upload.body.commitUrl, {
      body: JSON.stringify({target: {
        kind: "new_artifact",
        name: "Default private artifact",
      }}),
      headers: apiHeaders(installation, "default-account-required-setting"),
      method: "POST",
    });
    const published = parsePublishResponse(await response.json());
    expect(response.status).toBe(201);
    expect(published.artifact.accessSetting).toBe("account_required");
    expect((await fetchVersion(server, published.links.version)).status).toBe(401);

    const bootstrapResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    const bootstrap = z.object({bootstrapUrl: z.url()}).parse(
      await bootstrapResponse.json(),
    );
    const exchange = await fetchVersion(server, bootstrap.bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const opened = await fetchVersion(
      server,
      published.links.version,
      "GET",
      {Cookie: cookie ?? ""},
    );
    expect(await opened.text()).toContain("Private by default");
  });

  test("PUB-002-F SCP-007-F: public APIs reject raw contents, paths, and source URLs", async () => {
    const rawBodies = [
      {content: "<h1>raw source</h1>"},
      {contentBase64: Buffer.from("raw bytes").toString("base64")},
    ];
    const rawResponses = await Promise.all(rawBodies.map(async (body) => {
      const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
        body: JSON.stringify(body),
        headers: apiHeaders(installation, "raw-publication-is-not-supported"),
        method: "POST",
      });
      return {body: await response.json(), status: response.status};
    }));
    for (const response of rawResponses) {
      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: expect.stringContaining("/api/v1/uploads"),
        },
      });
    }

    const remoteInputs = [
      {path: "/Users/example/private.html"},
      {sourceUrl: "http://169.254.169.254/latest/meta-data/"},
      {sourceUrl: "file:///etc/passwd"},
    ];
    const remoteStatuses = await Promise.all(remoteInputs.map(async (body) => {
      const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
        body: JSON.stringify({
          ...body,
          entryPath: "index.html",
          files: [{
            mediaType: "text/html",
            path: "index.html",
            sha256: "0".repeat(64),
            size: 0,
          }],
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      return response.status;
    }));
    expect(remoteStatuses).toEqual([422, 422, 422]);
  });

  test("foundation: malformed and oversized file-upload plans fail without destabilizing the server", async () => {
    const malformed = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: "{",
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: {code: "INVALID_INPUT"},
    });

    const oversized = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: "x".repeat(16 * 1_024 * 1_024 + 1),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
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
