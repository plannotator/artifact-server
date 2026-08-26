import {request} from "node:http";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {brotliDecompressSync, gunzipSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const encoder = new TextEncoder();
const scriptFixture = `export const rows = [\n${
  Array.from({length: 200}, (_, index) => `  "row-${index}",`).join("\n")
}\n];\n`;
const stylesheetFixture = "body { color: #111; }\n";
const shellFixture = `<!doctype html><title>Shell</title>${
  "<p>compressible shell padding</p>".repeat(64)
}`;
const binaryFixture = new Uint8Array(2048).map((_, index) => index % 251);

const versionDetailsSchema = z.object({
  manifest: z.object({
    entries: z.array(z.object({path: z.string()})),
  }).loose(),
}).loose();

interface RawResponse {
  readonly body: Buffer;
  readonly headers: Headers;
  readonly status: number;
}

describe("Node server response compression and asset caching", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(
      path.join(tmpdir(), "artifact-server-web-assets-"),
    );
    await mkdir(path.join(webAssetsRoot, "assets"), {recursive: true});
    await writeFile(path.join(webAssetsRoot, "review.html"), shellFixture);
    await writeFile(
      path.join(webAssetsRoot, "assets", "app-fixture.js"),
      scriptFixture,
    );
    await writeFile(
      path.join(webAssetsRoot, "assets", "tiny.css"),
      stylesheetFixture,
    );
    await writeFile(
      path.join(webAssetsRoot, "assets", "logo.png"),
      binaryFixture,
    );
    server = await startTestServer(installation, {webAssetsRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  test("foundation: large JSON API responses are gzip-compressed when accepted", async () => {
    const published = await publishManyFiles("compression-json-fixture");
    const detailPath = versionDetailPath(published);

    const compressed = await rawRequest(server, detailPath, {
      "Accept-Encoding": "gzip",
      Authorization: `Bearer ${installation.apiToken}`,
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
    expect(compressed.headers.get("content-length")).toBe(
      String(compressed.body.byteLength),
    );
    const decoded = gunzipSync(compressed.body);
    expect(decoded.byteLength).toBeGreaterThan(1024);
    expect(compressed.body.byteLength).toBeLessThan(decoded.byteLength);
    const details = versionDetailsSchema.parse(
      JSON.parse(decoded.toString("utf8")),
    );
    expect(details.manifest.entries.length).toBe(25);

    const identity = await rawRequest(server, detailPath, {
      Authorization: `Bearer ${installation.apiToken}`,
    });
    expect(identity.status).toBe(200);
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toContain("Accept-Encoding");
    expect(identity.body).toEqual(decoded);
  });

  test("foundation: static assets compress, revalidate with 304, and keep immutable caching", async () => {
    const compressed = await rawRequest(server, "/assets/app-fixture.js", {
      "Accept-Encoding": "gzip",
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
    const weakEtag = compressed.headers.get("etag");
    expect(weakEtag).toMatch(/^W\/"[a-f0-9]{64}"$/u);
    expect(gunzipSync(compressed.body).toString("utf8")).toBe(scriptFixture);

    const strongEtag = (weakEtag ?? "").slice(2);
    const revalidated = await rawRequest(server, "/assets/app-fixture.js", {
      "Accept-Encoding": "gzip",
      "If-None-Match": strongEtag,
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body.byteLength).toBe(0);
    expect(revalidated.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(revalidated.headers.get("etag")).toBe(strongEtag);
    expect(revalidated.headers.get("vary")).toContain("Accept-Encoding");

    const weakRevalidated = await rawRequest(server, "/assets/app-fixture.js", {
      "If-None-Match": weakEtag ?? "",
    });
    expect(weakRevalidated.status).toBe(304);

    const identity = await rawRequest(server, "/assets/app-fixture.js", {});
    expect(identity.status).toBe(200);
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("etag")).toBe(strongEtag);
    expect(identity.headers.get("vary")).toContain("Accept-Encoding");
    expect(identity.body.toString("utf8")).toBe(scriptFixture);
  });

  test("foundation: brotli is preferred over gzip when the client allows both", async () => {
    const response = await rawRequest(server, "/assets/app-fixture.js", {
      "Accept-Encoding": "br, gzip",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(response.body).toString("utf8"))
      .toBe(scriptFixture);
  });

  test("foundation: the application shell compresses without losing revalidation", async () => {
    const shell = await rawRequest(server, "/review", {"Accept-Encoding": "gzip"});
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-encoding")).toBe("gzip");
    expect(shell.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(shell.headers.get("vary")).toContain("Accept-Encoding");
    expect(gunzipSync(shell.body).toString("utf8")).toBe(shellFixture);
  });

  test("foundation: small and binary responses stay identity-encoded", async () => {
    const small = await rawRequest(server, "/assets/tiny.css", {
      "Accept-Encoding": "gzip",
    });
    expect(small.status).toBe(200);
    expect(small.headers.get("content-encoding")).toBeNull();
    expect(small.headers.get("vary")).toContain("Accept-Encoding");
    expect(small.body.toString("utf8")).toBe(stylesheetFixture);

    const binary = await rawRequest(server, "/assets/logo.png", {
      "Accept-Encoding": "gzip",
    });
    expect(binary.status).toBe(200);
    expect(binary.headers.get("content-encoding")).toBeNull();
    expect(binary.headers.get("vary")).toBeNull();
    expect(new Uint8Array(binary.body)).toEqual(binaryFixture);
  });

  test("foundation: range-capable content responses are never compressed", async () => {
    const html = `<!doctype html><title>Public</title>${
      "<p>range fixture padding</p>".repeat(64)
    }`;
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: html,
      idempotencyKey: "compression-range-fixture",
    });
    const versionUrl = new URL(published.body.links.version);

    const full = await rawRequest(
      server,
      `${versionUrl.pathname}${versionUrl.search}`,
      {"Accept-Encoding": "gzip"},
      "GET",
      `${versionUrl.hostname}:${server.port}`,
    );
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-encoding")).toBeNull();
    expect(full.headers.get("vary")).toBeNull();
    expect(full.body.toString("utf8")).toBe(html);

    const partial = await rawRequest(
      server,
      `${versionUrl.pathname}${versionUrl.search}`,
      {"Accept-Encoding": "gzip", Range: "bytes=0-3"},
      "GET",
      `${versionUrl.hostname}:${server.port}`,
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(partial.headers.get("content-range")).toBe(
      `bytes 0-3/${Buffer.byteLength(html)}`,
    );
    expect(partial.body.toString("utf8")).toBe(html.slice(0, 4));
  });

  async function publishManyFiles(idempotencyKey: string) {
    const files: readonly TestSiteFile[] = [
      {
        bytes: encoder.encode("<!doctype html><title>Many files</title>"),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
      ...Array.from({length: 24}, (_, index): TestSiteFile => ({
        bytes: encoder.encode(`export const value${index} = ${index};\n`),
        mediaType: "text/javascript; charset=utf-8",
        path: `assets/section-${String(index).padStart(2, "0")}/entry.js`,
      })),
    ];
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    await uploadEveryStagedFile(installation, upload.body, files);
    return (await commitStagedUpload(
      installation,
      upload.body,
      idempotencyKey,
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Compression fixture",
        tags: [],
      },
    )).body;
  }
});

function versionDetailPath(published: {
  readonly artifact: {readonly id: string; readonly projectId: string};
  readonly version: {readonly id: string};
}): string {
  const query = new URLSearchParams({projectId: published.artifact.projectId});
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}?${query.toString()}`;
}

function rawRequest(
  server: RunningTestServer,
  requestPath: string,
  headers: Record<string, string>,
  method = "GET",
  hostHeader?: string,
): Promise<RawResponse> {
  // Raw array headers skip Node's automatic Host header, so set it always.
  const requestHeaders: string[] = [
    "Host",
    hostHeader ?? `${server.hostname}:${server.port}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    requestHeaders.push(name, value);
  }
  return new Promise<RawResponse>((resolve, reject) => {
    const outgoing = request(
      {
        headers: requestHeaders,
        hostname: server.hostname,
        method,
        path: requestPath,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              responseHeaders.append(name, value);
            }
          }
          resolve({
            body: Buffer.concat(chunks),
            headers: responseHeaders,
            status: incoming.statusCode ?? 500,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
