import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Schema } from "effect";

import type {
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedStagedFile,
  StagedFileWrite,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import { verifiedBlobStream } from "./verified-file.js";

const digestSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u),
);
const storageTokenSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{36}$/u),
);
const uploadIdSchema = Schema.String.check(
  Schema.isPattern(/^upl_[0-9a-f-]{36}$/u),
);
const parseDigest = Schema.decodeUnknownSync(digestSchema);
const parseStorageToken = Schema.decodeUnknownSync(storageTokenSchema);
const parseUploadId = Schema.decodeUnknownSync(uploadIdSchema);

const digestMetadataName = "artifact-sha256";
const kindMetadataName = "artifact-kind";
const multipartPartBytes = 8 * 1024 * 1024;

/** Construction values for one installation's S3-compatible storage adapters. */
export interface S3ObjectStorageConfig {
  /** Bucket created and authorized by the deployment composition root. */
  readonly bucket: string;
  /** Provider client owned and destroyed by the deployment composition root. */
  readonly client: S3Client;
  /** Trusted installation identity used to derive an isolated key prefix. */
  readonly installationId: string;
}

/** Immutable and staging adapters backed by one installation-scoped bucket. */
export interface S3ObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/**
 * Construct S3-compatible storage adapters without exposing provider types to
 * application services.
 */
export function createS3ObjectStorageAdapters(
  config: S3ObjectStorageConfig,
): S3ObjectStorageAdapters {
  const installationNamespace = createHash("sha256")
    .update(config.installationId)
    .digest("hex");
  const objects = new S3Objects(config.client, config.bucket);

  return {
    blobs: new S3BlobStore(objects, installationNamespace),
    staging: new S3StagingStore(objects, installationNamespace),
  };
}

class S3BlobStore implements BlobStore {
  readonly #namespace: string;
  readonly #objects: S3Objects;

  constructor(objects: S3Objects, namespace: string) {
    this.#namespace = namespace;
    this.#objects = objects;
  }

  inspect(digest: string): Promise<StoredBlob> {
    const trustedDigest = parseDigest(digest);
    return this.#objects.inspect(
      this.#key(trustedDigest),
      trustedDigest,
      "blob",
    );
  }

  open(digest: string): Promise<OpenedBlob> {
    const trustedDigest = parseDigest(digest);
    return this.#objects.open(
      this.#key(trustedDigest),
      trustedDigest,
      "blob",
    );
  }

  put(write: BlobWrite): Promise<StoredBlob> {
    const trustedDigest = parseDigest(write.sha256);
    return this.#objects.put(
      this.#key(trustedDigest),
      write,
      trustedDigest,
      "blob",
    );
  }

  #key(digest: string): string {
    return `installations/${this.#namespace}/blobs/${digest.slice(0, 2)}/${digest}`;
  }
}

class S3StagingStore implements StagingStore {
  readonly #namespace: string;
  readonly #objects: S3Objects;

  constructor(objects: S3Objects, namespace: string) {
    this.#namespace = namespace;
    this.#objects = objects;
  }

  async open(
    uploadId: string,
    storageToken: string,
  ): Promise<OpenedStagedFile> {
    const opened = await this.#objects.open(
      this.#key(uploadId, storageToken),
      null,
      "staging",
    );
    return {body: opened.body, size: opened.size};
  }

  put(write: StagedFileWrite): Promise<StoredBlob> {
    const trustedDigest = parseDigest(write.sha256);
    return this.#objects.put(
      this.#key(write.uploadId, write.storageToken),
      write,
      trustedDigest,
      "staging",
    );
  }

  #key(uploadId: string, storageToken: string): string {
    const trustedUploadId = parseUploadId(uploadId);
    const trustedStorageToken = parseStorageToken(storageToken);
    const tokenDigest = createHash("sha256")
      .update(trustedStorageToken)
      .digest("hex");
    return `installations/${this.#namespace}/staging/${trustedUploadId}/${tokenDigest}`;
  }
}

type StoredObjectKind = "blob" | "staging";

class S3Objects {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#bucket = bucket;
    this.#client = client;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const output = await this.#client.send(new HeadObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
    return inspectProviderMetadata(output, expectedDigest, kind);
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const output = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }));
    const stored = inspectProviderMetadata(output, expectedDigest, kind);
    if (output.Body === undefined) {
      throw new S3ObjectIntegrityError(kind, "provider returned no body");
    }
    return {
      body: output.Body.transformToWebStream(),
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
    const verifiedBody = verifiedBlobStream(write, expectedDigest);
    const upload = new Upload({
      client: this.#client,
      leavePartsOnError: false,
      params: {
        Body: Readable.from(verifiedBody, {objectMode: false}),
        Bucket: this.#bucket,
        ContentType: "application/octet-stream",
        Key: key,
        Metadata: {
          [digestMetadataName]: expectedDigest,
          [kindMetadataName]: kind,
        },
      },
      partSize: multipartPartBytes,
      queueSize: 2,
    });
    await upload.done();

    const stored = await this.inspect(key, expectedDigest, kind);
    if (stored.size !== write.size) {
      throw new S3ObjectIntegrityError(
        kind,
        `provider recorded ${stored.size} bytes after a ${write.size} byte upload`,
      );
    }
    return stored;
  }
}

function inspectProviderMetadata(
  output: {
    readonly ContentLength?: number | undefined;
    readonly Metadata?: Readonly<Record<string, string>> | undefined;
  },
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  if (output.ContentLength === undefined || output.ContentLength < 0) {
    throw new S3ObjectIntegrityError(kind, "provider returned no valid size");
  }
  if (output.Metadata?.[kindMetadataName] !== kind) {
    throw new S3ObjectIntegrityError(kind, "provider metadata has the wrong object kind");
  }
  const recordedDigest = output.Metadata[digestMetadataName];
  if (recordedDigest === undefined) {
    throw new S3ObjectIntegrityError(kind, "provider metadata has no fingerprint");
  }
  const trustedRecordedDigest = parseDigest(recordedDigest);
  if (expectedDigest !== null && trustedRecordedDigest !== expectedDigest) {
    throw new S3ObjectIntegrityError(kind, "provider metadata has the wrong fingerprint");
  }
  return {sha256: trustedRecordedDigest, size: output.ContentLength};
}

class S3ObjectIntegrityError extends Error {
  constructor(kind: StoredObjectKind, reason: string) {
    super(`Stored ${kind} failed integrity inspection: ${reason}.`);
    this.name = "S3ObjectIntegrityError";
  }
}
