import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import type { BlobWrite } from "../core/ports.js";

/** Identifies a client-controlled stream that did not match its declared file metadata. */
export class FileVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileVerificationError";
  }
}

/**
 * Passes an incoming blob through while verifying its declared size and digest.
 *
 * The returned stream preserves backpressure and fails before its consumer can
 * observe a successful end-of-stream when the declaration is false.
 */
export function verifiedBlobStream(
  write: BlobWrite,
  expectedDigest: string,
): ReadableStream<Uint8Array> {
  const fingerprint = createHash("sha256");
  let size = 0;

  const verified = new TransformStream<Uint8Array, Uint8Array>({
    flush: (controller) => {
      if (size !== write.size) {
        controller.error(new FileVerificationError(
          `Incoming blob ${expectedDigest} is ${size} bytes but ${write.size} were declared.`,
        ));
        return;
      }
      if (fingerprint.digest("hex") !== expectedDigest) {
        controller.error(new FileVerificationError(
          `Incoming blob does not match fingerprint ${expectedDigest}.`,
        ));
      }
    },
    transform: (chunk, controller) => {
      size += chunk.byteLength;
      if (size > write.size) {
        controller.error(new FileVerificationError(
          `Incoming blob ${expectedDigest} exceeds its declared ${write.size} bytes.`,
        ));
        return;
      }
      fingerprint.update(chunk);
      controller.enqueue(chunk);
    },
  });
  return write.signal === undefined
    ? write.body.pipeThrough(verified)
    : write.body.pipeThrough(verified, {signal: write.signal});
}

/** Writes and verifies one incoming stream without buffering the complete file. */
export async function writeVerifiedStream(
  file: FileHandle,
  write: BlobWrite,
  expectedDigest: string,
): Promise<void> {
  const reader = verifiedBlobStream(write, expectedDigest).getReader();
  try {
    while (true) {
      // Stream reads must remain ordered so hashing and file offsets describe identical bytes.
      // eslint-disable-next-line no-await-in-loop
      const result = await reader.read();
      if (result.done) break;
      // A later chunk cannot be written until this chunk is complete.
      // eslint-disable-next-line no-await-in-loop
      await writeAll(file, result.value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Creates a backpressure-aware Web stream that owns and closes the file handle. */
export function readableFile(
  handle: FileHandle,
  size: number,
): ReadableStream<Uint8Array> {
  return readableFileRange(handle, {endInclusive: size - 1, start: 0});
}

/** Creates a byte-range Web stream that owns and closes the file handle. */
export function readableFileRange(
  handle: FileHandle,
  range: {readonly endInclusive: number; readonly start: number},
): ReadableStream<Uint8Array> {
  const chunkBytes = 65_536;
  let closed = false;
  let position = range.start;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  return new ReadableStream<Uint8Array>({
    cancel: close,
    pull: async (controller) => {
      try {
        const remaining = range.endInclusive - position + 1;
        if (remaining <= 0) {
          await close();
          controller.close();
          return;
        }
        const chunk = new Uint8Array(Math.min(chunkBytes, remaining));
        const {bytesRead} = await handle.read(
          chunk,
          0,
          chunk.byteLength,
          position,
        );
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
        if (position > range.endInclusive) {
          await close();
          controller.close();
        }
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
  });
}

/** Syncs a directory entry after an atomic installation or replacement. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    // Partial file writes must finish in order before the next offset is known.
    // eslint-disable-next-line no-await-in-loop
    const {bytesWritten} = await file.write(bytes.subarray(offset));
    if (bytesWritten === 0) {
      throw new Error("The file stopped accepting bytes before the write completed.");
    }
    offset += bytesWritten;
  }
}
