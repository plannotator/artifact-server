export const accessSettings = {
  accountRequired: "account_required",
  publicLink: "public_link",
} as const;

export type AccessSetting = (typeof accessSettings)[keyof typeof accessSettings];

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

export interface ArtifactRecord {
  readonly accessSetting: AccessSetting;
  readonly createdAt: string;
  readonly currentVersionId: string;
  readonly id: string;
  readonly name: string;
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
  readonly id: string;
  readonly manifestDigest: string;
  readonly number: number;
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
