import {createHash, randomBytes, randomUUID} from "node:crypto";

import {S3Client} from "@aws-sdk/client-s3";
import {describe, expect, test} from "vitest";

import type {BlobStore, StagingStore} from "../../src/core/ports.js";
import {createS3ClientConfig} from
  "../../src/external-storage/create-external-storage-runtime.js";
import {createS3ObjectStorageAdapters} from
  "../../src/storage/s3-object-storage.js";

const bucket = requiredEnvironment("ARTIFACT_SERVER_AWS_S3_PROBE_BUCKET");
const region = requiredEnvironment("ARTIFACT_SERVER_AWS_S3_PROBE_REGION");
const multipartBytes = 9 * 1024 * 1024;

describe("AWS S3 adapter probe", () => {
  test("AWS S3 preserves verified streams and rejects false immutable declarations", async () => {
    const client = new S3Client(createS3ClientConfig({bucket, region}));
    const installationId = `aws-s3-probe-${randomUUID()}`;
    const storage = createS3ObjectStorageAdapters({
      bucket,
      client,
      installationId,
    });
    try {
      const bytes = patternedBytes(multipartBytes);
      const fingerprint = digest(bytes);
      await expect(storage.blobs.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength,
      })).resolves.toEqual({sha256: fingerprint, size: bytes.byteLength});
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);

      const concurrentBytes = patternedBytes(512 * 1024);
      const concurrentFingerprint = digest(concurrentBytes);
      await Promise.all(Array.from({length: 4}, () => storage.blobs.put({
        body: chunkedBody(concurrentBytes, 64 * 1024),
        sha256: concurrentFingerprint,
        size: concurrentBytes.byteLength,
      })));
      await expect(readBlob(storage.blobs, concurrentFingerprint))
        .resolves.toEqual(concurrentBytes);

      const stagedBytes = new TextEncoder().encode("AWS staged probe bytes");
      const stagedFingerprint = digest(stagedBytes);
      const storageToken = randomBytes(18).toString("hex");
      const uploadId = `upl_${randomUUID()}`;
      await storage.staging.put({
        body: chunkedBody(stagedBytes, 5),
        sha256: stagedFingerprint,
        size: stagedBytes.byteLength,
        storageToken,
        uploadId,
      });
      await expect(readStaged(storage.staging, uploadId, storageToken))
        .resolves.toEqual(stagedBytes);

      await expect(storage.blobs.put({
        body: chunkedBody(bytes, 256 * 1024),
        sha256: fingerprint,
        size: bytes.byteLength - 1,
      })).rejects.toThrow(/declared/u);
      await expect(readBlob(storage.blobs, fingerprint)).resolves.toEqual(bytes);
    } finally {
      client.destroy();
    }
  }, 60_000);
});

async function readBlob(
  store: BlobStore,
  fingerprint: string,
): Promise<Uint8Array> {
  const opened = await store.open(fingerprint);
  return new Uint8Array(await new Response(opened.body).arrayBuffer());
}

async function readStaged(
  store: StagingStore,
  uploadId: string,
  storageToken: string,
): Promise<Uint8Array> {
  const opened = await store.open(uploadId, storageToken);
  return new Uint8Array(await new Response(opened.body).arrayBuffer());
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Run this test through pnpm verify:aws-s3; ${name} is missing.`);
  }
  return value;
}
