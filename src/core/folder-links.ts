import type {FolderName} from "./folders.js";
import type {SourceFreshness} from "./model.js";

/**
 * Linked folders (project/spec/file-management-spec.md sections 4.5 and 10;
 * ADR 0031). Pure domain values and rules: nothing here reaches the
 * filesystem, SQLite, or a protocol.
 */

/** Non-ignored regular files indexed per link before it turns over-limit. */
export const maximumLinkEntries = 20_000;
/** Directory depth below the linked directory that a scan descends into. */
export const maximumLinkDepth = 16;
/** Directory entries one scan page reads before it yields and commits. */
export const scanPageEntries = 2_000;
/** Scans that may run at once in one installation; more queue. */
export const maximumConcurrentScans = 2;
/** Inventory entries one capture request may name. */
export const maximumCaptureBatch = 100;
/** Folder links one installation may hold. */
export const maximumFolderLinks = 50;
/** Per-link ignore patterns and their length bound. */
export const maximumLinkIgnorePatterns = 100;
export const maximumIgnorePatternCharacters = 200;
/** Bounds of the `.artifactignore` file at the linked directory root. */
export const maximumIgnoreFileBytes = 64 * 1_024;
export const maximumIgnoreFilePatterns = 1_000;
/**
 * Largest single file a linked folder offers for capture. The publish
 * pipeline declares no per-file limit of its own, so this bound is the
 * linked-folder ceiling recorded as `too-large`.
 */
export const maximumLinkedFileBytes = 1_024 * 1_024 * 1_024;
/** Debounce between a watch hint and the scan it schedules. */
export const watchHintDebounceMilliseconds = 750;
/** Backstop reconciliation interval per active link. */
export const reconciliationIntervalMilliseconds = 10 * 60 * 1_000;

/** Name of the per-directory ignore file read at the link root. */
export const artifactIgnoreFileName = ".artifactignore";

/** Persisted scan condition of a folder link. */
export type FolderLinkStatus = "active" | "unavailable" | "over-limit";
/** The state a reader sees: an owner pause overrides the scan condition. */
export type FolderLinkState = FolderLinkStatus | "paused";
/** Why a link is over its limits, so the UI can explain how to narrow it. */
export type OverLimitReason = "entries" | "ignore-file";
/** In-process scan scheduling state of one link. */
export type ScanActivity = "idle" | "queued" | "scanning";

export interface FolderLinkRecord {
  readonly id: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly folderId: string;
  /** Canonical absolute directory; local member metadata only. */
  readonly path: string;
  readonly rootDevice: string;
  readonly ignore: readonly string[];
  readonly status: FolderLinkStatus;
  readonly paused: boolean;
  readonly overLimitReason: OverLimitReason | null;
  readonly lastScanStartedAt: string | null;
  readonly lastScanCompletedAt: string | null;
  readonly entryCount: number;
  readonly pendingCount: number;
  readonly skippedCount: number;
  readonly ignoredCount: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
}

export type InventoryState = "untracked" | "tracked" | "skipped";

export type SkipReason =
  | "symlink"
  | "special"
  | "too-large"
  | "too-deep"
  | "unreadable"
  | "hostile-name"
  | "other-device"
  | "bound-elsewhere";

export interface InventoryEntryRecord {
  readonly id: string;
  readonly folderLinkId: string;
  /** NFC, "/"-separated display path below the linked directory. */
  readonly relativePath: string;
  /** The on-disk spelling used for filesystem calls; never displayed raw. */
  readonly diskPath: string;
  readonly fingerprint: string | null;
  readonly size: number | null;
  readonly observedAt: string;
  readonly state: InventoryState;
  readonly skipReason: SkipReason | null;
  readonly artifactId: string | null;
  /** True when a capture would change history for this entry. */
  readonly pending: boolean;
  /** Freshness of the bound artifact; null unless tracked. */
  readonly freshness: SourceFreshness | null;
}

/** One scanner observation of a directory entry below the link root. */
export type ScanObservation =
  | {
    readonly kind: "file";
    readonly diskPath: string;
    readonly fingerprint: string;
    readonly size: number;
  }
  | {
    readonly kind: "skipped";
    readonly diskPath: string;
    readonly reason: Exclude<SkipReason, "bound-elsewhere">;
    readonly size: number | null;
  };

/** One page of a reconciliation walk. */
export interface ScanPage {
  readonly done: boolean;
  readonly ignoredCount: number;
  readonly observations: readonly ScanObservation[];
}

/** Per-entry outcome of one explicit capture. */
export interface CaptureEntryResult {
  readonly entryId: string;
  readonly relativePath: string | null;
  readonly status: "captured" | "unchanged" | "refused";
  readonly code: string | null;
  readonly message: string | null;
  readonly artifactId: string | null;
  readonly versionId: string | null;
}

/** One hash-verified relink suggestion offered to the owner. */
export interface RelinkSuggestion {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly fromRelativePath: string;
  readonly toEntryId: string;
  readonly toRelativePath: string;
  readonly expectedSha256: string;
}

/** Bindings under a link that relink suggestions compare against. */
export interface LinkedBindingSummary {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly path: string;
  readonly freshness: SourceFreshness;
  readonly capturedSize: number;
  readonly capturedSha256: string;
}

/** The state a reader sees for one link record. */
export function folderLinkState(link: Pick<FolderLinkRecord, "paused" | "status">): FolderLinkState {
  return link.paused ? "paused" : link.status;
}

// Names that cannot be shown or addressed safely: control characters,
// bidirectional overrides, separators, and bytes that did not decode as UTF-8.
const hostileNamePattern = /[\p{Cc}\p{Bidi_Control}\\/�]/u;

/** Decide whether one on-disk name component is hostile (section 9.3). */
export function isHostileName(name: string): boolean {
  return hostileNamePattern.test(name.normalize("NFC"));
}

/** Render a relative path with hostile code points escaped for display. */
export function escapeDisplayPath(diskPath: string): string {
  return diskPath.normalize("NFC").replace(
    /[\p{Cc}\p{Bidi_Control}�]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

/** Two canonical directories overlap when one equals or contains the other. */
export function directoriesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const graphemes = new Intl.Segmenter("en", {granularity: "grapheme"});

/**
 * Turn one directory name into a valid mirrored folder label. Leading or
 * trailing dots and spaces (which folder names refuse) become underscores so
 * `.well-known` still mirrors as a recognizable folder.
 */
export function mirrorFolderLabel(segment: string, nameKey: (value: string) => string): FolderName {
  const normalized = segment.normalize("NFC")
    .replace(/^[.\s]+/u, (match) => "_".repeat(match.length))
    .replace(/[.\s]+$/u, (match) => "_".repeat(match.length));
  const clipped = Array.from(graphemes.segment(normalized), (part) => part.segment).slice(0, 120).join("");
  const name = clipped === "" ? "_" : clipped;
  return {name, nameKey: nameKey(name)};
}

/** Built-in defaults that a per-link `!pattern` may re-include (section 10.3). */
export const builtInIgnorePatterns: readonly string[] = [
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  "*~",
  ".~lock.*",
  "~$*",
  "*.tmp",
  "*.partial",
  "*.crdownload",
  ".*/",
  "!.well-known/",
];

/** The parsed `.artifactignore`, or the reason it puts the link over-limit. */
export type IgnoreFileContent =
  | {readonly kind: "absent"}
  | {readonly kind: "patterns"; readonly patterns: readonly string[]}
  | {readonly kind: "over-limit"};

/** Bound and split one `.artifactignore` body into pattern lines. */
export function parseIgnoreFile(content: string | null, byteLength: number): IgnoreFileContent {
  if (content === null) return {kind: "absent"};
  if (byteLength > maximumIgnoreFileBytes) return {kind: "over-limit"};
  const patterns = content.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  return patterns.length > maximumIgnoreFilePatterns
    ? {kind: "over-limit"}
    : {kind: "patterns", patterns};
}

interface IgnoreRule {
  readonly directoryOnly: boolean;
  readonly negated: boolean;
  readonly pattern: RegExp;
}

/** Decide whether one relative path (directories without a trailing slash) is ignored. */
export type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

/**
 * Compile gitignore-syntax rules in order. As in gitignore, the last matching
 * rule decides, so a later `!pattern` re-includes what an earlier rule
 * excluded; a path below an excluded directory is never reached because the
 * scanner does not descend into it.
 */
export function compileIgnoreRules(lines: readonly string[]): IgnoreMatcher {
  const rules = lines.flatMap((line) => {
    const rule = compileIgnoreLine(line);
    return rule === null ? [] : [rule];
  });
  return (relativePath, isDirectory) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.pattern.test(relativePath)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function compileIgnoreLine(line: string): IgnoreRule | null {
  let body = line.replace(/(?<!\\)\s+$/u, "");
  if (body === "" || body.startsWith("#")) return null;
  let negated = false;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  } else if (body.startsWith("\\!") || body.startsWith("\\#")) {
    body = body.slice(1);
  }
  let directoryOnly = false;
  if (body.endsWith("/")) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  if (body === "") return null;
  const anchored = body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  const source = globSource(body);
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return {directoryOnly, negated, pattern: new RegExp(`${prefix}${source}$`, "u")};
}

function globSource(glob: string): string {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const character = glob.charAt(index);
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
      source += "/.*";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (character === "*") {
      source += "[^/]*";
      index += 1;
    } else if (character === "?") {
      source += "[^/]";
      index += 1;
    } else if (character === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        index += 1;
      } else {
        const inner = glob.slice(index + 1, close).replace(/^!/u, "^").replace(/[\\\]]/gu, "\\$&");
        source += `[${inner}]`;
        index = close + 1;
      }
    } else if (character === "\\" && index + 1 < glob.length) {
      source += escapeRegExp(glob.charAt(index + 1));
      index += 2;
    } else {
      source += escapeRegExp(character);
      index += 1;
    }
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}
