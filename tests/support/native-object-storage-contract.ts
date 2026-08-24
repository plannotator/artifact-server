import {createHash, randomBytes, randomUUID} from "node:crypto";

import {describe, expect, test} from "vitest";

import type {BlobStore, StagingStore} from "../../src/core/ports.js";
import type {StoredObjectKind} from
  "../../src/storage/cloud-object-storage.js";

const NATIVE_PROVIDER_IO_TEST_TIMEOUT_MS = 90_000;

/** Storage ports required by the shared native-provider contract. */
export interface NativeStorageAdapters {
  readonly blobs: BlobStore;
  readonly staging: StagingStore;
}

/** One raw object mutation used to prove provider metadata fails closed. */
export interface NativeStorageCorruption {
  readonly bytes: Uint8Array;
  readonly installationId: string;
  readonly kind: StoredObjectKind;
  readonly objectDigest: string;
  readonly recordedDigest: string | null;
}

/** Provider-specific construction and corruption seams for contract tests. */
export interface NativeStorageContract {
  readonly corrupt: (input: NativeStorageCorruption) => Promise<void>;
  readonly create: (installationId: string) => NativeStorageAdapters;
  readonly name: string;
}

/** Register the behavioral contract every native cloud adapter must pass. */
export function defineNativeObjectStorageContract(
  contract: NativeStorageContract,
): void {
  describe.sequential(`${contract.name} object storage`, () => {
    test("streams immutable and staged bytes with verified metadata", async () => {
      const storage = contract.create("installation-round-trip");
      const blobBytes = patternedBytes(9 * 1024 * 1024);
      const blobDigest = digest(blobBytes);
      await expect(storage.blobs.put({
        body: chunkedBody(blobBytes, 64 * 1024),
        sha256: blobDigest,
        size: blobBytes.byteLength,
      })).resolves.toEqual({sha256: blobDigest, size: blobBytes.byteLength});
      await expect(readBlob(storage.blobs, blobDigest)).resolves.toEqual(blobBytes);
      const range = {endInclusive: 2_097_159, start: 2_097_141};
      const openedRange = await storage.blobs.openRange(blobDigest, range);
      expect(openedRange).toMatchObject({
        range,
        sha256: blobDigest,
        size: blobBytes.byteLength,
      });
      await expect(new Response(openedRange.body).arrayBuffer()).resolves.toEqual(
        copiedArrayBuffer(blobBytes.slice(range.start, range.endInclusive + 1)),
      );

      const empty = new Uint8Array();
      const emptyDigest = digest(empty);
      await storage.blobs.put({
        body: chunkedBody(empty, 1),
        sha256: emptyDigest,
        size: 0,
      });
      await expect(readBlob(storage.blobs, emptyDigest)).resolves.toEqual(empty);

      const stagedBytes = new TextEncoder().encode("native staged bytes");
      const stagedDigest = digest(stagedBytes);
      const uploadId = `upl_${randomUUID()}`;
      const storageToken = stagedFileToken();
      await storage.staging.put({
        body: chunkedBody(stagedBytes, 3),
        sha256: stagedDigest,
        size: stagedBytes.byteLength,
        storageToken,
        uploadId,
      });
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(stagedBytes);
      await expect(storage.staging.remove(uploadId, storageToken))
        .resolves.toBeUndefined();
      await expect(storage.staging.open(uploadId, storageToken))
        .rejects.toBeDefined();
      await expect(storage.staging.remove(uploadId, storageToken))
        .resolves.toBeUndefined();
    }, NATIVE_PROVIDER_IO_TEST_TIMEOUT_MS);

    test("false declarations fail without replacing immutable bytes", async () => {
      const storage = contract.create("installation-immutability");
      const original = new TextEncoder().encode("original native provider bytes");
      const originalDigest = digest(original);
      await storage.blobs.put({
        body: chunkedBody(original, 4),
        sha256: originalDigest,
        size: original.byteLength,
      });
      const conflict = patternedBytes(1024 * 1024);
      await expect(storage.blobs.put({
        body: chunkedBody(conflict, 8 * 1024),
        sha256: originalDigest,
        size: conflict.byteLength,
      })).rejects.toThrow(/fingerprint/u);
      await expect(storage.blobs.put({
        body: chunkedBody(original, 4),
        sha256: originalDigest,
        size: original.byteLength - 1,
      })).rejects.toThrow(/declared/u);
      await expect(readBlob(storage.blobs, originalDigest)).resolves.toEqual(original);
    });

    test("concurrent writes are idempotent and installations stay isolated", async () => {
      const first = contract.create("installation-first");
      const second = contract.create("installation-second");
      const bytes = patternedBytes(256 * 1024);
      const fingerprint = digest(bytes);
      await Promise.all(Array.from({length: 4}, () => first.blobs.put({
        body: chunkedBody(bytes, 16 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
      })));
      await expect(readBlob(first.blobs, fingerprint)).resolves.toEqual(bytes);
      await expect(second.blobs.inspect(fingerprint)).rejects.toBeDefined();
      await expect(second.staging.open("../outside", stagedFileToken()))
        .rejects.toThrow(/matching the RegExp/u);
      await expect(second.staging.open(`upl_${randomUUID()}`, "../outside"))
        .rejects.toThrow(/matching the RegExp/u);
    });

    test("an interrupted staging write settles before cleanup removes it", async () => {
      const storage = contract.create("installation-interrupted-staging");
      const declaredBytes = patternedBytes(16 * 1024 * 1024);
      const uploadId = `upl_${randomUUID()}`;
      const storageToken = stagedFileToken();
      const controller = new AbortController();
      const incoming = new TransformStream<Uint8Array, Uint8Array>();
      const writer = incoming.writable.getWriter();
      const write = storage.staging.put({
        body: incoming.readable,
        sha256: digest(declaredBytes),
        signal: controller.signal,
        size: declaredBytes.byteLength,
        storageToken,
        uploadId,
      });
      await writer.write(declaredBytes.subarray(0, 9 * 1024 * 1024));
      controller.abort(new Error("provider cancellation contract"));
      await writer.abort(controller.signal.reason).catch(() => undefined);
      await expect(write).rejects.toBeDefined();

      await expect(storage.staging.remove(uploadId, storageToken))
        .resolves.toBeUndefined();
      await expect(storage.staging.open(uploadId, storageToken))
        .rejects.toBeDefined();
    });

    test("missing, wrong-kind, and wrong-digest metadata fail closed", async () => {
      const installationId = "installation-metadata-corruption";
      const storage = contract.create(installationId);
      const bytes = new TextEncoder().encode("metadata-protected native bytes");
      const fingerprint = digest(bytes);

      await contract.corrupt({
        bytes,
        installationId,
        kind: "staging",
        objectDigest: fingerprint,
        recordedDigest: fingerprint,
      });
      await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
        /wrong object kind/u,
      );
      await contract.corrupt({
        bytes,
        installationId,
        kind: "blob",
        objectDigest: fingerprint,
        recordedDigest: null,
      });
      await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
        /no fingerprint/u,
      );
      await contract.corrupt({
        bytes,
        installationId,
        kind: "blob",
        objectDigest: fingerprint,
        recordedDigest: digest(new TextEncoder().encode("another object")),
      });
      await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
        /wrong fingerprint/u,
      );
    });
  });
}

/** Return the deterministic immutable object name used by native adapters. */
export function nativeBlobKey(
  installationId: string,
  fingerprint: string,
): string {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return `installations/${namespace}/blobs/${fingerprint.slice(0, 2)}/${fingerprint}`;
}

function readBlob(store: BlobStore, fingerprint: string): Promise<Uint8Array> {
  return store.open(fingerprint).then(async (opened) =>
    new Uint8Array(await new Response(opened.body).arrayBuffer()));
}

function readStaged(
  store: StagingStore,
  uploadId: string,
  storageToken: string,
): Promise<Uint8Array> {
  return store.open(uploadId, storageToken).then(async (opened) =>
    new Uint8Array(await new Response(opened.body).arrayBuffer()));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stagedFileToken(): string {
  return randomBytes(18).toString("hex");
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function chunkedBody(
  bytes: Uint8Array,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  });
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
