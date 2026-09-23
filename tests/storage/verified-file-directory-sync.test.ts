import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {syncDirectory} from "../../src/storage/verified-file.js";

describe("syncDirectory platform behavior", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "artifact-server-sync-"));
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it("syncs a real directory on POSIX platforms", async () => {
    await expect(syncDirectory(directory, "linux")).resolves.toBeUndefined();
  });

  it("skips the directory barrier on Windows instead of failing publication", async () => {
    await expect(syncDirectory(directory, "win32")).resolves.toBeUndefined();
  });

  it("still reports a missing directory on POSIX platforms", async () => {
    await expect(
      syncDirectory(join(directory, "absent"), "linux"),
    ).rejects.toThrowError(/ENOENT/u);
  });

  it("does not touch the filesystem on Windows", async () => {
    await expect(
      syncDirectory(join(directory, "absent"), "win32"),
    ).resolves.toBeUndefined();
  });
});
