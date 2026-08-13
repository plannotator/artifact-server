import type {
  AccessSetting,
  CanonicalManifest,
  ContentBootstrapRecord,
  ContentSessionRecord,
  PublishedVersion,
  StagedUpload,
  VersionContent,
} from "./model.js";

export interface StoredBlob {
  readonly sha256: string;
  readonly size: number;
}

export interface OpenedBlob extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
}

export interface BlobWrite extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
}

export interface BlobStore {
  inspect(sha256: string): Promise<StoredBlob>;
  open(sha256: string): Promise<OpenedBlob>;
  put(write: BlobWrite): Promise<StoredBlob>;
}

export interface StagedFileWrite extends BlobWrite {
  readonly storageToken: string;
  readonly uploadId: string;
}

export interface OpenedStagedFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface StagingStore {
  open(uploadId: string, storageToken: string): Promise<OpenedStagedFile>;
  put(write: StagedFileWrite): Promise<StoredBlob>;
}

export type PublicationSource =
  | {readonly kind: "inline"}
  | {
    readonly kind: "staged_upload";
    readonly principalId: string;
    readonly uploadId: string;
  };

export interface CommitNewArtifact {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly principalId: string;
  readonly source: PublicationSource;
  readonly versionId: string;
}

export interface CommitArtifactVersion {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly source: PublicationSource;
  readonly versionId: string;
}

/** Values persisted when issuing a one-time private-content bootstrap. */
export type CreateContentBootstrap = ContentBootstrapRecord;

/** Values used to atomically exchange a bootstrap for a browser session. */
export interface ExchangeContentBootstrap {
  readonly bootstrapTokenDigest: string;
  readonly contentToken: string;
  readonly exchangedAt: string;
  readonly session: {
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly tokenDigest: string;
  };
}

export interface CreateStagedUpload {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly files: readonly {
    readonly entry: CanonicalManifest["entries"][number];
    readonly storageToken: string;
  }[];
  readonly id: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
}

export interface ArtifactRepository {
  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void>;
  close(): void;
  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion>;
  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion>;
  findCurrentVersion(artifactId: string): Promise<PublishedVersion | null>;
  findIdempotentPublication(
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null>;
  findVersionContent(contentToken: string, path: string): Promise<VersionContent | null>;
}

/** Persistent capabilities required by private browser content sessions. */
export interface ContentSessionRepository {
  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord>;
  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null>;
  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null>;
}

export interface StagedUploadRepository {
  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload>;
  findStagedUpload(uploadId: string, principalId: string): Promise<StagedUpload | null>;
  markStagedFileUploaded(
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  artifactId(): string;
  contentToken(): string;
  stagedFileToken(): string;
  uploadId(): string;
  versionId(): string;
}
