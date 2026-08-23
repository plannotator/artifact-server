import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  canonicalizeLinkPath,
  canonicalizeLinkRoots,
  captureSource,
  checkLinkRoots,
  checkSelfProtection,
  computeFingerprint,
  openVerifiedSource,
  refreshFreshness,
} from "../../src/local/linked-source-engine.js";

async function fingerprintOf(target: string): Promise<string> {
  return computeFingerprint(await lstat(target, {bigint: true}));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    // Stream order is the point of the read; chunks must arrive in sequence.
    // eslint-disable-next-line no-await-in-loop
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("linked source engine", () => {
  let workspace: string;
  let root: string;
  let outside: string;
  let filePath: string;

  beforeEach(async () => {
    // tmpdir sits behind a symlink on macOS; the engine contract takes
    // canonical paths, so the fixture starts from one.
    workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "artifact-server-linked-")),
    );
    root = path.join(workspace, "root");
    outside = path.join(workspace, "outside");
    await mkdir(root, {recursive: true});
    await mkdir(outside, {recursive: true});
    filePath = path.join(root, "notes.md");
    await writeFile(filePath, "# notes\n");
  });

  afterEach(async () => {
    await rm(workspace, {force: true, recursive: true});
  });

  describe("canonicalization", () => {
    test("a relative path is rejected before any filesystem access", async () => {
      await expect(canonicalizeLinkPath("notes.md")).rejects.toMatchObject({
        _tag: "InvalidLinkPath",
      });
    });

    test("a missing target, a directory, and a dangling symlink are rejected", async () => {
      await expect(canonicalizeLinkPath(path.join(root, "absent.md")))
        .rejects.toMatchObject({_tag: "InvalidLinkPath"});
      await expect(canonicalizeLinkPath(root))
        .rejects.toMatchObject({_tag: "InvalidLinkPath"});
      const dangling = path.join(root, "dangling");
      await symlink(path.join(root, "nowhere"), dangling);
      await expect(canonicalizeLinkPath(dangling))
        .rejects.toMatchObject({_tag: "InvalidLinkPath"});
    });

    test("a symlink resolves to its target so containment is checked on the real file", async () => {
      const escape = path.join(root, "escape.md");
      const victim = path.join(outside, "victim.md");
      await writeFile(victim, "outside\n");
      await symlink(victim, escape);
      const canonical = await canonicalizeLinkPath(escape);
      expect(canonical).toBe(await canonicalizeLinkPath(victim));
      const roots = await canonicalizeLinkRoots([root]);
      expect(() => checkLinkRoots(canonical, roots)).toThrowError(
        expect.objectContaining({_tag: "LinkPathOutsideRoots"}),
      );
    });

    test("error messages never include the presented path", async () => {
      const secret = path.join(outside, "secret-place", "hidden.md");
      const failure = await canonicalizeLinkPath(secret).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).not.toContain("secret-place");
    });
  });

  describe("link roots", () => {
    test("dot-dot traversal cannot escape a root because paths canonicalize first", async () => {
      const sneaky = path.join(root, "..", "outside", "victim.md");
      await writeFile(path.join(outside, "victim.md"), "outside\n");
      const canonical = await canonicalizeLinkPath(sneaky);
      const roots = await canonicalizeLinkRoots([root]);
      expect(() => checkLinkRoots(canonical, roots)).toThrowError(
        expect.objectContaining({_tag: "LinkPathOutsideRoots"}),
      );
    });

    test("a file inside any configured root passes", async () => {
      const roots = await canonicalizeLinkRoots([outside, root]);
      const canonical = await canonicalizeLinkPath(filePath);
      expect(() => checkLinkRoots(canonical, roots)).not.toThrow();
    });

    test("a misconfigured root fails loudly instead of changing the boundary", async () => {
      await expect(canonicalizeLinkRoots([path.join(workspace, "absent")]))
        .rejects.toThrowError(/link root/);
      await expect(canonicalizeLinkRoots([filePath]))
        .rejects.toThrowError(/link root/);
    });
  });

  describe("self-protection", () => {
    test("the data directory, its children, and the database companions are always rejected", async () => {
      const dataDirectory = path.join(workspace, "data");
      const databasePath = path.join(dataDirectory, "artifact-server.db");
      await mkdir(path.join(dataDirectory, "blobs"), {recursive: true});
      await writeFile(databasePath, "db");
      const protectedPaths = {databasePath, dataDirectory};
      for (const target of [
        dataDirectory,
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
        path.join(dataDirectory, "blobs", "aa"),
      ]) {
        // Each protected location must be rejected in order, one by one.
        // eslint-disable-next-line no-await-in-loop
        await expect(checkSelfProtection(target, protectedPaths))
          .rejects.toMatchObject({_tag: "LinkPathProtected"});
      }
    });

    test("a database that lives outside the data directory is still protected", async () => {
      const databasePath = path.join(outside, "elsewhere.db");
      await writeFile(databasePath, "db");
      const protectedPaths = {
        databasePath,
        dataDirectory: path.join(workspace, "data"),
      };
      await expect(checkSelfProtection(databasePath, protectedPaths))
        .rejects.toMatchObject({_tag: "LinkPathProtected"});
      await expect(checkSelfProtection(`${databasePath}-wal`, protectedPaths))
        .rejects.toMatchObject({_tag: "LinkPathProtected"});
    });

    test("an ordinary file outside the protected locations passes", async () => {
      const protectedPaths = {
        databasePath: path.join(workspace, "data", "artifact-server.db"),
        dataDirectory: path.join(workspace, "data"),
      };
      await expect(checkSelfProtection(filePath, protectedPaths))
        .resolves.toBeUndefined();
    });
  });

  describe("freshness", () => {
    test("an untouched file is in-sync and a rewritten file is modified", async () => {
      const stored = await fingerprintOf(filePath);
      expect(await refreshFreshness(filePath, stored)).toEqual({
        fingerprint: stored,
        freshness: "in-sync",
      });
      await writeFile(filePath, "# notes, edited\n");
      const observed = await refreshFreshness(filePath, stored);
      expect(observed.freshness).toBe("modified");
      expect(observed.fingerprint).not.toBe(stored);
    });

    test("a deleted file is missing and a permission-denied file is unreadable", async () => {
      const stored = await fingerprintOf(filePath);
      await unlink(filePath);
      expect(await refreshFreshness(filePath, stored)).toEqual({
        fingerprint: null,
        freshness: "missing",
      });
      const locked = path.join(root, "locked", "notes.md");
      await mkdir(path.dirname(locked));
      await writeFile(locked, "locked\n");
      const lockedFingerprint = await fingerprintOf(locked);
      await chmod(path.dirname(locked), 0o000);
      try {
        const observed = await refreshFreshness(locked, lockedFingerprint);
        expect(observed.freshness).toBe("unreadable");
      } finally {
        await chmod(path.dirname(locked), 0o700);
      }
    });

    test("a regular file replaced by a symlink is unreadable, never followed", async () => {
      const stored = await fingerprintOf(filePath);
      const victim = path.join(outside, "victim.md");
      await writeFile(victim, "victim\n");
      await unlink(filePath);
      await symlink(victim, filePath);
      expect((await refreshFreshness(filePath, stored)).freshness).toBe(
        "unreadable",
      );
    });
  });

  describe("verified open", () => {
    test("stat and bytes come from the same descriptor even when the path is swapped", async () => {
      const stored = await fingerprintOf(filePath);
      const source = await openVerifiedSource(filePath, stored);
      const victim = path.join(outside, "victim.md");
      await writeFile(victim, "victim bytes that must never be served\n");
      await unlink(filePath);
      await symlink(victim, filePath);
      const bytes = await readAll(source.stream());
      expect(bytes.toString()).toBe("# notes\n");
    });

    test("a symlink at the final path is refused by O_NOFOLLOW", async () => {
      const victim = path.join(outside, "victim.md");
      await writeFile(victim, "victim\n");
      await unlink(filePath);
      await symlink(victim, filePath);
      await expect(openVerifiedSource(filePath)).rejects.toMatchObject({
        _tag: "SourceUnreadable",
      });
    });

    test("an expected-fingerprint mismatch aborts with the retryable drift error", async () => {
      const stored = await fingerprintOf(filePath);
      await writeFile(filePath, "# notes, edited\n");
      await expect(openVerifiedSource(filePath, stored)).rejects.toMatchObject({
        _tag: "SourceDrifted",
      });
    });

    test("a missing file surfaces as missing", async () => {
      await unlink(filePath);
      await expect(openVerifiedSource(filePath)).rejects.toMatchObject({
        _tag: "SourceMissing",
      });
    });
  });

  describe("capture", () => {
    test("capture hashes and spools exactly the bytes of one descriptor pass", async () => {
      const body = `# capture\n${"x".repeat(200_000)}\n`;
      await writeFile(filePath, body);
      const spoolDirectory = path.join(workspace, "spool");
      const captured = await captureSource(filePath, spoolDirectory);
      expect(captured.size).toBe(Buffer.byteLength(body));
      expect(captured.sha256).toBe(
        createHash("sha256").update(body).digest("hex"),
      );
      expect(captured.fingerprint).toBe(await fingerprintOf(filePath));
      const spooled = await readAll(await captured.openStream());
      expect(spooled.toString()).toBe(body);
      await captured.discard();
      await expect(readFile(captured.spoolPath)).rejects.toThrow(/ENOENT/);
    });

    test("a modification during the read aborts the capture and removes the spool", async () => {
      await writeFile(filePath, `start\n${"y".repeat(300_000)}\n`);
      const spoolDirectory = path.join(workspace, "spool");
      await expect(captureSource(filePath, spoolDirectory, {
        afterFirstRead: async () => {
          await writeFile(filePath, "swapped mid-read\n");
        },
      })).rejects.toMatchObject({_tag: "SourceDrifted"});
      expect(await readdir(spoolDirectory)).toEqual([]);
    });

    test("a capture of a path swapped to a symlink is refused", async () => {
      const victim = path.join(outside, "victim.md");
      await writeFile(victim, "victim\n");
      await unlink(filePath);
      await symlink(victim, filePath);
      await expect(captureSource(filePath, path.join(workspace, "spool")))
        .rejects.toMatchObject({_tag: "SourceUnreadable"});
    });
  });
});
