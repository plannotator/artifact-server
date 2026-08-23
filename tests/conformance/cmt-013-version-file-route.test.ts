import {createHash} from "node:crypto";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../../src/core/identity.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const readerToken = "version-file-reader-credential";
const commentOnlyToken = "version-file-comment-only-credential";

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative(),
});
const versionDetailsSchema = z.object({
  manifest: z.object({
    digest: z.string(),
    entries: z.array(manifestEntrySchema),
    entryPath: z.string(),
    routingMode: z.enum(["spa", "static"]),
  }),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const encoder = new TextEncoder();
const siteFiles: readonly TestSiteFile[] = [
  {
    bytes: encoder.encode("<!doctype html><title>Review me</title><p>hello</p>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: encoder.encode("export const revenue = [1, 2, 3];\n"),
    mediaType: "text/javascript; charset=utf-8",
    path: "assets/app.js",
  },
  {
    bytes: new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]),
    mediaType: "image/png",
    path: "assets/pixel.png",
  },
];

describe("version file route for the review viewer", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: versionFileVerifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-013-B: an artifact-read principal reads exact manifest bytes with non-renderable headers", async () => {
    expect.hasAssertions();
    const published = await publishSite("account_required", "version-file-behavior");
    const entries = await readManifestEntries(published);
    expect(entries.map((entry) => entry.path).toSorted()).toEqual([
      "assets/app.js",
      "assets/pixel.png",
      "index.html",
    ]);

    const readBytes = await Promise.all(siteFiles.map(async (file) => {
      const response = await fileFetch(readerToken, published, file.path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=31536000, immutable",
      );
      return {file, served: new Uint8Array(await response.arrayBuffer())};
    }));
    for (const {file, served} of readBytes) {
      const entry = entries.find((candidate) => candidate.path === file.path);
      if (entry === undefined) {
        throw new Error(`The manifest does not declare ${file.path}.`);
      }
      expect(served).toEqual(file.bytes);
      expect(served.byteLength).toBe(entry.size);
      expect(digestOf(served)).toBe(entry.sha256);
    }

    const overCapability = await fileFetch(
      installation.apiToken,
      published,
      "index.html",
    );
    expect(overCapability.status).toBe(200);
    expect(overCapability.headers.get("content-length")).toBe(
      String(siteFiles[0]?.bytes.byteLength),
    );

    const probed = await fileFetch(readerToken, published, "index.html", "HEAD");
    expect(probed.status).toBe(200);
    expect(probed.headers.get("content-length")).toBe(
      String(siteFiles[0]?.bytes.byteLength),
    );
    expect(await probed.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });

  test("foundation: version file responses revalidate and serve byte ranges", async () => {
    expect.hasAssertions();
    const published = await publishSite("account_required", "version-file-caching");
    const entries = await readManifestEntries(published);
    const indexEntry = entries.find((entry) => entry.path === "index.html");
    if (indexEntry === undefined) {
      throw new Error("The manifest does not declare index.html.");
    }

    const full = await fileFetch(readerToken, published, "index.html");
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(full.headers.get("etag")).toBe(`"${indexEntry.sha256}"`);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    await full.arrayBuffer();

    const revalidated = await fileFetch(readerToken, published, "index.html", "GET", {
      "If-None-Match": `"${indexEntry.sha256}"`,
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(revalidated.headers.get("etag")).toBe(`"${indexEntry.sha256}"`);
    expect(await revalidated.text()).toBe("");

    const weakRevalidated = await fileFetch(readerToken, published, "index.html", "GET", {
      "If-None-Match": `W/"${indexEntry.sha256}"`,
    });
    expect(weakRevalidated.status).toBe(304);

    const partial = await fileFetch(readerToken, published, "index.html", "GET", {
      Range: "bytes=2-5",
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(
      `bytes 2-5/${indexEntry.size}`,
    );
    expect(partial.headers.get("content-length")).toBe("4");
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await partial.arrayBuffer()))
      .toEqual(siteFiles[0]?.bytes.slice(2, 6));

    const staleRange = await fileFetch(readerToken, published, "index.html", "GET", {
      "If-Range": '"different-validator"',
      Range: "bytes=2-5",
    });
    expect(staleRange.status).toBe(200);
    expect(staleRange.headers.get("content-length")).toBe(
      String(indexEntry.size),
    );
    await staleRange.arrayBuffer();

    const unsatisfiable = await fileFetch(readerToken, published, "index.html", "GET", {
      Range: `bytes=${indexEntry.size}-`,
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(
      `bytes */${indexEntry.size}`,
    );
  });

  test("CMT-013-F: unauthenticated, public-link, and read-incapable requests get no manifest bytes", async () => {
    expect.hasAssertions();
    const published = await publishSite("public_link", "version-file-failure");

    const anonymous = await fetch(
      `${server.baseUrl}${filePath(published, "index.html")}`,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect(await anonymous.text()).not.toContain("<!doctype html>");

    const publicBytes = await fetchVersion(server, published.links.version);
    expect(publicBytes.status).toBe(200);
    const publicFileRoute = await fetchVersion(
      server,
      `${published.links.version.replace(/\/$/u, "")}${filePath(published, "index.html")}`,
    );
    expect(publicFileRoute.status).toBe(404);
    expect(new Uint8Array(await publicFileRoute.arrayBuffer()))
      .not.toEqual(siteFiles[0]?.bytes);

    const contentOrigin = await fetchVersion(
      server,
      `http://${published.version.contentToken}.localhost${filePath(published, "assets/app.js")}`,
      "GET",
      {Authorization: `Bearer ${installation.apiToken}`},
    );
    expect(contentOrigin.status).toBe(404);
    expect(await contentOrigin.text()).not.toContain("export const revenue");

    const readIncapable = await fileFetch(
      commentOnlyToken,
      published,
      "index.html",
    );
    expect(readIncapable.status).toBe(403);
    expect(failureSchema.parse(await readIncapable.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");

    const unknownPath = await fileFetch(
      readerToken,
      published,
      "assets/secret-report.pdf",
    );
    expect(unknownPath.status).toBe(404);
    const unknownFailure = failureSchema.parse(await unknownPath.json());
    expect(unknownFailure.error.code).toBe("VERSION_NOT_FOUND");
    const missingVersion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/ver_absent/file?projectId=${published.artifact.projectId}&path=index.html`,
      {headers: {Authorization: `Bearer ${readerToken}`}},
    );
    expect(missingVersion.status).toBe(404);
    const missingFailure = failureSchema.parse(await missingVersion.json());
    expect(missingFailure.error.code).toBe(unknownFailure.error.code);
    for (const file of siteFiles) {
      expect(unknownFailure.error.message).not.toContain(file.path);
      expect(unknownFailure.error.message).not.toContain(
        file.path.split("/").at(-1) ?? file.path,
      );
    }
    expect(unknownFailure.error.message).not.toContain("assets");
    expect(unknownFailure.error.message)
      .not.toContain(published.version.manifestDigest);

    const rendered = await fileFetch(readerToken, published, "index.html");
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-type")).toBe("application/octet-stream");
    expect(rendered.headers.get("content-disposition")).toBe("attachment");
    expect(rendered.headers.get("x-content-type-options")).toBe("nosniff");
  });

  async function publishSite(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      siteFiles,
    );
    await uploadEveryStagedFile(installation, upload.body, siteFiles);
    return (await commitStagedUpload(
      installation,
      upload.body,
      idempotencyKey,
      {accessSetting, kind: "new_artifact", name: "Review site", tags: []},
    )).body;
  }

  async function readManifestEntries(
    published: PublishResponse,
  ): Promise<readonly z.infer<typeof manifestEntrySchema>[]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return versionDetailsSchema.parse(await response.json()).manifest.entries;
  }

  async function fileFetch(
    token: string,
    published: PublishResponse,
    path: string,
    method = "GET",
    conditionalHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${filePath(published, path)}`, {
      headers: {...conditionalHeaders, Authorization: `Bearer ${token}`},
      method,
    });
  }
});

function filePath(published: PublishResponse, path: string): string {
  const query = new URLSearchParams({
    path,
    projectId: published.artifact.projectId,
  });
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/file?${query.toString()}`;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const versionFileVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const token = Redacted.value(credential);
    if (token === readerToken) {
      return Effect.succeed({
        authorizedByPrincipalId: "member_reviewer",
        capabilities: [principalCapabilities.readArtifacts],
        displayName: "Review viewer key",
        id: "service:key_reader",
        installationId: "local",
        kind: principalKinds.service,
        membershipRole: membershipRoles.member,
      });
    }
    if (token === commentOnlyToken) {
      return Effect.succeed({
        authorizedByPrincipalId: "member_reviewer",
        capabilities: [principalCapabilities.writeComments],
        displayName: "Comment-only key",
        id: "service:key_comment_only",
        installationId: "local",
        kind: principalKinds.service,
        membershipRole: membershipRoles.member,
      });
    }
    return Effect.fail(new AuthenticationRequired({
      message: "The version file credential is invalid.",
    }));
  },
};
