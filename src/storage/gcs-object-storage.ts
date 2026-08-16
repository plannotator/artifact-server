import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

import {Storage, type Bucket, type FileMetadata} from "@google-cloud/storage";
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
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  nodeByteStream,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "./cloud-object-storage.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "./object-storage-provider.js";
import {verifiedBlobStream} from "./verified-file.js";

const resumableUploadThresholdBytes = 10 * 1024 * 1024;

/** GCS settings using Google Application Default Credentials. */
export interface GcsObjectStorageProviderConfig {
  /** Optional API endpoint used only by controlled integration environments. */
  readonly apiEndpoint?: string;
  /** Existing bucket authorized for the runtime service account. */
  readonly bucket: string;
  /** Google Cloud project that owns the runtime and bucket. */
  readonly projectId: string;
}

/** Construction values for one installation's GCS adapters. */
export interface GcsObjectStorageConfig {
  /** Bucket client owned by the deployment composition root. */
  readonly bucket: Bucket;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
}

/** Immutable and staging adapters backed by one installation-scoped GCS bucket. */
export interface GcsObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/** Build the deployment-facing GCS provider factory using ADC. */
export function createGcsObjectStorageProviderFactory(
  config: GcsObjectStorageProviderConfig,
): ObjectStorageProviderFactory {
  return {
    kind: "gcs",
    create: (installationId) => createGcsObjectStorageProvider(
      config,
      installationId,
    ),
  };
}

/** Construct GCS adapters around an already configured bucket client. */
export function createGcsObjectStorageAdapters(
  config: GcsObjectStorageConfig,
): GcsObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(config.installationId);
  const objects = new GcsObjects(config.bucket);
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

function createGcsObjectStorageProvider(
  config: GcsObjectStorageProviderConfig,
  installationId: string,
): ObjectStorageProvider {
  const storage = new Storage(config.apiEndpoint === undefined
    ? {projectId: config.projectId}
    : {apiEndpoint: config.apiEndpoint, projectId: config.projectId});
  const bucket = storage.bucket(config.bucket);
  const adapters = createGcsObjectStorageAdapters({bucket, installationId});
  return {
    ...adapters,
    kind: "gcs",
    close: () => Promise.resolve(),
    readiness: (signal) => abortable(bucket.getMetadata(), signal).then(() => undefined),
  };
}

class GcsObjects {
  readonly #bucket: Bucket;

  constructor(bucket: Bucket) {
    this.#bucket = bucket;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const [metadata] = await this.#bucket.file(key).getMetadata();
    return inspectGcsMetadata(metadata, expectedDigest, kind);
  }

  async remove(key: string): Promise<void> {
    await this.#bucket.file(key).delete({ignoreNotFound: true});
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const file = this.#bucket.file(key);
    const [metadata] = await file.getMetadata();
    const stored = inspectGcsMetadata(metadata, expectedDigest, kind);
    return {
      body: nodeByteStream(file.createReadStream()),
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
    const file = this.#bucket.file(key);
    const [metadata] = await file.getMetadata();
    const stored = inspectGcsMetadata(metadata, expectedDigest, kind);
    assertProviderRange("GCS", range, stored.size);
    return {
      body: nodeByteStream(file.createReadStream({
        end: range.endInclusive,
        start: range.start,
      })),
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
    const file = this.#bucket.file(key);
    await pipeline(
      Readable.from(verifiedBlobStream(write, expectedDigest), {
        objectMode: false,
      }),
      file.createWriteStream({
        metadata: {
          contentType: "application/octet-stream",
          metadata: {
            [digestMetadataName]: expectedDigest,
            [kindMetadataName]: kind,
          },
        },
        resumable: write.size >= resumableUploadThresholdBytes,
        validation: "crc32c",
      }),
      write.signal === undefined ? {} : {signal: write.signal},
    );
    return verifyCloudObjectWriteSize(
      await this.inspect(key, expectedDigest, kind),
      write.size,
      "GCS",
      kind,
    );
  }
}

function assertProviderRange(
  provider: string,
  range: BlobByteRange,
  size: number,
): void {
  if (range.start < 0 || range.endInclusive < range.start || range.endInclusive >= size) {
    throw new RangeError(`${provider} blob range is outside the stored object.`);
  }
}

function inspectGcsMetadata(
  metadata: FileMetadata,
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  return inspectCloudObjectMetadata({
    expectedDigest,
    kind,
    metadata: stringMetadata(metadata.metadata),
    provider: "GCS",
    size: Number(metadata.size),
  });
}

function stringMetadata(
  metadata: FileMetadata["metadata"],
): Readonly<Record<string, string>> | undefined {
  if (metadata === undefined) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const parsed = Schema.decodeUnknownOption(Schema.String)(value);
    if (Option.isSome(parsed)) strings[key] = parsed.value;
  }
  return strings;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
        return undefined;
      },
      (error: Error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
        return undefined;
      },
    );
  });
}
