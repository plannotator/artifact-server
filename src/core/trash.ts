import type {FolderName, FolderRecord, PlacementWrite} from "./folders.js";
import type {AccessSetting, ArtifactRecord} from "./model.js";

/** Most artifacts one folder-trash operation may tombstone in one transaction. */
export const maximumTrashGroupArtifacts = 10_000;

/** Largest trash page any surface may request. */
export const maximumTrashPageSize = 100;

/** Where a trashed item sat when it was trashed; the path is display only. */
export interface TrashLocation {
  readonly projectId: string;
  readonly folderId: string | null;
  readonly path: readonly {readonly id: string; readonly name: string}[];
}

interface TrashedItemFields {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly location: TrashLocation;
  readonly trashedAt: string;
  readonly trashedBy: string | null;
  readonly trashGroupId: string | null;
}

/** One trashed, still-recoverable artifact or trash-group root folder. */
export type TrashedItem =
  | TrashedItemFields & {
    readonly kind: "artifact";
    readonly accessSetting: AccessSetting;
    readonly currentVersionId: string;
    readonly fileKind: string | null;
  }
  | TrashedItemFields & {
    readonly kind: "folder";
    readonly revision: number;
    readonly artifactCount: number;
  };

/** Keyset position in the newest-first trash order. */
export interface TrashCursor {
  readonly trashedAt: string;
  readonly id: string;
}

export interface TrashPage {
  readonly items: readonly TrashedItem[];
  readonly nextCursor: TrashCursor | null;
}

export interface ListTrash {
  readonly installationId: string;
  readonly projectIds: readonly string[] | null;
  readonly cursor: TrashCursor | null;
  readonly limit: number;
}

/** Whether recovery could return an item to its original folder. */
export type RecoveryPlacement = "original" | "root";

export interface ArtifactRecovery {
  readonly artifact: ArtifactRecord;
  readonly placement: RecoveryPlacement;
  readonly previousAccessSetting: AccessSetting;
  readonly replayed: boolean;
}

export interface FolderRecovery {
  readonly folder: FolderRecord;
  readonly placement: RecoveryPlacement;
  readonly recoveredArtifactCount: number;
  readonly previouslyPublicArtifactIds: readonly string[];
}

export interface ArtifactPurge {
  readonly artifact: {readonly id: string; readonly projectId: string; readonly name: string; readonly purgedAt: string};
  readonly retainedVersionCount: number;
}

export interface FolderPurge {
  readonly folder: FolderRecord & {readonly purgedAt: string};
  readonly purgedArtifactCount: number;
}

export type TrashWrite = PlacementWrite;

export type RecoverTrash =
  | {readonly kind: "artifact"; readonly artifactId: string}
  | {readonly kind: "folder"; readonly folderId: string; readonly label: FolderName | null};

/**
 * The typed confirmation is the item's exact name. `null` is reserved for a
 * purge batch whose typed item count was already matched before any work.
 */
export type PurgeTrash =
  | {readonly kind: "artifact"; readonly artifactId: string; readonly confirmation: string | null}
  | {readonly kind: "folder"; readonly folderId: string; readonly confirmation: string | null};
