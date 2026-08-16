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
  ProjectRecord,
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

/** One inclusive byte range inside a stored blob. */
export interface BlobByteRange {
  readonly endInclusive: number;
  readonly start: number;
}

/** A ranged blob read whose size remains the complete stored-object size. */
export interface OpenedBlobRange extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly range: BlobByteRange;
}

export interface BlobWrite extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface BlobStore {
  inspect(sha256: string): Promise<StoredBlob>;
  open(sha256: string): Promise<OpenedBlob>;
  openRange(sha256: string, range: BlobByteRange): Promise<OpenedBlobRange>;
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
  remove(uploadId: string, storageToken: string): Promise<void>;
}

/** Exact staging objects selected from one expired, uncommitted upload. */
export interface ExpiredStagedUpload {
  readonly files: readonly {readonly storageToken: string}[];
  readonly id: string;
}

export interface PublicationSource {
  readonly kind: "staged_upload";
  readonly principalId: string;
  readonly projectId: string;
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
  readonly projectId: string;
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
  readonly projectId: string;
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
  readonly projectId: string;
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
  readonly projectId: string;
}

/** Values used to atomically transfer one artifact to an active member. */
export interface ChangeArtifactOwnership {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly targetOwnerPrincipalId: string;
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
  readonly projectId: string;
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
  readonly projectId: string;
}

/** Values used to read one bounded page of active artifacts. */
export interface ListArtifacts {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly ownerPrincipalId: string | null;
  readonly projectId: string;
  readonly tag: string | null;
}

/** Values used to read one bounded page of artifact actions. */
export interface ListArtifactActions {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectId: string;
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
  readonly projectId: string;
}

/** Values persisted when creating one project. */
export type CreateProject = ProjectRecord;

/** Values used to change one project's label. */
export interface RenameProject {
  readonly name: string;
  readonly projectId: string;
}

/** Values used to archive or unarchive one project. */
export interface SetProjectArchive {
  readonly archivedAt: string | null;
  readonly projectId: string;
}

/** Persistent project operations required by the project application service. */
export interface ProjectRepository {
  createProject(command: CreateProject): Promise<ProjectRecord>;
  findProject(projectId: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<readonly ProjectRecord[]>;
  renameProject(command: RenameProject): Promise<ProjectRecord>;
  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord>;
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
  changeOwnership(command: ChangeArtifactOwnership): Promise<ArtifactState>;
  changeTags(command: ChangeArtifactTags): Promise<ArtifactState>;
  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion>;
  findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null>;
  findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null>;
  findArtifactVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null>;
  findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null>;
  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null>;
  findVersionContent(
    contentToken: string,
    path: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null>;
  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage>;
  listArtifacts(command: ListArtifacts): Promise<ArtifactPage>;
  listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]>;
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
  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null>;
  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload>;
  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]>;
  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  artifactId(): string;
  contentToken(): string;
  projectId(): string;
  stagedFileToken(): string;
  uploadId(): string;
  versionId(): string;
}
