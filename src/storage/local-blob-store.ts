import {
  link,
  mkdir,
  open,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";

import { z } from "zod";

import type {
  BlobStore,
  BlobWrite,
  OpenedBlob,
  StoredBlob,
} from "../core/ports.js";
import {
  readableFile,
  syncDirectory,
  writeVerifiedStream,
} from "./verified-file.js";

const systemErrorSchema = z.object({code: z.string().optional()});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export class LocalBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async inspect(digest: string): Promise<StoredBlob> {
    const trustedDigest = sha256Schema.parse(digest);
    const metadata = await stat(this.#pathFor(trustedDigest));
    if (!metadata.isFile()) {
      throw new Error(`Stored blob ${trustedDigest} is not a regular file.`);
    }
    return {sha256: trustedDigest, size: metadata.size};
  }

  async open(digest: string): Promise<OpenedBlob> {
    const trustedDigest = sha256Schema.parse(digest);
    const handle = await open(this.#pathFor(trustedDigest), "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error(`Stored blob ${trustedDigest} is not a regular file.`);
      }
      return {
        body: readableFile(handle, metadata.size),
        sha256: trustedDigest,
        size: metadata.size,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async put(write: BlobWrite): Promise<StoredBlob> {
    const digest = sha256Schema.parse(write.sha256);
    const directory = path.join(this.#root, digest.slice(0, 2));
    const finalPath = path.join(directory, digest);
    const temporaryPath = path.join(directory, `.${digest}.${randomUUID()}.tmp`);
    await mkdir(directory, {recursive: true, mode: 0o700});

    let installed = false;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await writeVerifiedStream(file, write, digest);
        await file.sync();
      } finally {
        await file.close();
      }

      try {
        await link(temporaryPath, finalPath);
        installed = true;
      } catch (error) {
        const parsed = systemErrorSchema.safeParse(error);
        if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
        await verifyExistingBlob(finalPath, digest, write.size);
      }
    } finally {
      await rm(temporaryPath, {force: true});
    }

    if (installed) await syncDirectory(directory);

    return {sha256: digest, size: write.size};
  }

  #pathFor(digest: string): string {
    return path.join(this.#root, digest.slice(0, 2), digest);
  }
}

async function verifyExistingBlob(
  blobPath: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<void> {
  const metadata = await stat(blobPath);
  if (metadata.size !== expectedSize) {
    throw new Error(`Stored blob ${expectedDigest} has an unexpected size.`);
  }
  const file = await open(blobPath, "r");
  const fingerprint = createHash("sha256");
  const chunk = new Uint8Array(65_536);
  let position = 0;
  try {
    while (position < metadata.size) {
      // Existing blobs are checked sequentially without loading the whole file.
      // eslint-disable-next-line no-await-in-loop
      const {bytesRead} = await file.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      fingerprint.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  if (position !== metadata.size || fingerprint.digest("hex") !== expectedDigest) {
    throw new Error(`Stored blob ${expectedDigest} failed fingerprint verification.`);
  }
}
