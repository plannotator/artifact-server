import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {z} from "zod";

import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  uploadStagedFile,
  type CreateUploadResponse,
  type TestSiteFile,
} from "../support/publishing.js";

describe("complete-site publishing", () => {
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

  test("MAN-006-B CNT-005-B: a canonical complete site serves every declared file from one exact version origin", async () => {
    const files = siteFixture();
    const firstPlan = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    const equivalentPlan = await createStagedUpload(
      server,
      installation,
      "index.html",
      files.toReversed(),
    );
    expect(firstPlan.response.status).toBe(201);
    expect(equivalentPlan.response.status).toBe(201);
    expect(equivalentPlan.body.manifestDigest).toBe(firstPlan.body.manifestDigest);
    expect(firstPlan.body.files.map((file) => file.path)).toEqual(
      files.map((file) => file.path).toSorted(),
    );

    const uploads = await uploadEveryStagedFile(
      installation,
      firstPlan.body,
      files,
    );
    expect(uploads.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    await Promise.all(uploads.map((response) => response.arrayBuffer()));

    const committed = await commitStagedUpload(
      installation,
      firstPlan.body,
      "complete-site-first-commit",
      {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Complete site",
      },
    );
    expect(committed.response.status).toBe(201);

    const versionOrigin = new URL(committed.body.links.version).origin;
    for (const file of files) {
      const fileUrl = new URL(`/${file.path}`, committed.body.links.version);
      expect(fileUrl.origin).toBe(versionOrigin);
      // Requests remain ordered so each response body is consumed before restart.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchVersion(server, fileUrl.toString());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(file.mediaType);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("etag")).toBe(
        `"${createHash("sha256").update(file.bytes).digest("hex")}"`,
      );
      // eslint-disable-next-line no-await-in-loop
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
    }

    const root = await fetchVersion(server, committed.body.links.version);
    expect(await root.text()).toContain("/assets/app.js");
    const missing = await fetchVersion(
      server,
      new URL("/assets/missing.js", committed.body.links.version).toString(),
    );
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    await server.stop();
    server = await startTestServer(installation);
    const afterRestart = await fetchVersion(
      server,
      new URL("/docs/about.html", committed.body.links.version).toString(),
    );
    expect(await afterRestart.text()).toContain("About this artifact");

    const updatedFiles = files.map((file) => {
      if (file.path !== "index.html") return file;
      return {
        bytes: utf8("<!doctype html><title>Updated site</title>"),
        mediaType: file.mediaType,
        path: file.path,
      };
    });
    const updatePlan = await createStagedUpload(
      server,
      installation,
      "index.html",
      updatedFiles,
    );
    const updateUploads = await uploadEveryStagedFile(
      installation,
      updatePlan.body,
      updatedFiles,
    );
    expect(updateUploads.every((response) => response.status === 200)).toBe(true);
    await Promise.all(updateUploads.map((response) => response.arrayBuffer()));
    const updated = await commitStagedUpload(
      installation,
      updatePlan.body,
      "complete-site-second-version",
      {
        artifactId: committed.body.artifact.id,
        expectedCurrentVersionId: committed.body.version.id,
        kind: "new_version",
      },
    );
    expect(updated.response.status).toBe(201);
    expect(updated.body.version.number).toBe(2);
    expect(new URL(updated.body.links.version).origin).not.toBe(versionOrigin);
    const updatedRoot = await fetchVersion(server, updated.body.links.version);
    expect(await updatedRoot.text()).toContain("Updated site");
  });

  test("foundation: a configured public origin owns every application URL behind a TLS-terminating proxy", async () => {
    await server.stop();
    server = await startTestServer(installation, {
      applicationOrigin: "https://artifacts.example.test",
    });
    const file = siteFixture().find(({path: filePath}) => filePath === "index.html");
    if (file === undefined) throw new Error("The site fixture has no entry file.");
    const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: file.path,
        files: [{
          mediaType: file.mediaType,
          path: file.path,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          size: file.bytes.byteLength,
        }],
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        Host: "artifacts.example.test",
        "X-Forwarded-Host": "artifacts.example.test",
        "X-Forwarded-Proto": "https",
      },
      method: "POST",
    });
    const plan = z.object({
      commitUrl: z.url(),
      files: z.array(z.object({uploadUrl: z.url()})),
    }).parse(await response.json());

    expect(response.status).toBe(201);
    expect(new URL(plan.commitUrl).origin)
      .toBe("https://artifacts.example.test");
    expect(plan.files.map(({uploadUrl}) => new URL(uploadUrl).origin))
      .toEqual(["https://artifacts.example.test"]);
  });

  test("PUB-001-B PUB-003-B: a staged site resumes after restart and commits only after every file is verified", async () => {
    const fixture = siteFixture();
    const files = fixture.filter(
      (file) => file.path === "index.html" || file.path === "assets/app.js",
    );
    const created = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    expect(new Date(created.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Set(created.body.files.map((file) => file.uploadUrl)).size).toBe(2);

    const firstFile = created.body.files.find((file) => file.path === files[0]?.path);
    if (firstFile === undefined || files[0] === undefined || files[1] === undefined) {
      throw new Error("The staged restart fixture is incomplete.");
    }
    const firstUpload = await uploadStagedFile(
      installation,
      firstFile,
      files[0].bytes,
    );
    expect(firstUpload.status).toBe(200);
    await firstUpload.arrayBuffer();

    await server.stop();
    server = await startTestServer(installation);
    const resumedPlan = retargetPlan(created.body, server.baseUrl);
    const secondFile = resumedPlan.files.find((file) => file.path === files[1]?.path);
    if (secondFile === undefined) {
      throw new Error("The second staged file is missing.");
    }
    const secondUpload = await uploadStagedFile(
      installation,
      secondFile,
      files[1].bytes,
    );
    expect(secondUpload.status).toBe(200);
    await secondUpload.arrayBuffer();

    const committed = await commitStagedUpload(
      installation,
      resumedPlan,
      "resumed-complete-site-commit",
      {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Resumed complete site",
      },
    );
    expect(committed.response.status).toBe(201);
    const asset = await fetchVersion(
      server,
      new URL(`/${files[1].path}`, committed.body.links.version).toString(),
    );
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(files[1].bytes);

    await rm(
      path.join(installation.dataDirectory, "staging", created.body.uploadId),
      {force: true, recursive: true},
    );
    const replay = await commitStagedUpload(
      installation,
      resumedPlan,
      "resumed-complete-site-commit",
      {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Resumed complete site",
      },
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body.version.id).toBe(committed.body.version.id);
  });

  test("MAN-005-F: absent entries, duplicate paths, and portable-name collisions are rejected before upload creation", async () => {
    const bytes = utf8("content");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const invalidManifests = [
      {
        entryPath: "missing.html",
        files: [{mediaType: "text/html", path: "index.html", sha256: fingerprint, size: bytes.byteLength}],
      },
      {
        entryPath: "index.html",
        files: [
          {mediaType: "text/html", path: "index.html", sha256: fingerprint, size: bytes.byteLength},
          {mediaType: "text/html", path: "index.html", sha256: fingerprint, size: bytes.byteLength},
        ],
      },
      {
        entryPath: "index.html",
        files: [
          {mediaType: "text/html", path: "index.html", sha256: fingerprint, size: bytes.byteLength},
          {mediaType: "text/html", path: "INDEX.HTML", sha256: fingerprint, size: bytes.byteLength},
        ],
      },
      {
        entryPath: "s.txt",
        files: [
          {mediaType: "text/plain", path: "s.txt", sha256: fingerprint, size: bytes.byteLength},
          {mediaType: "text/plain", path: "ſ.txt", sha256: fingerprint, size: bytes.byteLength},
        ],
      },
      {
        entryPath: "σ.txt",
        files: [
          {mediaType: "text/plain", path: "σ.txt", sha256: fingerprint, size: bytes.byteLength},
          {mediaType: "text/plain", path: "ς.txt", sha256: fingerprint, size: bytes.byteLength},
        ],
      },
      {
        entryPath: "ß.txt",
        files: [
          {mediaType: "text/plain", path: "ß.txt", sha256: fingerprint, size: bytes.byteLength},
          {mediaType: "text/plain", path: "ẞ.txt", sha256: fingerprint, size: bytes.byteLength},
        ],
      },
      {
        entryPath: "index.html",
        files: [{
          mediaType: "text/html\r\nx-injected: true",
          path: "index.html",
          sha256: fingerprint,
          size: bytes.byteLength,
        }],
      },
    ];

    for (const manifest of invalidManifests) {
      // Each independent request proves that no prior rejection poisoned the server.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
        body: JSON.stringify(manifest),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(422);
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }
  });

  test("CNT-007-B CNT-007-F: SPA fallback is explicit, navigation-only, and never replaces an exact file", async () => {
    const files: readonly TestSiteFile[] = [
      {
        bytes: utf8("console.log('exact asset');"),
        mediaType: "text/javascript; charset=utf-8",
        path: "assets/app.js",
      },
      {
        bytes: utf8("<!doctype html><title>SPA shell</title>"),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
    ];
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
      undefined,
      "spa",
    );
    const uploads = await uploadEveryStagedFile(installation, planned.body, files);
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "spa-routing-publication",
      {accessSetting: "public_link", kind: "new_artifact", name: "SPA"},
    );
    expect(published.body.version.routingMode).toBe("spa");

    const navigation = await fetchVersion(
      server,
      new URL("/settings/profile", published.body.links.version).toString(),
      "GET",
      {Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"},
    );
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toContain("SPA shell");

    const exactAsset = await fetchVersion(
      server,
      new URL("/assets/app.js", published.body.links.version).toString(),
      "GET",
      {Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"},
    );
    expect(await exactAsset.text()).toContain("exact asset");

    await Promise.all([
      {Accept: "text/javascript"},
      {Accept: "text/html", "Sec-Fetch-Dest": "script"},
      {Accept: "text/html", "Sec-Fetch-Mode": "cors"},
    ].map(async (headers) => {
      // Each hostile request proves that a non-navigation cannot receive HTML fallback.
      const missingAsset = await fetchVersion(
        server,
        new URL("/assets/missing.js", published.body.links.version).toString(),
        "GET",
        headers,
      );
      expect(missingAsset.status).toBe(404);
      await missingAsset.arrayBuffer();
    }));

    const staticPlan = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    await Promise.all((await uploadEveryStagedFile(
      installation,
      staticPlan.body,
      files,
    )).map((response) => response.arrayBuffer()));
    const staticSite = await commitStagedUpload(
      installation,
      staticPlan.body,
      "static-routing-remains-exact",
      {accessSetting: "public_link", kind: "new_artifact", name: "Static"},
    );
    const staticMissing = await fetchVersion(
      server,
      new URL("/settings/profile", staticSite.body.links.version).toString(),
      "GET",
      {Accept: "text/html"},
    );
    expect(staticMissing.status).toBe(404);
  });

  test("immutable files support one bounded byte range without buffering the full object", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const file = {bytes, mediaType: "video/mp4", path: "clip.mp4"};
    const planned = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
    );
    await Promise.all((await uploadEveryStagedFile(
      installation,
      planned.body,
      [file],
    )).map((response) => response.arrayBuffer()));
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "byte-range-publication",
      {accessSetting: "public_link", kind: "new_artifact", name: "Clip"},
    );
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;

    const partial = await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      {Range: "bytes=2-5"},
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(2, 6));

    const suffix = await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      {Range: "bytes=-3"},
    );
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(7));

    const head = await fetchVersion(
      server,
      published.body.links.version,
      "HEAD",
      {Range: "bytes=4-"},
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(head.headers.get("content-length")).toBe("6");
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const staleIfRange = await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      {"If-Range": '"stale"', Range: "bytes=2-5"},
    );
    expect(staleIfRange.status).toBe(200);
    expect(new Uint8Array(await staleIfRange.arrayBuffer())).toEqual(bytes);

    const notModified = await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      {"If-None-Match": etag, Range: "bytes=2-5"},
    );
    expect(notModified.status).toBe(304);

    await Promise.all([
      "bytes=20-30",
      "bytes=5-3",
      "bytes=0-1,4-5",
      "items=0-1",
    ].map(async (range) => {
      // Every unsupported or impossible range has the same non-amplifying response.
      const rejected = await fetchVersion(
        server,
        published.body.links.version,
        "GET",
        {Range: range},
      );
      expect(rejected.status).toBe(416);
      expect(rejected.headers.get("content-range")).toBe("bytes */10");
      await rejected.arrayBuffer();
    }));
  });

  test("CNT-002-B CNT-002-F: ordinary files use browser-native or download-safe responses", async () => {
    const files = [
      {bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png", path: "image.png"},
      {bytes: utf8("%PDF-1.7\n"), mediaType: "application/pdf", path: "report.pdf"},
      {bytes: new Uint8Array([0x49, 0x44, 0x33]), mediaType: "audio/mpeg", path: "audio.mp3"},
      {bytes: new Uint8Array([0, 0, 0, 20]), mediaType: "video/mp4", path: "video.mp4"},
      {bytes: utf8("plain text"), mediaType: "text/plain; charset=utf-8", path: "notes.txt"},
      {bytes: utf8("# Markdown"), mediaType: "text/markdown; charset=utf-8", path: "notes.md"},
      {bytes: utf8('{"valid":true}'), mediaType: "application/json", path: "data.json"},
      {bytes: utf8("export const value = 1;"), mediaType: "text/javascript; charset=utf-8", path: "source.js"},
      {bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), mediaType: "application/zip", path: "archive.zip"},
      {
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        path: "document.docx",
      },
      {
        bytes: utf8("not executable"),
        mediaType: "application/octet-stream",
        path: "misleading.html",
      },
    ] satisfies readonly TestSiteFile[];
    const planned = await createStagedUpload(
      server,
      installation,
      "notes.md",
      files,
    );
    await Promise.all((await uploadEveryStagedFile(
      installation,
      planned.body,
      files,
    )).map((response) => response.arrayBuffer()));
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "ordinary-file-serving",
      {accessSetting: "public_link", kind: "new_artifact", name: "File fixture"},
    );

    const downloadPaths = new Set(["archive.zip", "document.docx", "misleading.html"]);
    await Promise.all(files.map(async (file) => {
      // Fetching each stored file proves the manifest classification reaches the HTTP response.
      const response = await fetchVersion(
        server,
        new URL(`/${file.path}`, published.body.links.version).toString(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(file.mediaType);
      expect(response.headers.get("content-disposition")).toBe(
        downloadPaths.has(file.path) ? "attachment" : "inline",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
    }));
  });

  test("foundation: SPA routing rejects a non-HTML entry before allocating upload slots", async () => {
    const bytes = utf8("not html");
    const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "app.js",
        files: [{
          mediaType: "text/javascript",
          path: "app.js",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
        routingMode: "spa",
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(422);
  });

  test("foundation: HTTP upload locations reject invalid credentials and another installation", async () => {
    const file = {
      bytes: utf8("isolated"),
      mediaType: "text/plain",
      path: "proof.txt",
    };
    const files = [file];
    const created = await createStagedUpload(
      server,
      installation,
      "proof.txt",
      files,
    );
    const planned = created.body.files[0];
    if (planned === undefined) throw new Error("The isolation fixture is incomplete.");

    const unauthorized = await fetch(planned.uploadUrl, {
      body: copiedArrayBuffer(file.bytes),
      headers: {Authorization: "Bearer another-principal-token"},
      method: "PUT",
    });
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();

    const otherInstallation = await createTestInstallation();
    let otherServer: RunningTestServer | undefined;
    try {
      otherServer = await startTestServer(otherInstallation);
      const foreignPlan = retargetPlan(created.body, otherServer.baseUrl);
      const foreignFile = foreignPlan.files[0];
      if (foreignFile === undefined) throw new Error("The foreign fixture is incomplete.");
      const foreignUpload = await uploadStagedFile(
        otherInstallation,
        foreignFile,
        file.bytes,
      );
      expect(foreignUpload.status).toBe(404);
      await foreignUpload.arrayBuffer();

      const foreignCommit = await commitFailure(
        otherInstallation,
        foreignPlan,
        "foreign-installation-commit",
      );
      expect(foreignCommit.status).toBe(404);
      await foreignCommit.arrayBuffer();
    } finally {
      if (otherServer !== undefined) await otherServer.stop();
      await removeTestInstallation(otherInstallation);
    }
  });

  test("PUB-003-F: missing, truncated, oversized, and fingerprint-mismatched staged files cannot commit", async () => {
    const declared = utf8("declared bytes");
    const created = await createStagedUpload(
      server,
      installation,
      "index.html",
      [{bytes: declared, mediaType: "text/html", path: "index.html"}],
    );
    const planned = created.body.files[0];
    if (planned === undefined) throw new Error("The staged failure fixture is incomplete.");

    const missingCommit = await commitFailure(
      installation,
      created.body,
      "missing-file-commit-attempt",
    );
    expect(missingCommit.status).toBe(409);
    await expect(missingCommit.json()).resolves.toMatchObject({
      error: {code: "UPLOAD_INCOMPLETE"},
    });

    for (const invalidBytes of [
      declared.slice(0, 4),
      utf8("declared bytes plus unexpected bytes"),
      utf8("different bytes"),
    ]) {
      // The same slot remains open after each failed verification.
      // eslint-disable-next-line no-await-in-loop
      const response = await uploadStagedFile(installation, planned, invalidBytes);
      expect(response.status).toBe(422);
      // eslint-disable-next-line no-await-in-loop
      await expect(response.json()).resolves.toMatchObject({
        error: {code: "INVALID_INPUT"},
      });
    }

    const stillIncomplete = await commitFailure(
      installation,
      created.body,
      "failed-files-cannot-commit",
    );
    expect(stillIncomplete.status).toBe(409);
    await stillIncomplete.arrayBuffer();
  });
});

function siteFixture(): readonly TestSiteFile[] {
  return [
    {
      bytes: utf8("console.log('complete site');"),
      mediaType: "text/javascript; charset=utf-8",
      path: "assets/app.js",
    },
    {
      bytes: new Uint8Array([0, 1, 2, 3, 254, 255]),
      mediaType: "image/png",
      path: "assets/mark.png",
    },
    {
      bytes: utf8("<!doctype html><title>About</title><p>About this artifact</p>"),
      mediaType: "text/html; charset=utf-8",
      path: "docs/about.html",
    },
    {
      bytes: utf8(
        "<!doctype html><title>Site</title><script src=\"/assets/app.js\"></script><img src=\"/assets/mark.png\"><a href=\"/docs/about.html\">About</a>",
      ),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
  ];
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function retargetPlan(
  upload: CreateUploadResponse,
  baseUrl: string,
): CreateUploadResponse {
  return {
    ...upload,
    commitUrl: new URL(new URL(upload.commitUrl).pathname, baseUrl).toString(),
    files: upload.files.map((file) => ({
      ...file,
      uploadUrl: new URL(new URL(file.uploadUrl).pathname, baseUrl).toString(),
    })),
  };
}

async function commitFailure(
  installation: TestInstallation,
  upload: CreateUploadResponse,
  idempotencyKey: string,
): Promise<Response> {
  return fetch(upload.commitUrl, {
    body: JSON.stringify({
      target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Must not commit",
      },
    }),
    headers: {
      Authorization: `Bearer ${installation.apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
}
