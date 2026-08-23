import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {createNodeWebAssetStore} from "../../src/http/node-web-assets.js";

const initialScript = "export const release = 1;\n";

describe("Node web asset store", () => {
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-asset-store-"));
    await mkdir(path.join(webRoot, "assets"), {recursive: true});
    await writeFile(path.join(webRoot, "assets", "app.js"), initialScript);
  });

  afterEach(async () => {
    await rm(webRoot, {force: true, recursive: true});
  });

  test("foundation: assets are read and digested once per process", async () => {
    const store = createNodeWebAssetStore(webRoot);
    const first = await store.fetch("/assets/app.js", "GET");
    expect(first?.status).toBe(200);
    expect(first?.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const expectedEtag = `"${
      createHash("sha256").update(initialScript).digest("hex")
    }"`;
    expect(first?.headers.get("ETag")).toBe(expectedEtag);
    expect(await first?.text()).toBe(initialScript);

    // Deploys replace the process, so a disk rewrite must not change what an
    // already-running server serves for a memoized path.
    await writeFile(
      path.join(webRoot, "assets", "app.js"),
      "export const release = 2;\n",
    );
    const memoized = await store.fetch("/assets/app.js", "GET");
    expect(memoized?.headers.get("ETag")).toBe(expectedEtag);
    expect(await memoized?.text()).toBe(initialScript);
  });

  test("foundation: HEAD serves headers without a body and misses are not cached", async () => {
    const store = createNodeWebAssetStore(webRoot);
    const probed = await store.fetch("/assets/app.js", "HEAD");
    expect(probed?.status).toBe(200);
    expect(probed?.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength(initialScript)),
    );
    expect(probed?.body).toBeNull();

    expect(await store.fetch("/late.html", "GET")).toBeNull();
    await writeFile(path.join(webRoot, "late.html"), "<!doctype html>late");
    const late = await store.fetch("/late.html", "GET");
    expect(await late?.text()).toBe("<!doctype html>late");

    expect(await store.fetch("/../escape.js", "GET")).toBeNull();
    expect(await store.fetch("assets/app.js", "GET")).toBeNull();
  });
});
