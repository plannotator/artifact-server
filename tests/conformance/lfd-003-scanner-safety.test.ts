import {execFile} from "node:child_process";
import {mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile} from "node:fs/promises";
import {createServer, type Server} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  expectFailure, historyCounts, LinkedFolderClient,
} from "../support/linked-folders.js";
import {
  removeTestInstallation, type RunningTestServer, startTestServer, type TestInstallation,
  createTestInstallation,
} from "../support/runtime-harness.js";

const run = promisify(execFile);

async function write(root: string, relative: string, contents = `${relative}\n`): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), {recursive: true});
  await writeFile(path.join(root, relative), contents);
}

/** Attach a tiny disk image under the linked directory when the platform allows it. */
async function mountVolume(mountPoint: string, imageDirectory: string): Promise<(() => Promise<void>) | null> {
  if (process.platform !== "darwin") return null;
  const image = path.join(imageDirectory, "lfd-003.dmg");
  try {
    await mkdir(mountPoint, {recursive: true});
    await run("hdiutil", ["create", "-size", "1m", "-fs", "HFS+", "-volname", "lfd003", "-quiet", image]);
    await run("hdiutil", ["attach", image, "-mountpoint", mountPoint, "-nobrowse", "-quiet"]);
    await writeFile(path.join(mountPoint, "on-other-device.md"), "# other device\n");
    return async () => {
      await run("hdiutil", ["detach", mountPoint, "-force", "-quiet"]).catch(() => undefined);
    };
  } catch {
    return null;
  }
}

describe("scanning never leaves the link root and applies ignore rules in order", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  let outsideRoot: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-003-")));
    outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-003-outside-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
    await rm(outsideRoot, {force: true, recursive: true});
  });

  test("LFD-003-B: built-in defaults, a re-included default, .artifactignore, and per-link patterns produce exactly the documented indexed set while .gitignore is not honored", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    const fixture = [
      "readme.md", "dist/report.html", ".gitignore", ".artifactignore", ".well-known/security.txt",
      "node_modules/pkg/index.js", ".DS_Store", "Thumbs.db", "notes.swp", "backup.md~", ".~lock.sheet.ods#",
      "~$draft.docx", "scratch.tmp", "keep.tmp", "upload.partial", "movie.crdownload", ".cache/state.json",
      "drafts/idea.md", "debug.log", "important.log", "private/secret.md", "reports/q4.md",
    ];
    await Promise.all(fixture.map((relative) => write(sourceRoot, relative)));
    await write(sourceRoot, ".gitignore", "dist/\nreports/\n*.md\n");
    await write(sourceRoot, ".artifactignore", "# drafts are local\ndrafts/\n*.log\n!important.log\n");

    const link = await client.linkOk(sourceRoot, {ignore: ["!keep.tmp", "private/"], name: "Ignore fixture"});
    const indexed = (await client.inventory(link.id)).map((entry) => entry.relativePath).toSorted();
    expect(indexed).toEqual([
      ".artifactignore", ".gitignore", ".well-known/security.txt", "dist/report.html", "important.log",
      "keep.tmp", "readme.md", "reports/q4.md",
    ]);
    expect(link.skippedCount).toBe(0);
    expect(link.ignoredCount).toBeGreaterThanOrEqual(12);

    // Per-link rules can later re-include a built-in default directory.
    const widened = await client.update(link.id, {expectedRevision: link.revision, ignore: ["!keep.tmp", "!node_modules/"]});
    expect(widened.state).toBe("active");
    const widenedPaths = (await client.inventory(link.id)).map((entry) => entry.relativePath);
    expect(widenedPaths).toContain("node_modules/pkg/index.js");
    expect(widenedPaths).toContain("private/secret.md");
    expect(widenedPaths).not.toContain("drafts/idea.md");
  }, 30_000);

  test("LFD-003-F: symlinks, loops, special files, other devices, the nested data directory, .git, hostile names, oversized, deep, and an over-limit .artifactignore are never capturable or descended into", async () => {
    const nestedData = path.join(sourceRoot, "server-state");
    const nestedInstallation = {...installation, dataDirectory: nestedData};
    server = await startTestServer(nestedInstallation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    cleanups.push(() => removeTestInstallation(nestedInstallation));
    const linked = path.join(sourceRoot, "linked");
    await write(linked, "ok.md", "# the one capturable file\n");
    await write(linked, "real/inner.md");
    await write(outsideRoot, "outside.md", "# outside the root\n");
    await mkdir(path.join(outsideRoot, "outside-dir"));
    await write(outsideRoot, "outside-dir/escape.md");
    await symlink(path.join(linked, "ok.md"), path.join(linked, "file-link.md"));
    await symlink(path.join(linked, "real"), path.join(linked, "dir-link"));
    await symlink(path.join(outsideRoot, "outside.md"), path.join(linked, "outside-link.md"));
    await symlink(path.join(outsideRoot, "outside-dir"), path.join(linked, "outside-dir-link"));
    await symlink(path.join(linked, "loop-b"), path.join(linked, "loop-a"));
    await symlink(path.join(linked, "loop-a"), path.join(linked, "loop-b"));
    await run("mkfifo", [path.join(linked, "pipe")]);
    const socket: Server = createServer();
    await new Promise<void>((resolve) => socket.listen(path.join(linked, "sock"), resolve));
    cleanups.push(() => new Promise((resolve) => socket.close(() => resolve())));
    await write(linked, ".git/config", "[core]\n");
    await write(linked, ".git/objects/aa/bb", "object\n");
    await write(linked, "bad\u0001name.md");
    await write(linked, "spoof‮txt.md");
    await writeFile(path.join(linked, "huge.bin"), "");
    await truncate(path.join(linked, "huge.bin"), 1_024 * 1_024 * 1_024 + 1);
    const deep = Array.from({length: 17}, (_, index) => `d${index + 1}`).join("/");
    await write(linked, `${deep}/too-deep.md`);
    const detach = await mountVolume(path.join(linked, "mounted"), outsideRoot);
    if (detach !== null) cleanups.unshift(detach);

    // The data directory sits inside the linked directory, so link the parent.
    const link = await client.linkOk(sourceRoot, {name: "Hostile fixture"});
    const entries = await client.inventory(link.id);
    const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
    const skipped = (relative: string) => byPath.get(relative)?.skipReason;
    expect(entries.filter((entry) => entry.state === "untracked").map((entry) => entry.relativePath).toSorted())
      .toEqual(["linked/ok.md", "linked/real/inner.md"]);
    for (const relative of ["file-link.md", "dir-link", "outside-link.md", "outside-dir-link", "loop-a", "loop-b"]) {
      expect(skipped(`linked/${relative}`)).toBe("symlink");
    }
    expect(skipped("linked/pipe")).toBe("special");
    expect(skipped("linked/sock")).toBe("special");
    expect(skipped("linked/huge.bin")).toBe("too-large");
    expect(skipped(`linked/${deep.split("/").slice(0, 15).join("/")}`)).toBe("too-deep");
    expect(entries.find((entry) => entry.relativePath.startsWith("linked/bad"))?.skipReason).toBe("hostile-name");
    expect(entries.find((entry) => entry.relativePath.startsWith("linked/bad"))?.relativePath).toBe("linked/bad\\u{1}name.md");
    expect(entries.find((entry) => entry.relativePath.startsWith("linked/spoof"))?.skipReason).toBe("hostile-name");
    // A real mount is attached where the platform allows it (macOS hdiutil);
    // elsewhere the directory is absent and records nothing.
    expect(skipped("linked/mounted")).toBe(detach === null ? undefined : "other-device");
    for (const entry of entries) {
      expect(entry.relativePath.startsWith("server-state")).toBe(false);
      expect(entry.relativePath.includes(".git/")).toBe(false);
      expect(entry.relativePath.startsWith("linked/dir-link/")).toBe(false);
      expect(entry.relativePath.startsWith("linked/outside-dir-link/")).toBe(false);
      expect(entry.relativePath.startsWith("linked/mounted/")).toBe(false);
      expect(entry.relativePath.startsWith("linked/loop-")).toBe(entry.relativePath === "linked/loop-a" || entry.relativePath === "linked/loop-b");
    }

    const skippedIds = entries.filter((entry) => entry.state === "skipped").map((entry) => entry.id);
    const before = historyCounts(nestedInstallation);
    const results = await client.captureOk(link.id, {entryIds: skippedIds});
    expect(results.every((result) => result.status === "refused" && result.code === "ENTRY_NOT_CAPTURABLE")).toBe(true);
    expect(historyCounts(nestedInstallation)).toEqual(before);

    // An over-limit .artifactignore puts its link over-limit without indexing anything new.
    const oversized = path.join(outsideRoot, "oversized-ignore");
    await write(oversized, "a.md");
    await write(oversized, ".artifactignore", "*.never\n".repeat(9_000));
    await server.stop();
    server = await startTestServer(nestedInstallation, {
      linkRoots: [sourceRoot, outsideRoot], linkedFiles: "on", linkedFolderWatch: "off",
    });
    const reopened = new LinkedFolderClient(server, installation.apiToken);
    const overLimit = await reopened.linkOk(oversized, {name: "Oversized ignore"});
    expect(overLimit).toMatchObject({entryCount: 0, overLimitReason: "ignore-file", state: "over-limit"});
    await expectFailure(await reopened.link(path.join(oversized)), 409, "LINK_OVERLAP");
  }, 60_000);
});
