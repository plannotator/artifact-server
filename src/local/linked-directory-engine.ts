import type {BigIntStats, Dir, FSWatcher} from "node:fs";
import {constants, watch} from "node:fs";
import {access, lstat, open, opendir, realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";

import {Option, Schema} from "effect";

import {InvalidLinkPath, SourceMissing, SourceUnreadable} from "../core/errors.js";
import {
  artifactIgnoreFileName, type IgnoreMatcher, isHostileName, type ScanObservation, type ScanPage,
} from "../core/folder-links.js";
import {computeFingerprint, type SelfProtectedPaths} from "./linked-source-engine.js";

/**
 * Filesystem mechanics for linked folders (file-management-spec.md section
 * 9.2). Node-only. The walk reads with `opendir` and `lstat`, never follows a
 * symlink, never crosses a device, never reads file bytes, and never writes
 * under the linked directory. Error messages never include a path.
 */

/** One canonical linked directory and the device it lives on. */
export interface CanonicalDirectory {
  readonly device: string;
  readonly path: string;
}

/** Bounds and rules one reconciliation walk applies. */
export interface DirectoryScanOptions {
  readonly device: string;
  readonly ignored: IgnoreMatcher;
  readonly maximumDepth: number;
  readonly maximumFileBytes: number;
}

/** One paged reconciliation walk holding its directory handles open. */
export interface DirectoryScan {
  close(): Promise<void>;
  nextPage(budget: number): Promise<ScanPage>;
}

/** Observation points for deterministic suites; production passes none. */
export interface DirectoryScanHooks {
  readonly beforeScanPage?: (linkPath: string) => Promise<void>;
}

const systemErrorSchema = Schema.Struct({code: Schema.optional(Schema.String)});


/**
 * Resolve one presented directory to its canonical form. The final component
 * must itself be a directory (not a symlink to one); parent components may be
 * symlinks, which `realpath` resolves before the root checks.
 */
export async function canonicalizeLinkDirectory(rawPath: string): Promise<CanonicalDirectory> {
  if (!path.isAbsolute(rawPath)) {
    throw new InvalidLinkPath({message: "A link path must be an absolute path."});
  }
  let presented: BigIntStats;
  let canonical: string;
  try {
    presented = await lstat(rawPath, {bigint: true});
    canonical = await realpath(rawPath);
  } catch {
    throw new InvalidLinkPath({message: "The link path does not resolve to an existing directory."});
  }
  if (!presented.isDirectory()) {
    throw new InvalidLinkPath({message: "The link path must name a directory, not a file or a symlink."});
  }
  const stats = await lstat(canonical, {bigint: true});
  if (!stats.isDirectory()) {
    throw new InvalidLinkPath({message: "The link path must name a directory, not a file or a symlink."});
  }
  return {device: String(stats.dev), path: canonical};
}

/** Re-verify a stored link: same canonical directory on the same device. */
export async function verifyLinkDirectory(linkPath: string, device: string): Promise<boolean> {
  try {
    const canonical = await realpath(linkPath);
    const stats = await lstat(canonical, {bigint: true});
    return canonical === linkPath && stats.isDirectory() && String(stats.dev) === device;
  } catch {
    return false;
  }
}

/** Resolve one inventory entry's joined path, or report it missing. */
export async function canonicalizeEntryPath(joinedPath: string): Promise<string> {
  try {
    return await realpath(joinedPath);
  } catch (error) {
    const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
    const code = Option.isSome(parsed) ? parsed.value.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SourceMissing({message: "The linked source file no longer exists."});
    }
    throw new SourceUnreadable({message: "The linked source file cannot be resolved."});
  }
}

/** Read the bounded `.artifactignore` at the link root without following a symlink. */
export async function readIgnoreFile(
  linkPath: string,
  maximumBytes: number,
): Promise<{readonly content: string | null; readonly byteLength: number}> {
  let handle;
  try {
    handle = await open(path.join(linkPath, artifactIgnoreFileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return {byteLength: 0, content: null};
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return {byteLength: 0, content: null};
    if (stats.size > maximumBytes) return {byteLength: stats.size, content: ""};
    const buffer = Buffer.alloc(stats.size);
    const {bytesRead} = await handle.read(buffer, 0, stats.size, 0);
    return {byteLength: bytesRead, content: buffer.subarray(0, bytesRead).toString("utf8")};
  } finally {
    await handle.close();
  }
}

/** Hash one regular file through a no-follow descriptor. */
export async function hashLinkedFile(canonicalPath: string): Promise<{readonly sha256: string; readonly size: number}> {
  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new SourceUnreadable({message: "The linked source file cannot be opened."});
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new SourceUnreadable({message: "The linked source is not a regular file."});
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({autoClose: false})) {
      digest.update(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk)));
    }
    return {sha256: digest.digest("hex"), size: stats.size};
  } finally {
    await handle.close();
  }
}

interface WalkFrame {
  readonly absolute: string;
  readonly depth: number;
  handle: Dir | null;
  readonly relative: string;
}

/** Open one bounded, paged walk below a canonical linked directory. */
export async function openDirectoryScan(
  linkPath: string,
  options: DirectoryScanOptions,
  protectedPaths: SelfProtectedPaths,
  hooks: DirectoryScanHooks = {},
): Promise<DirectoryScan> {
  const dataDirectory = await canonicalOrResolved(protectedPaths.dataDirectory);
  const databasePath = await canonicalOrResolved(protectedPaths.databasePath);
  const protectedFiles = new Set([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]);
  const stack: WalkFrame[] = [{absolute: linkPath, depth: 0, handle: null, relative: ""}];

  const nextPage = async (budget: number): Promise<ScanPage> => {
    await hooks.beforeScanPage?.(linkPath);
    const observations: ScanObservation[] = [];
    let ignoredCount = 0;
    let read = 0;
    while (read < budget) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      if (frame.handle === null) {
        try {
          // Directory frames are opened lazily, one at a time, in walk order.
          // eslint-disable-next-line no-await-in-loop
          frame.handle = await opendir(frame.absolute, {bufferSize: 64});
        } catch {
          stack.pop();
          if (frame.relative !== "") {
            observations.push({diskPath: frame.relative, kind: "skipped", reason: "unreadable", size: null});
          }
          continue;
        }
      }
      // Entries must be read in order from the same open handle.
      // eslint-disable-next-line no-await-in-loop
      const entry = await frame.handle.read();
      if (entry === null) {
        stack.pop();
        // eslint-disable-next-line no-await-in-loop
        await frame.handle.close();
        continue;
      }
      read += 1;
      const relative = frame.relative === "" ? entry.name : `${frame.relative}/${entry.name}`;
      const absolute = `${frame.absolute}/${entry.name}`;
      if (isHostileName(entry.name)) {
        observations.push({diskPath: relative, kind: "skipped", reason: "hostile-name", size: null});
        continue;
      }
      let stats: BigIntStats;
      try {
        // eslint-disable-next-line no-await-in-loop
        stats = await lstat(absolute, {bigint: true});
      } catch (error) {
        const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
        if (!Option.isSome(parsed) || parsed.value.code !== "ENOENT") {
          observations.push({diskPath: relative, kind: "skipped", reason: "unreadable", size: null});
        }
        continue;
      }
      if (stats.isSymbolicLink()) {
        observations.push({diskPath: relative, kind: "skipped", reason: "symlink", size: null});
        continue;
      }
      if (stats.isDirectory()) {
        if (entry.name === ".git" || absolute === dataDirectory || isWithin(dataDirectory, absolute)) {
          ignoredCount += 1;
          continue;
        }
        if (String(stats.dev) !== options.device) {
          observations.push({diskPath: relative, kind: "skipped", reason: "other-device", size: null});
          continue;
        }
        if (options.ignored(relative, true)) {
          ignoredCount += 1;
          continue;
        }
        const depth = frame.depth + 1;
        if (depth >= options.maximumDepth) {
          observations.push({diskPath: relative, kind: "skipped", reason: "too-deep", size: null});
          continue;
        }
        stack.push({absolute, depth, handle: null, relative});
        continue;
      }
      if (!stats.isFile()) {
        observations.push({diskPath: relative, kind: "skipped", reason: "special", size: null});
        continue;
      }
      if (protectedFiles.has(absolute) || options.ignored(relative, false)) {
        ignoredCount += 1;
        continue;
      }
      const size = Number(stats.size);
      if (size > options.maximumFileBytes) {
        observations.push({diskPath: relative, kind: "skipped", reason: "too-large", size});
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await access(absolute, constants.R_OK);
      } catch {
        observations.push({diskPath: relative, kind: "skipped", reason: "unreadable", size});
        continue;
      }
      observations.push({diskPath: relative, fingerprint: computeFingerprint(stats), kind: "file", size});
    }
    return {done: stack.length === 0, ignoredCount, observations};
  };

  const close = async () => {
    const handles = stack.splice(0).flatMap((frame) => frame.handle === null ? [] : [frame.handle]);
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  };

  return {close, nextPage};
}

/** One running watch subscription; hints are never trusted as facts. */
export interface DirectoryWatch {
  close(): void;
}

/**
 * Subscribe to recursive change hints for one linked directory (FSEvents on
 * macOS). A hint carries no path to the caller: it only marks the link dirty.
 */
export function watchLinkedDirectory(
  linkPath: string,
  onHint: () => void,
  onError: () => void,
): DirectoryWatch {
  let watcher: FSWatcher;
  try {
    watcher = watch(linkPath, {persistent: false, recursive: true}, () => onHint());
  } catch {
    queueMicrotask(onError);
    return {close: () => undefined};
  }
  watcher.on("error", () => {
    watcher.close();
    onError();
  });
  return {close: () => watcher.close()};
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
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
