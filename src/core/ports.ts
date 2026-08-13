import type {
  AccessSetting,
  ArtifactActionPage,
  ArtifactDeletion,
  ArtifactPage,
  ArtifactState,
  ArtifactVersion,
  ArtifactRecord,
  CanonicalManifest,
  ContentBootstrapRecord,
  ContentSessionRecord,
  PageCursor,
  PublishedVersion,
  StagedUpload,
  VersionRecord,
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

export interface PublicationSource {
  readonly kind: "staged_upload";
  readonly principalId: string;
  readonly uploadId: string;
}

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
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly tags: readonly string[];
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
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly versionId: string;
}

/** Values used to atomically restore one existing saved version. */
export interface RestoreArtifactVersion {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly versionId: string;
}

/** Values used to atomically change one artifact's read setting. */
export interface ChangeArtifactAccessSetting {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
}

/** Values used to atomically replace one artifact's complete tag set. */
export interface ChangeArtifactTags {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly tags: readonly string[];
}

/** Values used to atomically tombstone one artifact. */
export interface DeleteArtifact {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
}

/** Values used to read one bounded page of active artifacts. */
export interface ListArtifacts {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly ownerPrincipalId: string | null;
  readonly tag: string | null;
}

/** Values used to read one bounded page of artifact actions. */
export interface ListArtifactActions {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  readonly limit: number;
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
  changeAccessSetting(command: ChangeArtifactAccessSetting): Promise<ArtifactState>;
  changeTags(command: ChangeArtifactTags): Promise<ArtifactState>;
  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion>;
  findArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  findArtifactForAdministration(artifactId: string): Promise<ArtifactRecord | null>;
  findArtifactVersion(
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null>;
  findCurrentVersion(artifactId: string): Promise<PublishedVersion | null>;
  findIdempotentPublication(
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null>;
  findVersionContent(contentToken: string, path: string): Promise<VersionContent | null>;
  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage>;
  listArtifacts(command: ListArtifacts): Promise<ArtifactPage>;
  listArtifactVersions(artifactId: string): Promise<readonly VersionRecord[]>;
  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState>;
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
