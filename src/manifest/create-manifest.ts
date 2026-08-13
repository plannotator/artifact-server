import { createHash } from "node:crypto";
import path from "node:path";

import {caseFold} from "unicode-case-folding";

import {
  EmptyManifest,
  InvalidManifestFile,
  InvalidManifestPath,
  MissingManifestEntry,
} from "../core/errors.js";
import {
  fileDispositions,
  routingModes,
  type CanonicalManifest,
  type FileDisposition,
  type ManifestEntry,
} from "../core/model.js";

export interface SingleFileManifestInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
}

export interface DeclaredManifestFile {
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ManifestInput {
  readonly entryPath: string;
  readonly files: readonly DeclaredManifestFile[];
  readonly routingMode: CanonicalManifest["routingMode"];
}

const encodedSeparatorPattern = /%(?:2f|5c)/iu;
const inlineMediaTypePattern = /^(?:audio\/|image\/|text\/|video\/|application\/pdf$)/u;
const mediaTypePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[\t\x20-\x21\x23-\x5b\x5d-\x7e]*"))*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseManifestPath(candidate: string): string {
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    encodedSeparatorPattern.test(candidate) ||
    path.posix.isAbsolute(candidate) ||
    candidate !== candidate.normalize("NFC")
  ) {
    throw invalidPath(candidate);
  }

  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.toLocaleLowerCase("en-US") === ".git",
    )
  ) {
    throw invalidPath(candidate);
  }

  return candidate;
}

export function manifestPathFromUrl(pathname: string): string | null {
  if (pathname === "/") return "";
  if (!pathname.startsWith("/")) return null;
  const encodedPath = pathname.slice(1);
  if (encodedSeparatorPattern.test(encodedPath)) return null;

  try {
    return parseManifestPath(decodeURIComponent(encodedPath));
  } catch {
    return null;
  }
}

export function createSingleFileManifest(
  input: SingleFileManifestInput,
): CanonicalManifest {
  return createManifest({
    entryPath: input.path,
    files: [{
      mediaType: input.mediaType,
      path: input.path,
      sha256: sha256(input.bytes),
      size: input.bytes.byteLength,
    }],
    routingMode: routingModes.static,
  });
}

/**
 * Builds deterministic manifest bytes from declared, already-fingerprinted files.
 * It rejects absent entry files, unsafe paths, duplicate paths, and portable-name collisions.
 */
export function createManifest(input: ManifestInput): CanonicalManifest {
  if (input.files.length === 0) {
    throw new EmptyManifest({
      message: "A manifest must contain at least one file.",
    });
  }

  const entries = input.files.map(createManifestEntry).toSorted(compareEntries);
  assertDistinctPortablePaths(entries);
  const entryPath = parseManifestPath(input.entryPath);
  if (!entries.some((entry) => entry.path === entryPath)) {
    throw new MissingManifestEntry({
      message: "The manifest entry file must name one of the published files.",
    });
  }
  const canonicalValue = {
    entries,
    entryPath,
    routingMode: input.routingMode,
  } as const;
  const serialized = JSON.stringify(canonicalValue);

  return {
    ...canonicalValue,
    digest: createHash("sha256").update(serialized).digest("hex"),
    serialized,
  };
}

function createManifestEntry(file: DeclaredManifestFile): ManifestEntry {
  const mediaType = file.mediaType.trim();
  if (
    mediaType.length === 0 ||
    mediaType.length > 200 ||
    !mediaTypePattern.test(mediaType) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !sha256Pattern.test(file.sha256)
  ) {
    throw new InvalidManifestFile({
      message:
        "Each manifest file requires a media type, safe byte length, and SHA-256 fingerprint.",
    });
  }
  return {
    disposition: dispositionFor(mediaType),
    mediaType,
    path: parseManifestPath(file.path),
    sha256: file.sha256,
    size: file.size,
  };
}

function compareEntries(left: ManifestEntry, right: ManifestEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function assertDistinctPortablePaths(entries: readonly ManifestEntry[]): void {
  const portableNames = new Set<string>();
  for (const entry of entries) {
    const portableName = portableCaseFold(entry.path);
    if (portableNames.has(portableName)) {
      throw new InvalidManifestPath({
        message:
          `Manifest paths collide on portable filesystems: ${JSON.stringify(entry.path)}`,
      });
    }
    portableNames.add(portableName);
  }
}

function portableCaseFold(candidate: string): string {
  return caseFold(candidate).normalize("NFC");
}

function dispositionFor(mediaType: string): FileDisposition {
  return inlineMediaTypePattern.test(mediaType)
    ? fileDispositions.inline
    : fileDispositions.attachment;
}

function invalidPath(candidate: string): InvalidManifestPath {
  return new InvalidManifestPath({
    message:
      `The artifact path is not portable or safe: ${JSON.stringify(candidate)}`,
  });
}
