import { randomUUID } from "node:crypto";
import {mkdir, open, rename, rm, rmdir} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  OpenedStagedFile,
  StagedFileWrite,
  StagingStore,
  StoredBlob,
} from "../core/ports.js";
import {
  readableFile,
  syncDirectory,
  writeVerifiedStream,
} from "./verified-file.js";

const uploadIdSchema = z.string().regex(/^upl_[0-9a-f-]{36}$/u);
const storageTokenSchema = z.string().regex(/^[a-f0-9]{36}$/u);

interface StagingLocation {
  readonly directory: string;
  readonly file: string;
}

/** Stores uncommitted upload bytes beneath server-issued opaque identifiers. */
export class LocalStagingStore implements StagingStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async open(uploadId: string, storageToken: string): Promise<OpenedStagedFile> {
    const location = this.#location(uploadId, storageToken);
    const handle = await open(location.file, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("A staged upload entry is not a regular file.");
      }
      return {
        body: readableFile(handle, metadata.size),
        size: metadata.size,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async put(write: StagedFileWrite): Promise<StoredBlob> {
    const location = this.#location(write.uploadId, write.storageToken);
    await mkdir(location.directory, {recursive: true, mode: 0o700});
    const temporaryFile = path.join(
      location.directory,
      `.${write.storageToken}.${randomUUID()}.tmp`,
    );
    try {
      const file = await open(temporaryFile, "wx", 0o600);
      try {
        await writeVerifiedStream(file, write, write.sha256);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryFile, location.file);
      await syncDirectory(location.directory);
    } finally {
      await rm(temporaryFile, {force: true});
    }
    return {sha256: write.sha256, size: write.size};
  }

  async remove(uploadId: string, storageToken: string): Promise<void> {
    const location = this.#location(uploadId, storageToken);
    await rm(location.file, {force: true});
    try {
      await rmdir(location.directory);
    } catch (cause) {
      const parsed = z.object({code: z.string().optional()}).safeParse(cause);
      if (
        !parsed.success ||
        !["ENOENT", "ENOTEMPTY"].includes(parsed.data.code ?? "")
      ) throw cause;
    }
  }

  #location(
    uploadId: string,
    storageToken: string,
  ): StagingLocation {
    const trustedUploadId = uploadIdSchema.parse(uploadId);
    const trustedStorageToken = storageTokenSchema.parse(storageToken);
    const directory = path.join(this.#root, trustedUploadId);
    return {
      directory,
      file: path.join(directory, trustedStorageToken),
    };
  }
}
