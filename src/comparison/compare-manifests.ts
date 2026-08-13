import type { CanonicalManifest, ManifestEntry } from "../core/model.js";

/** One unambiguous file move between two manifests. */
export interface ManifestRename {
  readonly from: ManifestEntry;
  readonly to: ManifestEntry;
}

/** One same-path file whose bytes or serving metadata changed. */
export interface ManifestChange {
  readonly after: ManifestEntry;
  readonly before: ManifestEntry;
}

/** Structural comparison between two canonical manifests. */
export interface ManifestComparison {
  readonly added: readonly ManifestEntry[];
  readonly changed: readonly ManifestChange[];
  readonly removed: readonly ManifestEntry[];
  readonly renamed: readonly ManifestRename[];
  readonly unchanged: readonly ManifestEntry[];
}

/** Compare canonical manifests by normalized path and unambiguous fingerprint. */
export function compareManifests(
  before: CanonicalManifest,
  after: CanonicalManifest,
): ManifestComparison {
  const beforeByPath = new Map(
    before.entries.map((entry) => [entry.path, entry] as const),
  );
  const afterByPath = new Map(
    after.entries.map((entry) => [entry.path, entry] as const),
  );
  const addedCandidates: ManifestEntry[] = [];
  const removedCandidates: ManifestEntry[] = [];
  const changed: ManifestChange[] = [];
  const unchanged: ManifestEntry[] = [];

  for (const entry of before.entries) {
    const next = afterByPath.get(entry.path);
    if (next === undefined) {
      removedCandidates.push(entry);
    } else if (entriesEqual(entry, next)) {
      unchanged.push(entry);
    } else {
      changed.push({after: next, before: entry});
    }
  }
  for (const entry of after.entries) {
    if (!beforeByPath.has(entry.path)) addedCandidates.push(entry);
  }

  const removedByFingerprint = groupByFingerprint(removedCandidates);
  const addedByFingerprint = groupByFingerprint(addedCandidates);
  const renamed: ManifestRename[] = [];
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  for (const [fingerprint, removed] of removedByFingerprint) {
    const added = addedByFingerprint.get(fingerprint);
    if (removed.length !== 1 || added?.length !== 1) continue;
    const from = removed[0];
    const to = added[0];
    if (from === undefined || to === undefined) continue;
    renamed.push({from, to});
    renamedFrom.add(from.path);
    renamedTo.add(to.path);
  }

  return {
    added: addedCandidates.filter((entry) => !renamedTo.has(entry.path)),
    changed,
    removed: removedCandidates.filter((entry) => !renamedFrom.has(entry.path)),
    renamed,
    unchanged,
  };
}

function entriesEqual(left: ManifestEntry, right: ManifestEntry): boolean {
  return left.disposition === right.disposition &&
    left.mediaType === right.mediaType &&
    left.sha256 === right.sha256 &&
    left.size === right.size;
}

function groupByFingerprint(
  entries: readonly ManifestEntry[],
): ReadonlyMap<string, readonly ManifestEntry[]> {
  const grouped = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.sha256);
    if (current === undefined) {
      grouped.set(entry.sha256, [entry]);
    } else {
      current.push(entry);
    }
  }
  return grouped;
}
