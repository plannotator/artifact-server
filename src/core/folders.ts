import type {ArtifactListItem, PageCursor} from "./model.js";
import type {ListArtifacts} from "./ports.js";

export const maximumFolderDepth = 16;
export const maximumProjectFolders = 10_000;
/** Largest set of live artifacts one cross-project folder move rewrites in a transaction. */
export const maximumProjectMoveArtifacts = 1_000;

export interface FolderRecord {
  readonly id: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly parentFolderId: string | null;
  readonly name: string;
  readonly nameKey: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FolderCursor =
  | {readonly kind: "folder"; readonly nameKey: string}
  | {readonly kind: "artifact"; readonly position: PageCursor};

export interface FolderContents {
  readonly breadcrumbs: readonly FolderRecord[];
  readonly folders: readonly FolderRecord[];
  readonly artifacts: readonly ArtifactListItem[];
  readonly nextCursor: FolderCursor | null;
}

export interface ListFolderContents extends Omit<ListArtifacts, "cursor"> {
  readonly installationId: string;
  readonly folderId: string | null;
  readonly cursor: FolderCursor | null;
  readonly foldersOnly?: boolean;
}

export interface PlacementWrite {
  readonly installationId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
}

export interface FolderName {
  readonly name: string;
  readonly nameKey: string;
}

export type FolderChange =
  | {readonly kind: "create"; readonly id: string; readonly parentFolderId: string | null; readonly label: FolderName}
  | {readonly kind: "update"; readonly id: string; readonly expectedRevision: number; readonly parentFolderId?: string | null; readonly label?: FolderName}
  | {readonly kind: "delete"; readonly id: string; readonly expectedRevision: number; readonly trashGroupId: string};

export type ArtifactPlacementChange =
  | {readonly kind: "move"; readonly toFolderId: string | null}
  | {readonly kind: "rename"; readonly name: string; readonly searchName: string};

export interface ArtifactPlacement {
  readonly id: string;
  readonly projectId: string;
  readonly folderId: string | null;
  readonly name: string;
  readonly currentVersionId: string;
}

/** A placement write whose records leave their project for another active project. */
export interface ProjectMoveWrite extends PlacementWrite {
  readonly toProjectId: string;
}

export interface ArtifactProjectMove extends ProjectMoveWrite {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly toFolderId: string | null;
}

export interface FolderProjectMove extends ProjectMoveWrite {
  readonly folderId: string;
  readonly expectedRevision: number;
  readonly toParentFolderId: string | null;
}

/** Where a live or trashed artifact sits now, for installation-wide readers. */
export interface ArtifactLocation {
  readonly artifactId: string;
  readonly projectId: string;
  readonly folderId: string | null;
}
