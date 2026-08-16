import {Buffer} from "node:buffer";
import {randomUUID} from "node:crypto";
import {Readable, Writable} from "node:stream";
import {pipeline} from "node:stream/promises";

import {DefaultAzureCredential} from "@azure/identity";
import {
  BlobServiceClient,
  type BlobLeaseClient,
  type BlobGetPropertiesResponse,
  type ContainerClient,
} from "@azure/storage-blob";
import {Option, Schema} from "effect";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import {
  CloudObjectIntegrityError,
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  nodeByteStream,
  requireCloudObjectBody,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "./cloud-object-storage.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "./object-storage-provider.js";
import {verifiedBlobStream} from "./verified-file.js";

const azureDigestMetadataName = "artifactsha256";
const azureKindMetadataName = "artifactkind";
const uploadBlockBytes = 8 * 1024 * 1024;
const uploadConcurrency = 2;
const leaseDurationSeconds = 60;
const leaseRetryMilliseconds = 50;
const leaseWaitMilliseconds = 65_000;
const azureFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
});
const parseAzureFailure = Schema.decodeUnknownOption(azureFailureSchema);

/** Azure Blob settings using the default Azure credential chain. */
export interface AzureBlobObjectStorageProviderConfig {
  /** HTTPS Blob service endpoint for the deployment's storage account. */
  readonly accountUrl: string;
  /** Existing private container authorized for the runtime identity. */
  readonly container: string;
}

/** Construction values for one installation's Azure Blob adapters. */
export interface AzureBlobObjectStorageConfig {
  /** Container client owned by the deployment composition root. */
  readonly container: ContainerClient;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
}

/** Immutable and staging adapters backed by one installation-scoped container. */
export interface AzureBlobObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/** Build the deployment-facing Azure Blob provider factory. */
export function createAzureBlobObjectStorageProviderFactory(
  config: AzureBlobObjectStorageProviderConfig,
): ObjectStorageProviderFactory {
  return {
    kind: "azure-blob",
    create: (installationId) => createAzureBlobObjectStorageProvider(
      config,
      installationId,
    ),
  };
}

/** Construct Azure Blob adapters around an already configured container client. */
export function createAzureBlobObjectStorageAdapters(
  config: AzureBlobObjectStorageConfig,
): AzureBlobObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(config.installationId);
  const objects = new AzureBlobObjects(config.container);
  return {
    blobs: {
      inspect: (digest) => objects.inspect(keyspace.blob(digest), digest, "blob"),
      open: (digest) => objects.open(keyspace.blob(digest), digest, "blob"),
      openRange: (digest, range) => objects.openRange(
        keyspace.blob(digest),
        digest,
        "blob",
        range,
      ),
      put: (write) => objects.put(
        keyspace.blob(write.sha256),
        write,
        write.sha256,
        "blob",
      ),
    },
    staging: {
      remove: (uploadId, storageToken) => objects.remove(
        keyspace.staging(uploadId, storageToken),
      ),
      open: async (uploadId, storageToken) => {
        const opened = await objects.open(
          keyspace.staging(uploadId, storageToken),
          null,
          "staging",
        );
        return {body: opened.body, size: opened.size};
      },
      put: (write) => objects.put(
        keyspace.staging(write.uploadId, write.storageToken),
        write,
        write.sha256,
        "staging",
      ),
    },
  };
}

function createAzureBlobObjectStorageProvider(
  config: AzureBlobObjectStorageProviderConfig,
  installationId: string,
): ObjectStorageProvider {
  const service = new BlobServiceClient(
    config.accountUrl,
    new DefaultAzureCredential(),
  );
  const container = service.getContainerClient(config.container);
  const adapters = createAzureBlobObjectStorageAdapters({
    container,
    installationId,
  });
  return {
    ...adapters,
    kind: "azure-blob",
    close: () => Promise.resolve(),
    readiness: async (signal) => {
      await container.getProperties({abortSignal: signal});
    },
  };
}

class AzureBlobObjects {
  readonly #container: ContainerClient;

  constructor(container: ContainerClient) {
    this.#container = container;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const properties = await this.#container.getBlobClient(key).getProperties();
    return inspectAzureMetadata(properties, expectedDigest, kind);
  }

  async remove(key: string): Promise<void> {
    await this.#container.getBlobClient(key).deleteIfExists();
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const client = this.#container.getBlobClient(key);
    const response = await client.download();
    const stored = inspectAzureMetadata(response, expectedDigest, kind);
    const readable = requireCloudObjectBody(
      response.readableStreamBody instanceof Readable
        ? response.readableStreamBody
        : undefined,
      "Azure Blob",
      kind,
      "provider returned no Node.js byte stream",
    );
    return {
      body: nodeByteStream(readable),
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async openRange(
    key: string,
    expectedDigest: string,
    kind: StoredObjectKind,
    range: BlobByteRange,
  ): Promise<OpenedBlobRange> {
    const client = this.#container.getBlobClient(key);
    const properties = await client.getProperties();
    const stored = inspectAzureMetadata(properties, expectedDigest, kind);
    if (
      range.start < 0 ||
      range.endInclusive < range.start ||
      range.endInclusive >= stored.size
    ) {
      throw new RangeError("Azure Blob range is outside the stored object.");
    }
    const response = await client.download(
      range.start,
      range.endInclusive - range.start + 1,
    );
    const readable = requireCloudObjectBody(
      response.readableStreamBody instanceof Readable
        ? response.readableStreamBody
        : undefined,
      "Azure Blob",
      kind,
      "provider returned no ranged Node.js byte stream",
    );
    return {
      body: nodeByteStream(readable),
      range,
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  async put(
    key: string,
    write: BlobWrite,
    expectedDigest: string,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const client = this.#container.getBlockBlobClient(key);
    await ensureLeaseTarget(client, kind, write.signal);
    const lease = await acquireWriteLease(
      client,
      Date.now() + leaseWaitMilliseconds,
      write.signal,
    );
    try {
      const existing = await inspectExistingAzureObject(
        client,
        expectedDigest,
        kind,
        write.signal,
      );
      if (existing !== null) {
        await drainVerifiedWrite(write, expectedDigest);
        return existing;
      }
      const blockIds = await stageVerifiedBlocks(
        client,
        write,
        expectedDigest,
        lease.leaseId,
        () => lease.renewLease(abortOptions(write.signal)).then(() => undefined),
        write.signal,
      );
      await client.commitBlockList(blockIds, {
        ...abortOptions(write.signal),
        blobHTTPHeaders: {blobContentType: "application/octet-stream"},
        conditions: {leaseId: lease.leaseId},
        metadata: {
          [azureDigestMetadataName]: expectedDigest,
          [azureKindMetadataName]: kind,
        },
      });
    } finally {
      await lease.releaseLease();
    }
    return verifyCloudObjectWriteSize(
      await this.inspect(key, expectedDigest, kind),
      write.size,
      "Azure Blob",
      kind,
    );
  }
}

async function stageVerifiedBlocks(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  write: BlobWrite,
  expectedDigest: string,
  leaseId: string,
  renewLease: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<Array<string>> {
  const uploadId = randomUUID();
  const blockIds: Array<string> = [];
  let pending: Array<Promise<unknown>> = [];
  let streamingFailed = false;
  let streamingFailure: unknown;
  try {
    for await (const block of fixedSizeBlocks(
      verifiedBlobStream(write, expectedDigest),
    )) {
      const index = String(blockIds.length).padStart(10, "0");
      const blockId = Buffer.from(`${uploadId}:${index}`).toString("base64");
      blockIds.push(blockId);
      pending.push(client.stageBlock(blockId, block, block.byteLength, {
        ...abortOptions(signal),
        conditions: {leaseId},
      }));
      if (pending.length === uploadConcurrency) {
        // A batch bounds memory while preserving provider upload concurrency.
        // eslint-disable-next-line no-await-in-loop
        await settleStagedBlockBatch(pending);
        // The fixed lease remains valid while a large stream is staged.
        // eslint-disable-next-line no-await-in-loop
        await renewLease();
        pending = [];
      }
    }
  } catch (error) {
    streamingFailed = true;
    streamingFailure = error;
  }
  let pendingFailed = false;
  let pendingFailure: unknown;
  try {
    await settleStagedBlockBatch(pending);
  } catch (error) {
    pendingFailed = true;
    pendingFailure = error;
  }
  if (streamingFailed) throw streamingFailure;
  if (pendingFailed) throw pendingFailure;
  return blockIds;
}

async function settleStagedBlockBatch(
  pending: ReadonlyArray<Promise<unknown>>,
): Promise<void> {
  const results = await Promise.allSettled(pending);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

async function ensureLeaseTarget(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  kind: StoredObjectKind,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await client.uploadData(new Uint8Array(), {
      ...abortOptions(signal),
      conditions: {ifNoneMatch: "*"},
      metadata: {[azureKindMetadataName]: kind},
    });
  } catch (error) {
    const failure = parseAzureFailure(error);
    if (
      Option.isNone(failure) ||
      (failure.value.statusCode !== 409 && failure.value.statusCode !== 412)
    ) {
      throw error;
    }
  }
}

async function acquireWriteLease(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<BlobLeaseClient> {
  const lease = client.getBlobLeaseClient(randomUUID());
  try {
    await lease.acquireLease(leaseDurationSeconds, abortOptions(signal));
    return lease;
  } catch (error) {
    const failure = parseAzureFailure(error);
    if (
      Option.isNone(failure) || failure.value.statusCode !== 409 ||
      Date.now() >= deadline
    ) {
      throw error;
    }
    await abortableDelay(leaseRetryMilliseconds, signal);
    return acquireWriteLease(client, deadline, signal);
  }
}

async function inspectExistingAzureObject(
  client: ReturnType<ContainerClient["getBlockBlobClient"]>,
  expectedDigest: string,
  kind: StoredObjectKind,
  signal: AbortSignal | undefined,
): Promise<StoredBlob | null> {
  const properties = await client.getProperties(abortOptions(signal));
  try {
    return inspectAzureMetadata(properties, expectedDigest, kind);
  } catch (error) {
    if (error instanceof CloudObjectIntegrityError) return null;
    throw error;
  }
}

async function drainVerifiedWrite(
  write: BlobWrite,
  expectedDigest: string,
): Promise<void> {
  await pipeline(
    Readable.from(verifiedBlobStream(write, expectedDigest), {objectMode: false}),
    new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    }),
    write.signal === undefined ? {} : {signal: write.signal},
  );
}

function abortOptions(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : {abortSignal: signal};
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, {once: true});
  });
}

async function* fixedSizeBlocks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let block = new Uint8Array(uploadBlockBytes);
  let blockOffset = 0;
  for await (const chunk of body) {
    let chunkOffset = 0;
    while (chunkOffset < chunk.byteLength) {
      const copied = Math.min(
        block.byteLength - blockOffset,
        chunk.byteLength - chunkOffset,
      );
      block.set(chunk.subarray(chunkOffset, chunkOffset + copied), blockOffset);
      blockOffset += copied;
      chunkOffset += copied;
      if (blockOffset === block.byteLength) {
        yield block;
        block = new Uint8Array(uploadBlockBytes);
        blockOffset = 0;
      }
    }
  }
  if (blockOffset > 0) yield block.subarray(0, blockOffset);
}

function inspectAzureMetadata(
  properties: BlobGetPropertiesResponse,
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  const metadata: Record<string, string> = {};
  const digest = properties.metadata?.[azureDigestMetadataName];
  const storedKind = properties.metadata?.[azureKindMetadataName];
  if (digest !== undefined) metadata[digestMetadataName] = digest;
  if (storedKind !== undefined) metadata[kindMetadataName] = storedKind;
  return inspectCloudObjectMetadata({
    expectedDigest,
    kind,
    metadata,
    provider: "Azure Blob",
    size: properties.contentLength ?? Number.NaN,
  });
}
