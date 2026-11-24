import type {AccessSetting, SourceFreshness} from "./model.js";

/** Every file kind the overview may filter by (section 11.2 of the file-management spec). */
export const fileKinds = [
  "site", "html", "markdown", "pdf", "image", "video", "audio", "data", "code", "archive", "text", "other",
] as const;

export type FileKind = (typeof fileKinds)[number];

/** Linked-source states the overview can filter by. */
export const fileLinkFilters = ["any", "linked", "drifted", "missing", "not-linked"] as const;

export type FileLinkFilter = (typeof fileLinkFilters)[number];

export const fileSorts = ["updated", "created", "name", "size", "comments"] as const;

export type FileSort = (typeof fileSorts)[number];

export type FileSortDirection = "asc" | "desc";

/** Largest overview page any surface may request. */
export const maximumFilePageSize = 100;

/** Most tags one facet answer names; the rest are omitted, not summed. */
export const maximumTagFacets = 50;

/** Most values one repeatable overview filter may carry. */
export const maximumFilterValues = 100;

/** Keyset position: the sort value of the last row and its artifact ID. */
export interface FileCursor {
  readonly sort: FileSort;
  readonly direction: FileSortDirection;
  readonly value: string | number;
  readonly id: string;
}

/** A folder scope already resolved to the folders it covers. */
export interface FileFolderScope {
  readonly folderId: string;
  readonly recursive: boolean;
}

/** Filters shared by the overview listing and its facets; values within one filter combine with OR. */
export interface FileFilters {
  readonly installationId: string;
  readonly projectIds: readonly string[];
  readonly folder: FileFolderScope | null;
  readonly kinds: readonly FileKind[];
  readonly tags: readonly string[];
  readonly linked: FileLinkFilter;
  readonly createdAfter: string | null;
  readonly createdBefore: string | null;
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  /** Normalized name search, matching names and exact tags like the artifact list. */
  readonly search: string | null;
}

export interface ListFiles extends FileFilters {
  readonly sort: FileSort;
  readonly direction: FileSortDirection;
  readonly cursor: FileCursor | null;
  readonly limit: number;
}

/** One non-trashed artifact as the overview shows it; the folder path is display only. */
export interface FileListItem {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly folderId: string | null;
  readonly folderPath: readonly {readonly id: string; readonly name: string}[];
  readonly fileKind: FileKind;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  readonly size: number;
  readonly entryMediaType: string;
  readonly tags: readonly string[];
  readonly commentCount: number;
  readonly versionCount: number;
  readonly accessSetting: AccessSetting;
  readonly linked: SourceFreshness | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilePage {
  readonly items: readonly FileListItem[];
  readonly nextCursor: FileCursor | null;
}

/** Bounded counts for the same filters, so a filter bar can show numbers. */
export interface FileFacets {
  readonly total: number;
  readonly kinds: readonly {readonly kind: FileKind; readonly count: number}[];
  readonly projects: readonly {readonly projectId: string; readonly count: number}[];
  readonly tags: readonly {readonly tag: string; readonly count: number}[];
}
