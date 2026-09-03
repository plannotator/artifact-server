import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

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

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();
const encoder = new TextEncoder();
const imageBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const videoBytes = encoder.encode("webm-preview-range-fixture");
const previewFiles: readonly TestSiteFile[] = [
  {
    bytes: encoder.encode("<!doctype html><title>Preview boundary</title>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: imageBytes,
    mediaType: "image/png",
    path: "media/pixel image.png",
  },
  {
    bytes: videoBytes,
    mediaType: "video/webm",
    path: "media/clip.webm",
  },
];

describe("authenticated media preview delivery", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let sessionCookie: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    sessionCookie = await createLocalOwnerSession(server);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRV-003-B: exact image and ranged video bytes use typed, immutable, media-only responses", async () => {
    const published = await publishPreviewFixture(
      server,
      installation,
      "media-preview-route-behavior",
    );

    const image = await mediaFetch(
      server,
      sessionCookie,
      published,
      "media/pixel image.png",
      "image",
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''pixel%20image.png",
    );
    expect(image.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(image.headers.get("accept-ranges")).toBe("bytes");
    expect(image.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(image.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(image.headers.get("vary")).toBe(
      "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site",
    );
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBytes);

    const rangedVideo = await mediaFetch(
      server,
      sessionCookie,
      published,
      "media/clip.webm",
      "video",
      "GET",
      {Range: "bytes=5-11"},
    );
    expect(rangedVideo.status).toBe(206);
    expect(rangedVideo.headers.get("content-type")).toBe("video/webm");
    expect(rangedVideo.headers.get("content-range")).toBe(
      `bytes 5-11/${videoBytes.byteLength}`,
    );
    expect(new Uint8Array(await rangedVideo.arrayBuffer())).toEqual(
      videoBytes.slice(5, 12),
    );

    const head = await mediaFetch(
      server,
      sessionCookie,
      published,
      "media/clip.webm",
      "empty",
      "HEAD",
      {"Sec-Fetch-Mode": "cors"},
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(videoBytes.byteLength));
    expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0));

    const download = await fetch(
      `${server.baseUrl}${versionFilePath(published, "media/pixel image.png")}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe(
      "attachment; filename=\"pixel image.png\"; "
        + "filename*=UTF-8''pixel%20image.png",
    );
  });

  test("PRV-003-F: hostile contexts, unsupported types, and absent paths fail closed", async () => {
    const published = await publishPreviewFixture(
      server,
      installation,
      "media-preview-route-failure",
    );
    const route = `${server.baseUrl}${mediaPath(published, "media/pixel image.png")}`;
    const hostileHeaders = [
      {},
      previewHeaders("image", {"Sec-Fetch-Site": "cross-site"}),
      previewHeaders("document", {"Sec-Fetch-Mode": "navigate"}),
      previewHeaders("iframe"),
      previewHeaders("frame"),
      previewHeaders("object"),
      previewHeaders("embed"),
      previewHeaders("empty"),
      previewHeaders("video"),
    ];
    const hostileResponses = await Promise.all(hostileHeaders.map((headers) =>
      fetchVersion(server, route, "GET", {
        Cookie: sessionCookie,
        ...headers,
      })
    ));
    expect(hostileResponses.map(({status}) => status)).toEqual(
      hostileHeaders.map(() => 403),
    );
    const hostileFailures = await Promise.all(
      hostileResponses.map(async (response) => failureSchema.parse(
        await response.json(),
      )),
    );
    expect(hostileFailures.map(({error}) => error.code)).toEqual(
      hostileHeaders.map(() => "MEDIA_PREVIEW_CONTEXT_REQUIRED"),
    );

    const forgedBearer = await fetchVersion(server, route, "GET", {
        ...previewHeaders("image"),
        Authorization: `Bearer ${installation.apiToken}`,
    });
    expect(forgedBearer.status).toBe(403);
    expect(failureSchema.parse(await forgedBearer.json()).error.code).toBe(
      "MEDIA_PREVIEW_CONTEXT_REQUIRED",
    );

    const unsupported = await mediaFetch(
      server,
      sessionCookie,
      published,
      "index.html",
      "image",
    );
    expect(unsupported.status).toBe(415);
    expect(failureSchema.parse(await unsupported.json()).error.code).toBe(
      "MEDIA_PREVIEW_TYPE_UNSUPPORTED",
    );

    const absent = await mediaFetch(
      server,
      sessionCookie,
      published,
      "media/private.png",
      "image",
    );
    expect(absent.status).toBe(404);
    expect(failureSchema.parse(await absent.json()).error.code).toBe(
      "VERSION_NOT_FOUND",
    );

    const anonymous = await fetchVersion(
      server,
      route,
      "GET",
      previewHeaders("image"),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("pixel image.png");
  });
});

async function createLocalOwnerSession(
  server: RunningTestServer,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/auth/local-owner`, {
    headers: {
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    method: "POST",
  });
  if (response.status !== 204) {
    throw new Error("The test server did not issue a local-owner session.");
  }
  const session = response.headers.getSetCookie().find(
    (value) => value.startsWith("artifact_session="),
  );
  const pair = session?.split(";", 1)[0];
  if (pair === undefined) {
    throw new Error("The local-owner response omitted its session cookie.");
  }
  return pair;
}

async function publishPreviewFixture(
  server: RunningTestServer,
  installation: TestInstallation,
  idempotencyKey: string,
): Promise<PublishResponse> {
  const upload = await createStagedUpload(
    server,
    installation,
    "index.html",
    previewFiles,
  );
  await uploadEveryStagedFile(installation, upload.body, previewFiles);
  return (await commitStagedUpload(
    installation,
    upload.body,
    idempotencyKey,
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Media preview fixture",
      tags: [],
    },
  )).body;
}

function mediaFetch(
  server: RunningTestServer,
  cookie: string,
  published: PublishResponse,
  path: string,
  destination: string,
  method = "GET",
  additionalHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetchVersion(
    server,
    `${server.baseUrl}${mediaPath(published, path)}`,
    method,
    {
      Cookie: cookie,
      ...previewHeaders(destination),
      ...additionalHeaders,
    },
  );
}

function previewHeaders(
  destination: string,
  overrides: Record<string, string> = {},
) {
  return {
    "Sec-Fetch-Dest": destination,
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
    ...overrides,
  };
}

function mediaPath(published: PublishResponse, path: string): string {
  const query = new URLSearchParams({
    path,
    projectId: published.artifact.projectId,
  });
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/media?${query}`;
}

function versionFilePath(published: PublishResponse, path: string): string {
  const query = new URLSearchParams({
    path,
    projectId: published.artifact.projectId,
  });
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/file?${query}`;
}
