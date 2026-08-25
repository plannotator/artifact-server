import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { Option, Schema } from "effect";

import type { SourceFreshness } from "../core/model.js";
import {
  InvalidLinkPath,
  LinkPathOutsideRoots,
  LinkPathProtected,
  SourceDrifted,
  SourceMissing,
  SourceUnreadable,
} from "../core/errors.js";
import { readableFile } from "../storage/verified-file.js";

/**
 * Filesystem mechanics for linked artifacts (project/spec/local-workspace-spec.md
 * section 4). Node-only: this module reaches the server machine's filesystem
 * and must never be imported by the Cloudflare worker build.
 *
 * Error messages in this module never include the source path, so surfaced
 * or logged failures disclose no filesystem layout.
 */

const readChunkBytes = 65_536;

/** Locations of Artifact Server's own durable state, never linkable. */
export interface SelfProtectedPaths {
  /** The database file; its `-wal`/`-shm` companions are derived from it. */
  readonly databasePath: string;
  readonly dataDirectory: string;
}

/** One lazily observed relation between a binding and its source file. */
export interface SourceFreshnessObservation {
  /** The currently observed fingerprint, or null when no stat succeeded. */
  readonly fingerprint: string | null;
  readonly freshness: SourceFreshness;
}

/**
 * One opened source whose stat and bytes are bound to the same descriptor.
 * Exactly one of `stream` or `close` must be used: `stream` transfers handle
 * ownership to the returned stream, which closes it.
 */
export interface VerifiedSource {
  close(): Promise<void>;
  readonly fingerprint: string;
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** One drift-checked read of a source file, spooled for the publish pipeline. */
export interface CapturedSource {
  discard(): Promise<void>;
  /** The fingerprint verified identical before and after the full read. */
  readonly fingerprint: string;
  openStream(): Promise<ReadableStream<Uint8Array>>;
  readonly sha256: string;
  readonly size: number;
  readonly spoolPath: string;
}

/** Observation points that let suites exercise mid-read source drift. */
export interface CaptureHooks {
  readonly afterFirstRead?: () => Promise<void> | void;
}

/** Compute the binding fingerprint `device:inode:size:mtimeNs:ctimeNs`. */
export function computeFingerprint(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/**
 * Resolve one presented link path to its canonical form. The presented path
 * must be absolute and the canonical target must be a regular file.
 */
export async function canonicalizeLinkPath(rawPath: string): Promise<string> {
  if (!path.isAbsolute(rawPath)) {
    throw new InvalidLinkPath({
      message: "A link path must be an absolute path.",
    });
  }
  let canonical: string;
  try {
    canonical = await realpath(rawPath);
  } catch {
    throw new InvalidLinkPath({
      message: "The link path does not resolve to an existing file.",
    });
  }
  const stats = await lstat(canonical, {bigint: true});
  if (!stats.isFile()) {
    throw new InvalidLinkPath({
      message: "The link path must resolve to a regular file.",
    });
  }
  return canonical;
}

/**
 * Resolve configured link roots to canonical existing directories. A root
 * that does not name an existing directory is an administrator
 * misconfiguration and fails loudly rather than silently widening or
 * narrowing the boundary.
 */
export async function canonicalizeLinkRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  return Promise.all(roots.map(async (root) => {
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      throw new Error(
        "A configured link root does not name an existing directory.",
      );
    }
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new Error(
        "A configured link root does not name an existing directory.",
      );
    }
    return canonical;
  }));
}

/** Require one canonical path to sit inside a configured canonical root. */
export function checkLinkRoots(
  canonicalPath: string,
  canonicalRoots: readonly string[],
): void {
  const contained = canonicalRoots.some((root) => isWithin(root, canonicalPath));
  if (!contained) {
    throw new LinkPathOutsideRoots({
      message: "The link path resolves outside every configured link root.",
    });
  }
}

/**
 * Reject any canonical path that selects Artifact Server's own durable state:
 * the data directory and everything below it, and the database file with its
 * `-wal`/`-shm` companions wherever they live — regardless of link roots.
 */
export async function checkSelfProtection(
  canonicalPath: string,
  protectedPaths: SelfProtectedPaths,
): Promise<void> {
  const dataDirectory = await canonicalOrResolved(protectedPaths.dataDirectory);
  const databasePath = await canonicalOrResolved(protectedPaths.databasePath);
  const protectedFiles = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];
  const selectsProtectedState = canonicalPath === dataDirectory
    || isWithin(dataDirectory, canonicalPath)
    || protectedFiles.includes(canonicalPath);
  if (selectsProtectedState) {
    throw new LinkPathProtected({
      message: "The link path selects Artifact Server's own data.",
    });
  }
}

/**
 * Lazily observe one binding's freshness with a single `lstat`. Never reads
 * bytes, never touches versions, never throws for an absent or unreadable
 * source — those are ordinary freshness states.
 */
export async function refreshFreshness(
  canonicalPath: string,
  storedFingerprint: string,
): Promise<SourceFreshnessObservation> {
  let stats: BigIntStats;
  try {
    stats = await lstat(canonicalPath, {bigint: true});
  } catch (error) {
    const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
    const code = Option.isSome(parsed) ? parsed.value.code : undefined;
    return {
      fingerprint: null,
      freshness: isMissingCode(code) ? "missing" : "unreadable",
    };
  }
  if (!stats.isFile()) {
    // The bound regular file was replaced by something the live path must
    // never follow (a symlink, directory, or device).
    return {fingerprint: null, freshness: "unreadable"};
  }
  const fingerprint = computeFingerprint(stats);
  return {
    fingerprint,
    freshness: fingerprint === storedFingerprint ? "in-sync" : "modified",
  };
}

/**
 * Open one source so that the reported stat and the streamed bytes come from
 * the same descriptor: `O_NOFOLLOW` refuses a symlink at the final path, and
 * the fingerprint is computed on the opened descriptor, so a path swap after
 * the open can never redirect the stream. When an expected fingerprint is
 * given, a mismatch on the descriptor aborts with the retryable drift error.
 */
export async function openVerifiedSource(
  canonicalPath: string,
  expectedFingerprint?: string,
): Promise<VerifiedSource> {
  const handle = await openNoFollow(canonicalPath);
  try {
    const stats = await handle.stat({bigint: true});
    if (!stats.isFile()) {
      throw new SourceUnreadable({
        message: "The linked source is no longer a regular file.",
      });
    }
    const fingerprint = computeFingerprint(stats);
    if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
      throw new SourceDrifted({
        message: "The linked source changed before it could be read.",
      });
    }
    const size = Number(stats.size);
    return {
      close: () => handle.close(),
      fingerprint,
      size,
      stream: () => readableFile(handle, size),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Read one source completely from a single verified descriptor, hashing what
 * is streamed and spooling it for the publish pipeline, then re-verify the
 * fingerprint on that descriptor: any change during the read aborts with the
 * retryable drift error and removes the spool.
 */
export async function captureSource(
  canonicalPath: string,
  spoolDirectory: string,
  hooks?: CaptureHooks,
): Promise<CapturedSource> {
  const handle = await openNoFollow(canonicalPath);
  let spool: FileHandle | null = null;
  let spoolPath: string | null = null;
  try {
    const preStats = await handle.stat({bigint: true});
    if (!preStats.isFile()) {
      throw new SourceUnreadable({
        message: "The linked source is no longer a regular file.",
      });
    }
    const fingerprint = computeFingerprint(preStats);
    await mkdir(spoolDirectory, {mode: 0o700, recursive: true});
    spoolPath = path.join(
      spoolDirectory,
      `capture-${randomBytes(16).toString("hex")}`,
    );
    spool = await open(spoolPath, "wx", 0o600);

    const digest = createHash("sha256");
    let size = 0;
    let firstRead = true;
    while (true) {
      const chunk = new Uint8Array(readChunkBytes);
      // Reads must stay ordered so the hash and the spool describe identical bytes.
      // eslint-disable-next-line no-await-in-loop
      const {bytesRead} = await handle.read(chunk, 0, chunk.byteLength, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      digest.update(chunk.subarray(0, bytesRead));
      // The spool offset for the next chunk depends on this write completing.
      // eslint-disable-next-line no-await-in-loop
      await writeAll(spool, chunk.subarray(0, bytesRead));
      if (firstRead) {
        firstRead = false;
        // eslint-disable-next-line no-await-in-loop
        await hooks?.afterFirstRead?.();
      }
    }

    const postStats = await handle.stat({bigint: true});
    if (computeFingerprint(postStats) !== fingerprint) {
      throw new SourceDrifted({
        message: "The linked source changed while its bytes were being read.",
      });
    }
    await spool.sync();
    const settledSpoolPath = spoolPath;
    return {
      discard: () => rm(settledSpoolPath, {force: true}),
      fingerprint,
      openStream: async () => {
        const reader = await open(settledSpoolPath, "r");
        return readableFile(reader, size);
      },
      sha256: digest.digest("hex"),
      size,
      spoolPath: settledSpoolPath,
    };
  } catch (error) {
    if (spoolPath !== null) await rm(spoolPath, {force: true});
    throw error;
  } finally {
    await handle.close();
    if (spool !== null) await spool.close();
  }
}

async function canonicalOrResolved(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

async function openNoFollow(canonicalPath: string): Promise<FileHandle> {
  try {
    return await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
    const code = Option.isSome(parsed) ? parsed.value.code : undefined;
    if (isMissingCode(code)) {
      throw new SourceMissing({
        message: "The linked source file no longer exists.",
      });
    }
    throw new SourceUnreadable({
      message: "The linked source file cannot be opened.",
    });
  }
}

const systemErrorSchema = Schema.Struct({code: Schema.optional(Schema.String)});

function isMissingCode(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    // Partial writes must finish in order before the next offset is known.
    // eslint-disable-next-line no-await-in-loop
    const {bytesWritten} = await file.write(bytes.subarray(offset));
    if (bytesWritten === 0) {
      throw new Error("The spool stopped accepting bytes before the write completed.");
    }
    offset += bytesWritten;
  }
}
