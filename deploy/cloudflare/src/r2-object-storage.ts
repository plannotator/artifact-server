import {createHash} from "node:crypto";

import type {
  BlobByteRange,
  BlobStore,
  BlobWrite,
  OpenedBlob,
  OpenedBlobRange,
  StagingStore,
  StoredBlob,
} from "../../../src/core/ports.js";
import {
  createInstallationObjectKeyspace,
  digestMetadataName,
  inspectCloudObjectMetadata,
  kindMetadataName,
  type StoredObjectKind,
  verifyCloudObjectWriteSize,
} from "../../../src/storage/cloud-object-storage.js";

/** Immutable and staging adapters backed by one Worker R2 binding. */
export interface R2ObjectStorageAdapters {
  /** Content-addressed immutable blob operations. */
  readonly blobs: BlobStore;
  /** Uncommitted staged-upload operations. */
  readonly staging: StagingStore;
}

/** Construct installation-scoped storage adapters around one R2 bucket binding. */
export function createR2ObjectStorageAdapters(
  bucket: R2Bucket,
  installationId: string,
): R2ObjectStorageAdapters {
  const keyspace = createInstallationObjectKeyspace(installationId);
  const objects = new R2Objects(bucket);
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

class R2Objects {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async inspect(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<StoredBlob> {
    const object = await this.#bucket.head(key);
    if (object === null) throw new Error(`R2 object ${key} does not exist.`);
    return inspectR2Object(object, expectedDigest, kind);
  }

  async remove(key: string): Promise<void> {
    await this.#bucket.delete(key);
  }

  async open(
    key: string,
    expectedDigest: string | null,
    kind: StoredObjectKind,
  ): Promise<OpenedBlob> {
    const object = await this.#bucket.get(key);
    if (object === null) throw new Error(`R2 object ${key} does not exist.`);
    const stored = inspectR2Object(object, expectedDigest, kind);
    return {
      body: object.body,
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
    const object = await this.#bucket.get(key, {
      range: {
        length: range.endInclusive - range.start + 1,
        offset: range.start,
      },
    });
    if (object === null) throw new Error(`R2 object ${key} does not exist.`);
    const stored = inspectR2Object(object, expectedDigest, kind);
    if (range.start < 0 || range.endInclusive >= stored.size) {
      throw new RangeError("R2 blob range is outside the stored object.");
    }
    return {
      body: object.body,
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
    const existing = await this.#bucket.head(key);
    if (existing !== null) {
      const stored = inspectR2Object(existing, expectedDigest, kind);
      await drainVerifiedR2Write(write, expectedDigest);
      return verifyCloudObjectWriteSize(stored, write.size, "R2", kind);
    }

    const fixedLength = new FixedLengthStream(write.size);
    const verifiedStream = verifiedR2Stream(write, expectedDigest);
    const verified = write.signal === undefined
      ? verifiedStream.pipeTo(fixedLength.writable)
      : verifiedStream.pipeTo(fixedLength.writable, {signal: write.signal});
    const [stored] = await Promise.all([
      this.#bucket.put(
        key,
        fixedLength.readable,
        {
          customMetadata: {
            [digestMetadataName]: expectedDigest,
            [kindMetadataName]: kind,
          },
          onlyIf: {etagDoesNotMatch: "*"},
        },
      ),
      verified,
    ]);
    const wonRace = stored ?? await this.#bucket.head(key);
    if (wonRace === null) {
      throw new Error(`R2 did not persist object ${key}.`);
    }
    return verifyCloudObjectWriteSize(
      inspectR2Object(wonRace, expectedDigest, kind),
      write.size,
      "R2",
      kind,
    );
  }
}

async function drainVerifiedR2Write(
  write: BlobWrite,
  expectedDigest: string,
): Promise<void> {
  const stream = verifiedR2Stream(write, expectedDigest);
  const sink = new WritableStream<Uint8Array>();
  if (write.signal === undefined) await stream.pipeTo(sink);
  else await stream.pipeTo(sink, {signal: write.signal});
}

function inspectR2Object(
  object: R2Object,
  expectedDigest: string | null,
  kind: StoredObjectKind,
): StoredBlob {
  return inspectCloudObjectMetadata({
    expectedDigest,
    kind,
    metadata: object.customMetadata,
    provider: "R2",
    size: object.size,
  });
}

function verifiedR2Stream(
  write: BlobWrite,
  expectedDigest: string,
): ReadableStream<Uint8Array> {
  const fingerprint = createHash("sha256");
  let size = 0;
  return write.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush: (controller) => {
      if (size !== write.size) {
        controller.error(new Error(
          `Incoming R2 object ${expectedDigest} is ${size} bytes but ${write.size} were declared.`,
        ));
        return;
      }
      if (fingerprint.digest("hex") !== expectedDigest) {
        controller.error(new Error(
          `Incoming R2 object does not match fingerprint ${expectedDigest}.`,
        ));
      }
    },
    transform: (chunk, controller) => {
      size += chunk.byteLength;
      if (size > write.size) {
        controller.error(new Error(
          `Incoming R2 object ${expectedDigest} exceeds its declared ${write.size} bytes.`,
        ));
        return;
      }
      fingerprint.update(chunk);
      controller.enqueue(chunk);
    },
  }));
}
