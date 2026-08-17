import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const comparisonSchema = z.object({
  added: z.array(manifestEntrySchema),
  artifact: z.object({id: z.string()}),
  changed: z.array(z.object({
    after: manifestEntrySchema,
    before: manifestEntrySchema,
    detail: z.discriminatedUnion("kind", [
      z.object({
        afterLineCount: z.number(),
        beforeLineCount: z.number(),
        change: z.object({
          after: z.array(z.string()),
          afterStartLine: z.number(),
          before: z.array(z.string()),
          beforeStartLine: z.number(),
        }).nullable(),
        kind: z.literal("text"),
      }),
      z.object({
        kind: z.literal("binary"),
        reason: z.enum(["binary_or_invalid_utf8", "text_limit_exceeded"]),
      }),
    ]),
    links: z.object({after: z.url(), before: z.url()}),
  })),
  from: z.object({id: z.string()}),
  links: z.object({from: z.url(), to: z.url()}),
  removed: z.array(manifestEntrySchema),
  renamed: z.array(z.object({
    from: manifestEntrySchema,
    to: manifestEntrySchema,
  })),
  to: z.object({id: z.string()}),
  unchangedCount: z.number(),
});

describe("artifact comparisons", () => {
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

  test("AUTH-004-B DIF-001-B DIF-002-B DIF-002-F DIF-003-B DIF-003-F DIF-004-B DIF-004-F DIF-005-B DIF-005-F: public content exposes no history while authenticated comparisons work without Git", async () => {
    const ambiguousBytes = textBytes("ambiguous rename bytes");
    const beforeFiles: readonly TestSiteFile[] = [
      file("index.html", "text/html; charset=utf-8", "same\nbefore\nend\n"),
      file("removed.txt", "text/plain", "removed"),
      file("old-name.txt", "text/plain", "certain rename"),
      {bytes: ambiguousBytes, mediaType: "text/plain", path: "old-a.txt"},
      {bytes: ambiguousBytes, mediaType: "text/plain", path: "old-b.txt"},
      {
        bytes: new Uint8Array([0, 1, 2, 3]),
        mediaType: "application/octet-stream",
        path: "binary.dat",
      },
      {
        bytes: new Uint8Array([0xc3, 0x28]),
        mediaType: "text/plain",
        path: "invalid-utf8.txt",
      },
      {
        bytes: textBytes("a".repeat(256 * 1_024 + 1)),
        mediaType: "text/plain",
        path: "large.txt",
      },
      file("docs/café note.txt", "text/plain", "before unicode path"),
      file("unchanged.txt", "text/plain", "unchanged"),
    ];
    const afterFiles: readonly TestSiteFile[] = [
      file("index.html", "text/html; charset=utf-8", "same\nafter\nend\n"),
      file("added.txt", "text/plain", "added"),
      file("new-name.txt", "text/plain", "certain rename"),
      {bytes: ambiguousBytes, mediaType: "text/plain", path: "new-a.txt"},
      {bytes: ambiguousBytes, mediaType: "text/plain", path: "new-b.txt"},
      {
        bytes: new Uint8Array([0, 1, 9, 3]),
        mediaType: "application/octet-stream",
        path: "binary.dat",
      },
      {
        bytes: new Uint8Array([0xa0, 0xa1]),
        mediaType: "text/plain",
        path: "invalid-utf8.txt",
      },
      {
        bytes: textBytes("b".repeat(256 * 1_024 + 1)),
        mediaType: "text/plain",
        path: "large.txt",
      },
      file("docs/café note.txt", "text/plain", "after unicode path"),
      file("unchanged.txt", "text/plain", "unchanged"),
    ];

    const firstUpload = await createStagedUpload(
      server,
      installation,
      "index.html",
      beforeFiles,
    );
    await uploadEveryStagedFile(installation, firstUpload.body, beforeFiles);
    const first = await commitStagedUpload(
      installation,
      firstUpload.body,
      "comparison-first-version",
      {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Comparison fixture",
      },
    );
    const decomposedPath = "docs/cafe\u0301 note.txt";
    const decomposedBytes = textBytes("normalization probe");
    const normalizationAttempt = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: decomposedPath,
        files: [{
          mediaType: "text/plain",
          path: decomposedPath,
          sha256: createHash("sha256").update(decomposedBytes).digest("hex"),
          size: decomposedBytes.byteLength,
        }],
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(normalizationAttempt.status).toBe(422);
    const secondUpload = await createStagedUpload(
      server,
      installation,
      "index.html",
      afterFiles,
    );
    await uploadEveryStagedFile(installation, secondUpload.body, afterFiles);
    const second = await commitStagedUpload(
      installation,
      secondUpload.body,
      "comparison-second-version",
      {
        artifactId: first.body.artifact.id,
        expectedCurrentVersionId: first.body.version.id,
        kind: "new_version",
      },
    );

    await expect(access(path.join(installation.dataDirectory, ".git")))
      .rejects.toMatchObject({code: "ENOENT"});

    const comparisonResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/comparisons?${new URLSearchParams({
        fromVersionId: first.body.version.id,
        toVersionId: second.body.version.id,
      })}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(comparisonResponse.status).toBe(200);
    const comparison = comparisonSchema.parse(await comparisonResponse.json());
    expect(comparison.from.id).toBe(first.body.version.id);
    expect(comparison.to.id).toBe(second.body.version.id);
    expect(comparison.unchangedCount).toBe(1);
    expect(comparison.renamed.map(({from, to}) => [from.path, to.path]))
      .toEqual([["old-name.txt", "new-name.txt"]]);
    expect(comparison.removed.map(({path: removedPath}) => removedPath)).toEqual([
      "old-a.txt",
      "old-b.txt",
      "removed.txt",
    ]);
    expect(comparison.added.map(({path: addedPath}) => addedPath)).toEqual([
      "added.txt",
      "new-a.txt",
      "new-b.txt",
    ]);
    expect(comparison.changed.map(({after}) => after.path)).toEqual([
      "binary.dat",
      "docs/café note.txt",
      "index.html",
      "invalid-utf8.txt",
      "large.txt",
    ]);

    const indexChange = comparison.changed.find(
      ({after}) => after.path === "index.html",
    );
    expect(indexChange?.detail).toEqual({
      afterLineCount: 4,
      beforeLineCount: 4,
      change: {
        after: ["after"],
        afterStartLine: 2,
        before: ["before"],
        beforeStartLine: 2,
      },
      kind: "text",
    });
    const binaryChange = comparison.changed.find(
      ({after}) => after.path === "binary.dat",
    );
    expect(binaryChange?.detail).toEqual({
      kind: "binary",
      reason: "binary_or_invalid_utf8",
    });
    expect(binaryChange?.links.before).toContain(first.body.version.contentToken);
    expect(binaryChange?.links.after).toContain(second.body.version.contentToken);
    const invalidUtf8Change = comparison.changed.find(
      ({after}) => after.path === "invalid-utf8.txt",
    );
    expect(invalidUtf8Change?.detail).toEqual({
      kind: "binary",
      reason: "binary_or_invalid_utf8",
    });
    const largeChange = comparison.changed.find(
      ({after}) => after.path === "large.txt",
    );
    expect(largeChange?.detail).toEqual({
      kind: "binary",
      reason: "text_limit_exceeded",
    });
    expect(Object.keys(binaryChange ?? {}).toSorted()).toEqual([
      "after",
      "before",
      "detail",
      "links",
    ]);

    const publicComparison = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/comparisons?${new URLSearchParams({
        fromVersionId: first.body.version.id,
        toVersionId: second.body.version.id,
      })}`,
    );
    expect(publicComparison.status).toBe(401);
    const publicHistory = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions`,
    );
    expect(publicHistory.status).toBe(401);
    const publicCurrent = await fetchVersion(server, second.body.links.version);
    expect(publicCurrent.status).toBe(200);
    await publicCurrent.arrayBuffer();
  });
});

function file(
  filePath: string,
  mediaType: string,
  content: string,
): TestSiteFile {
  return {bytes: textBytes(content), mediaType, path: filePath};
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}
