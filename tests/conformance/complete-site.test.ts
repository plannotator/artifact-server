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

  test("MAN-001-B MAN-002-B MAN-006-B CNT-005-B: a canonical complete site serves every declared file from one exact version origin", async () => {
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

  test("MAN-001-F MAN-005-F: absent entries, duplicate paths, and portable-name collisions are rejected before upload creation", async () => {
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
