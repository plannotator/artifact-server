export const accessSettings = {
  accountRequired: "account_required",
  publicLink: "public_link",
} as const;

export type AccessSetting = (typeof accessSettings)[keyof typeof accessSettings];

/** Artifact mutation kinds persisted in the standalone action history. */
export const artifactActionKinds = {
  changeAccess: "change_access",
  changeTags: "change_tags",
  delete: "delete",
  publish: "publish",
  restore: "restore",
} as const;

/** One persisted artifact mutation kind. */
export type ArtifactActionKind =
  (typeof artifactActionKinds)[keyof typeof artifactActionKinds];

export const routingModes = {
  static: "static",
} as const;

export type RoutingMode = (typeof routingModes)[keyof typeof routingModes];

export const fileDispositions = {
  attachment: "attachment",
  inline: "inline",
} as const;

export type FileDisposition =
  (typeof fileDispositions)[keyof typeof fileDispositions];

export const uploadStatuses = {
  committed: "committed",
  open: "open",
} as const;

export type UploadStatus =
  (typeof uploadStatuses)[keyof typeof uploadStatuses];

/** Stable identity reserved for the project created with every installation. */
export const defaultProjectId = "prj_default";

/** Initial label used for the project created with every installation. */
export const defaultProjectName = "Default";

/** One project inside an Artifact Server installation. */
export interface ProjectRecord {
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly name: string;
}

export interface ArtifactRecord {
  readonly accessSetting: AccessSetting;
  readonly createdAt: string;
  readonly currentVersionId: string;
  readonly deletedAt: string | null;
  readonly id: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

/** An artifact record whose deletion state is known to be committed. */
export interface ArtifactTombstone extends ArtifactRecord {
  readonly deletedAt: string;
}

/** Stable keyset position used by bounded artifact and action queries. */
export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** One immutable attribution record for an artifact mutation. */
export interface ArtifactActionRecord {
  readonly action: ArtifactActionKind;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** One bounded page of active artifacts. */
export interface ArtifactPage {
  readonly items: readonly ArtifactRecord[];
  readonly nextCursor: PageCursor | null;
}

/** One bounded page of artifact mutation records. */
export interface ArtifactActionPage {
  readonly items: readonly ArtifactActionRecord[];
  readonly nextCursor: PageCursor | null;
}

/** The durable tombstone returned by an artifact deletion. */
export interface ArtifactDeletion {
  readonly artifact: ArtifactTombstone;
  readonly replayed: boolean;
  readonly retainedVersionCount: number;
}

export interface ManifestEntry {
  readonly disposition: FileDisposition;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CanonicalManifest {
  readonly digest: string;
  readonly entryPath: string;
  readonly entries: readonly ManifestEntry[];
  readonly routingMode: RoutingMode;
  readonly serialized: string;
}

export interface VersionRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly entryPath: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly number: number;
  readonly publisherPrincipalId: string;
  readonly projectId: string;
  readonly routingMode: RoutingMode;
}

/** One saved version together with the canonical manifest it references. */
export interface ArtifactVersion {
  readonly manifest: CanonicalManifest;
  readonly version: VersionRecord;
}

/** The current persisted state returned by an artifact management mutation. */
export interface ArtifactState {
  readonly artifact: ArtifactRecord;
  readonly replayed: boolean;
  readonly version: VersionRecord;
}

export interface PublishedVersion {
  readonly artifact: ArtifactRecord;
  readonly replayed: boolean;
  readonly version: VersionRecord;
}

export interface VersionContent {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly contentToken: string;
  readonly entry: ManifestEntry;
  readonly isCurrent: boolean;
  readonly projectId: string;
  readonly versionId: string;
}

/** A one-time authorization to create one version-scoped browser session. */
export interface ContentBootstrapRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tokenDigest: string;
  readonly versionId: string;
}

/** A read-only browser session scoped to one immutable version origin. */
export interface ContentSessionRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tokenDigest: string;
  readonly versionId: string;
}

export interface StagedUploadFile {
  readonly entry: ManifestEntry;
  readonly storageToken: string;
  readonly uploadedAt: string | null;
}

interface StagedUploadBase {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly files: readonly StagedUploadFile[];
  readonly id: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
}

export type StagedUpload = StagedUploadBase &
  (
    | {
      readonly committedVersionId: null;
      readonly status: typeof uploadStatuses.open;
    }
    | {
      readonly committedVersionId: string;
      readonly status: typeof uploadStatuses.committed;
    }
  );
