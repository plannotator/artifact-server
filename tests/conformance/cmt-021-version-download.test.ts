import {unzipSync} from "fflate";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

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
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const encoder = new TextEncoder();
const firstVersionFiles: readonly TestSiteFile[] = [
  {
    bytes: encoder.encode("<!doctype html><title>First immutable version</title>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: encoder.encode("export const release = 1;\n"),
    mediaType: "text/javascript; charset=utf-8",
    path: "assets/app.js",
  },
  {
    bytes: encoder.encode("Exact nested file bytes.\n"),
    mediaType: "text/plain; charset=utf-8",
    path: "notes/review.txt",
  },
];
const secondVersionFiles: readonly TestSiteFile[] = [
  {
    bytes: encoder.encode("<!doctype html><title>Second version</title>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
];

describe("complete immutable version downloads", () => {
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

  test("CMT-021-B: a permitted user downloads the selected version as a deterministic path-preserving ZIP", async () => {
    expect.hasAssertions();
    const first = await publishNewVersion();
    const second = await publishNextVersion(first);
    expect(second.version.number).toBe(2);

    const firstResponse = await archiveFetch(first);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("content-type")).toBe("application/zip");
    expect(firstResponse.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Review export - version 1.zip\"; "
        + "filename*=UTF-8''Review%20export%20-%20version%201.zip",
    );
    expect(firstResponse.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(firstResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(firstResponse.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow",
    );
    expect(firstResponse.headers.get("etag")).toBe(
      `"archive-${first.version.manifestDigest}"`,
    );

    const firstBytes = new Uint8Array(await firstResponse.arrayBuffer());
    expect(firstBytes.byteLength).toBe(
      Number(firstResponse.headers.get("content-length")),
    );
    expectDecodedFiles(firstBytes, firstVersionFiles);

    const repeated = await archiveFetch(first);
    expect(repeated.status).toBe(200);
    expect(new Uint8Array(await repeated.arrayBuffer())).toEqual(firstBytes);

    const latest = await archiveFetch(second);
    expect(latest.status).toBe(200);
    expectDecodedFiles(
      new Uint8Array(await latest.arrayBuffer()),
      secondVersionFiles,
    );

    const head = await archiveFetch(first, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(firstBytes.byteLength));
    expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0));

    const revalidated = await archiveFetch(first, "GET", {
      "If-None-Match": `"archive-${first.version.manifestDigest}"`,
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });

  test("CMT-021-F: unauthorized and mismatched version requests disclose no artifact bytes", async () => {
    expect.hasAssertions();
    const first = await publishNewVersion();
    const other = await publishOtherArtifact();

    const anonymous = await fetch(`${server.baseUrl}${archivePath(first)}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect(await anonymous.text()).not.toContain("First immutable version");

    const mismatchedVersion = await fetch(
      `${server.baseUrl}${archivePath({
        ...first,
        version: other.version,
      })}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(mismatchedVersion.status).toBe(404);
    expect(mismatchedVersion.headers.get("content-type")).not.toBe(
      "application/zip",
    );
    expect(await mismatchedVersion.text()).not.toContain("First immutable version");

    const absentVersion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.artifact.id}/versions/ver_absent/archive?projectId=${first.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(absentVersion.status).toBe(404);
    expect(await absentVersion.text()).not.toContain("assets/app.js");
  });

  async function publishNewVersion(): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      firstVersionFiles,
    );
    await uploadEveryStagedFile(installation, upload.body, firstVersionFiles);
    return (await commitStagedUpload(
      installation,
      upload.body,
      "cmt-021-first-version",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Review export",
        tags: [],
      },
    )).body;
  }

  async function publishNextVersion(
    first: PublishResponse,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      secondVersionFiles,
      first.artifact.projectId,
    );
    await uploadEveryStagedFile(installation, upload.body, secondVersionFiles);
    return (await commitStagedUpload(
      installation,
      upload.body,
      "cmt-021-second-version",
      {
        artifactId: first.artifact.id,
        expectedCurrentVersionId: first.version.id,
        kind: "new_version",
      },
    )).body;
  }

  async function publishOtherArtifact(): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      secondVersionFiles,
    );
    await uploadEveryStagedFile(installation, upload.body, secondVersionFiles);
    return (await commitStagedUpload(
      installation,
      upload.body,
      "cmt-021-other-artifact",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Other artifact",
        tags: [],
      },
    )).body;
  }

  async function archiveFetch(
    published: PublishResponse,
    method = "GET",
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${archivePath(published)}`, {
      headers: {...headers, Authorization: `Bearer ${installation.apiToken}`},
      method,
    });
  }
});

function archivePath(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/archive?projectId=${published.artifact.projectId}`;
}

function expectDecodedFiles(
  archive: Uint8Array,
  expected: readonly TestSiteFile[],
): void {
  const decoded = unzipSync(archive);
  expect(Object.keys(decoded).toSorted()).toEqual(
    expected.map(({path}) => path).toSorted(),
  );
  for (const file of expected) {
    const bytes = decoded[file.path];
    if (bytes === undefined) {
      throw new Error(`The ZIP does not contain ${file.path}.`);
    }
    expect(bytes).toEqual(file.bytes);
  }
}
