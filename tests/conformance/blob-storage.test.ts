import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {LocalBlobStore} from "../../src/storage/local-blob-store.js";

describe("local immutable blob storage", () => {
  let directory: string;
  let store: LocalBlobStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-blob-test-"));
    store = new LocalBlobStore(directory);
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("PUB-004-F: a conflicting stream cannot replace an existing fingerprint", async () => {
    const original = Buffer.from("the original immutable bytes");
    const digest = createHash("sha256").update(original).digest("hex");
    await store.put({
      body: chunkedBody(original),
      sha256: digest,
      size: original.byteLength,
    });

    const conflicting = Buffer.from("different bytes with a false fingerprint");
    await expect(store.put({
      body: chunkedBody(conflicting),
      sha256: digest,
      size: conflicting.byteLength,
    })).rejects.toThrow(`Incoming blob does not match fingerprint ${digest}`);

    const stored = await store.open(digest);
    await expect(new Response(stored.body).arrayBuffer()).resolves.toEqual(
      original.buffer.slice(
        original.byteOffset,
        original.byteOffset + original.byteLength,
      ),
    );
  });
});

function chunkedBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const middle = Math.ceil(bytes.byteLength / 2);
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes.subarray(0, middle));
      controller.enqueue(bytes.subarray(middle));
      controller.close();
    },
  });
}
