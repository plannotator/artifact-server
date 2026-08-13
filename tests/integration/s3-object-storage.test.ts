import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CreateBucketCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

import type { BlobStore, StagingStore } from "../../src/core/ports.js";
import { createS3ObjectStorageAdapters } from "../../src/storage/s3-object-storage.js";

const runFile = promisify(execFile);
const bucket = "artifact-server-integration";
const region = "us-east-1";
const multipartBytes = 9 * 1024 * 1024;

interface IntegrationEnvironment {
  readonly accessKey: string;
  readonly container: string;
  readonly endpoint: string;
  readonly image: string;
  readonly secretKey: string;
  readonly volume: string;
}

describe.sequential("S3-compatible object storage", () => {
  let client: S3Client;
  let environment: IntegrationEnvironment;

  beforeAll(async () => {
    environment = readIntegrationEnvironment();
    client = createClient(environment);
    await client.send(new CreateBucketCommand({Bucket: bucket}));
  });

  afterAll(() => {
    client.destroy();
  });

  test("DEP-011-B: MinIO preserves verified immutable and staged streams", async () => {
    const storage = createStorage(client, "installation-round-trip");
    const blobBytes = patternedBytes(multipartBytes);
    const blobDigest = digest(blobBytes);

    await expect(storage.blobs.put({
      body: chunkedBody(blobBytes, 256 * 1024),
      sha256: blobDigest,
      size: blobBytes.byteLength,
    })).resolves.toEqual({sha256: blobDigest, size: blobBytes.byteLength});

    await expect(readBlob(storage.blobs, blobDigest)).resolves.toEqual(blobBytes);

    const stagedBytes = new TextEncoder().encode("staged bytes survive remotely");
    const stagedDigest = digest(stagedBytes);
    const uploadId = `upl_${randomUUID()}`;
    const storageToken = stagedFileToken();
    await storage.staging.put({
      body: chunkedBody(stagedBytes, 5),
      sha256: stagedDigest,
      size: stagedBytes.byteLength,
      storageToken,
      uploadId,
    });
    await expect(
      readStaged(storage.staging, uploadId, storageToken),
    ).resolves.toEqual(stagedBytes);
  }, 30_000);

  test("DEP-011-F: false declarations cannot replace immutable bytes", async () => {
    const storage = createStorage(client, "installation-immutability");
    const original = new TextEncoder().encode("original immutable provider bytes");
    const originalDigest = digest(original);
    await storage.blobs.put({
      body: chunkedBody(original, 7),
      sha256: originalDigest,
      size: original.byteLength,
    });

    const conflict = patternedBytes(multipartBytes);
    await expect(storage.blobs.put({
      body: chunkedBody(conflict, 3),
      sha256: originalDigest,
      size: conflict.byteLength,
    })).rejects.toThrow(/fingerprint/u);
    await expect(storage.blobs.put({
      body: chunkedBody(original, 3),
      sha256: originalDigest,
      size: original.byteLength - 1,
    })).rejects.toThrow(/declared/u);
    const multipartUploads = await client.send(
      new ListMultipartUploadsCommand({Bucket: bucket}),
    );
    expect(multipartUploads.Uploads ?? []).toEqual([]);
    await expect(readBlob(storage.blobs, originalDigest)).resolves.toEqual(original);
  }, 30_000);

  test("concurrent writes are idempotent and installation keys stay isolated", async () => {
    const first = createStorage(client, "installation-first");
    const second = createStorage(client, "installation-second");
    const bytes = patternedBytes(1024 * 1024);
    const fingerprint = digest(bytes);

    await Promise.all(Array.from({length: 6}, () => first.blobs.put({
      body: chunkedBody(bytes, 64 * 1024),
      sha256: fingerprint,
      size: bytes.byteLength,
    })));
    await expect(readBlob(first.blobs, fingerprint)).resolves.toEqual(bytes);
    await expect(second.blobs.inspect(fingerprint)).rejects.toMatchObject({
      $metadata: {httpStatusCode: 404},
    });

    await expect(
      second.staging.open("../outside", stagedFileToken()),
    ).rejects.toThrow(/matching the RegExp/u);
    await expect(
      second.staging.open(`upl_${randomUUID()}`, "../outside"),
    ).rejects.toThrow(/matching the RegExp/u);
  }, 30_000);

  test("provider metadata corruption fails closed", async () => {
    const installationId = "installation-metadata-corruption";
    const storage = createStorage(client, installationId);
    const bytes = new TextEncoder().encode("metadata-protected bytes");
    const fingerprint = digest(bytes);
    const key = blobKey(installationId, fingerprint);

    await putRawObject(client, key, bytes, {
      "artifact-kind": "staging",
      "artifact-sha256": fingerprint,
    });
    await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
      /wrong object kind/u,
    );

    await putRawObject(client, key, bytes, {"artifact-kind": "blob"});
    await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
      /no fingerprint/u,
    );

    await putRawObject(client, key, bytes, {
      "artifact-kind": "blob",
      "artifact-sha256": digest(new TextEncoder().encode("another object")),
    });
    await expect(storage.blobs.inspect(fingerprint)).rejects.toThrow(
      /wrong fingerprint/u,
    );
  });

  test("provider restart preserves bytes and unavailable storage fails closed", async () => {
    const installationId = "installation-restart";
    const beforeRestart = createStorage(client, installationId);
    const bytes = new TextEncoder().encode("provider restart persistence");
    const fingerprint = digest(bytes);
    await beforeRestart.blobs.put({
      body: chunkedBody(bytes, 4),
      sha256: fingerprint,
      size: bytes.byteLength,
    });

    client.destroy();
    await replaceProviderContainer(environment);
    await waitUntilReady(environment.endpoint);
    client = createClient(environment);

    const afterRestart = createStorage(client, installationId);
    await expect(readBlob(afterRestart.blobs, fingerprint)).resolves.toEqual(bytes);

    const unauthorizedClient = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: "incorrect-integration-secret",
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    try {
      const unauthorized = createStorage(
        unauthorizedClient,
        "installation-unauthorized",
      );
      await expect(unauthorized.blobs.inspect(fingerprint)).rejects.toMatchObject({
        $metadata: {httpStatusCode: 403},
      });
    } finally {
      unauthorizedClient.destroy();
    }
  }, 30_000);
});

function createClient(environment: IntegrationEnvironment): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: environment.accessKey,
      secretAccessKey: environment.secretKey,
    },
    endpoint: environment.endpoint,
    forcePathStyle: true,
    region,
  });
}

function createStorage(client: S3Client, installationId: string) {
  return createS3ObjectStorageAdapters({bucket, client, installationId});
}

function readIntegrationEnvironment(): IntegrationEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_S3_ACCESS_KEY"];
  const container = process.env["ARTIFACT_SERVER_MINIO_CONTAINER"];
  const endpoint = process.env["ARTIFACT_SERVER_S3_ENDPOINT"];
  const image = process.env["ARTIFACT_SERVER_MINIO_IMAGE"];
  const secretKey = process.env["ARTIFACT_SERVER_S3_SECRET_KEY"];
  const volume = process.env["ARTIFACT_SERVER_MINIO_VOLUME"];
  if (
    accessKey === undefined || container === undefined ||
    endpoint === undefined || image === undefined ||
    secretKey === undefined || volume === undefined
  ) {
    throw new Error("Run this test through pnpm test:storage-s3.");
  }
  return {accessKey, container, endpoint, image, secretKey, volume};
}

async function readBlob(store: BlobStore, fingerprint: string): Promise<Uint8Array> {
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

function blobKey(installationId: string, fingerprint: string): string {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return `installations/${namespace}/blobs/${fingerprint.slice(0, 2)}/${fingerprint}`;
}

async function putRawObject(
  client: S3Client,
  key: string,
  bytes: Uint8Array,
  metadata: Record<string, string>,
): Promise<void> {
  await client.send(new PutObjectCommand({
    Body: bytes,
    Bucket: bucket,
    Key: key,
    Metadata: metadata,
  }));
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

async function waitUntilReady(endpoint: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      // Readiness attempts must remain ordered so the provider is not flooded while booting.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`${endpoint}/minio/health/ready`);
      if (response.ok) return;
    } catch {
      // The provider is expected to refuse connections briefly while restarting.
    }
    // Each delay belongs to the preceding readiness attempt.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MinIO did not become ready after restart.");
}

async function replaceProviderContainer(
  environment: IntegrationEnvironment,
): Promise<void> {
  const port = new URL(environment.endpoint).port;
  await runFile("docker", ["rm", "--force", environment.container]);
  await runFile("docker", [
    "run",
    "--detach",
    "--name",
    environment.container,
    "--env",
    `MINIO_ROOT_USER=${environment.accessKey}`,
    "--env",
    `MINIO_ROOT_PASSWORD=${environment.secretKey}`,
    "--publish",
    `127.0.0.1:${port}:9000`,
    "--volume",
    `${environment.volume}:/data`,
    environment.image,
    "server",
    "/data",
  ]);
}
