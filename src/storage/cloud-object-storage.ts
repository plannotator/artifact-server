import {createHash} from "node:crypto";
import type {Readable} from "node:stream";

import {Predicate, Schema} from "effect";

import type {StoredBlob} from "../core/ports.js";

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

/** Metadata key storing the verified SHA-256 fingerprint. */
export const digestMetadataName = "artifact-sha256";

/** Metadata key distinguishing immutable blobs from staged upload bytes. */
export const kindMetadataName = "artifact-kind";

/** Stored object purpose used by every native cloud adapter. */
export type StoredObjectKind = "blob" | "staging";

/** Validated provider metadata required to trust a stored object. */
export interface CloudObjectMetadata {
  readonly expectedDigest: string | null;
  readonly kind: StoredObjectKind;
  readonly metadata: Readonly<Record<string, string>> | undefined;
  readonly provider: string;
  readonly size: number;
}

/** Installation-scoped object names shared by native cloud adapters. */
export interface InstallationObjectKeyspace {
  /** Return the immutable content-addressed name for a verified digest. */
  blob(digest: string): string;
  /** Return the opaque staged-upload name for trusted upload identifiers. */
  staging(uploadId: string, storageToken: string): string;
}

/** Failure raised when provider metadata cannot prove stored-byte integrity. */
export class CloudObjectIntegrityError extends Error {
  constructor(provider: string, kind: StoredObjectKind, reason: string) {
    super(`${provider} stored ${kind} failed integrity inspection: ${reason}.`);
    this.name = "CloudObjectIntegrityError";
  }
}

/** Build the deterministic key namespace for one trusted installation. */
export function createInstallationObjectKeyspace(
  installationId: string,
): InstallationObjectKeyspace {
  const namespace = createHash("sha256").update(installationId).digest("hex");
  return {
    blob: (digest) => {
      const trustedDigest = parseDigest(digest);
      return `installations/${namespace}/blobs/${trustedDigest.slice(0, 2)}/${trustedDigest}`;
    },
    staging: (uploadId, storageToken) => {
      const trustedUploadId = parseUploadId(uploadId);
      const trustedStorageToken = parseStorageToken(storageToken);
      const tokenDigest = createHash("sha256")
        .update(trustedStorageToken)
        .digest("hex");
      return `installations/${namespace}/staging/${trustedUploadId}/${tokenDigest}`;
    },
  };
}

/** Parse and compare provider metadata before bytes enter application code. */
export function inspectCloudObjectMetadata(
  input: CloudObjectMetadata,
): StoredBlob {
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new CloudObjectIntegrityError(
      input.provider,
      input.kind,
      "provider returned no valid size",
    );
  }
  if (input.metadata?.[kindMetadataName] !== input.kind) {
    throw new CloudObjectIntegrityError(
      input.provider,
      input.kind,
      "provider metadata has the wrong object kind",
    );
  }
  const recordedDigest = input.metadata?.[digestMetadataName];
  if (recordedDigest === undefined) {
    throw new CloudObjectIntegrityError(
      input.provider,
      input.kind,
      "provider metadata has no fingerprint",
    );
  }
  const trustedRecordedDigest = parseDigest(recordedDigest);
  if (
    input.expectedDigest !== null &&
    trustedRecordedDigest !== input.expectedDigest
  ) {
    throw new CloudObjectIntegrityError(
      input.provider,
      input.kind,
      "provider metadata has the wrong fingerprint",
    );
  }
  return {sha256: trustedRecordedDigest, size: input.size};
}

/** Reject a provider response that omits the byte stream it claimed to open. */
export function requireCloudObjectBody<T>(
  body: T | undefined,
  provider: string,
  kind: StoredObjectKind,
  reason: string,
): T {
  if (body === undefined) {
    throw new CloudObjectIntegrityError(provider, kind, reason);
  }
  return body;
}

/** Verify that provider metadata agrees with the completed upload contract. */
export function verifyCloudObjectWriteSize(
  stored: StoredBlob,
  expectedSize: number,
  provider: string,
  kind: StoredObjectKind,
): StoredBlob {
  if (stored.size !== expectedSize) {
    throw new CloudObjectIntegrityError(
      provider,
      kind,
      `provider recorded ${stored.size} bytes after a ${expectedSize} byte upload`,
    );
  }
  return stored;
}

/** Convert a provider Node stream into a byte-only Web stream. */
export function nodeByteStream(readable: Readable): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<unknown> = readable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      readable.destroy(reason instanceof Error ? reason : undefined);
      await iterator.return?.();
    },
    pull: async (controller) => {
      try {
        const result = await iterator.next();
        if (result.done === true) {
          controller.close();
          return;
        }
        if (Predicate.isUint8Array(result.value)) {
          controller.enqueue(result.value);
          return;
        }
        readable.destroy();
        controller.error(new TypeError(
          "Cloud storage returned a non-byte stream chunk.",
        ));
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
