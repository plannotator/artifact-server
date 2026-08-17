import {z} from "zod";

import type {
  ListPublicLinks,
  PublicLinkInventoryPage,
} from "../../../src/application/public-link-administration.js";
import {
  ArtifactMutationConflict,
  ArtifactNotFound,
  IdempotencyConflict,
  ProjectArchived,
  ProjectConflict,
  ProjectNotFound,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
} from "../../../src/core/errors.js";
import {
  accessSettings,
  artifactActionKinds,
  fileDispositions,
  routingModes,
  uploadStatuses,
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactTombstone,
  type ContentSessionRecord,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type ProjectRecord,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../../../src/core/model.js";
import type {
  ArtifactRepository,
  ChangeArtifactAccessSetting,
  ChangeArtifactTags,
  CommitArtifactVersion,
  CommitNewArtifact,
  ContentSessionRepository,
  CreateContentBootstrap,
  CreateProject,
  CreateStagedUpload,
  DeleteArtifact,
  ExchangeContentBootstrap,
  ExpiredStagedUpload,
  ListArtifactActions,
  ListArtifacts,
  PublicationSource,
  ProjectRepository,
  RenameProject,
  RestoreArtifactVersion,
  SetProjectArchive,
  StagedUploadRepository,
} from "../../../src/core/ports.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {
  publicLinkInventoryRowSchema,
  publicLinkPageFromRows,
} from "../../../src/storage/public-link-inventory-row.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const routingModeSchema = z.enum([routingModes.static, routingModes.spa]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const actionSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeTags,
  artifactActionKinds.delete,
  artifactActionKinds.publish,
  artifactActionKinds.restore,
]);
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
const artifactRowSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
});
const tagRowSchema = z.object({artifactId: z.string(), tag: z.string()});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
});
const entryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: actionSchema,
  tagsJson: z.string().nullable(),
  versionId: z.string(),
});
const actionRowSchema = z.object({
  action: actionSchema,
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});
const stagedUploadBaseSchema = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const stagedUploadSchema = z.discriminatedUnion("status", [
  stagedUploadBaseSchema.extend({
    committedVersionId: z.null(),
    status: z.literal(uploadStatuses.open),
  }),
  stagedUploadBaseSchema.extend({
    committedVersionId: z.string(),
    status: z.literal(uploadStatuses.committed),
  }),
]);
const stagedFileSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});
const stagedCommitSchema = z.object({
  expiresAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  manifestDigest: z.string(),
  readyCount: z.number().int().nonnegative(),
  status: uploadStatusSchema,
});
const contentRecordSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  isCurrent: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  mediaType: z.string(),
  path: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  versionId: z.string(),
});

const artifactSelect = `
  SELECT id, project_id AS projectId, name,
    access_setting AS accessSetting,
    current_version_id AS currentVersionId,
    created_at AS createdAt, deleted_at AS deletedAt
  FROM artifacts
`;
const versionSelect = `
  SELECT id, project_id AS projectId, artifact_id AS artifactId, number,
    manifest_digest AS manifestDigest, entry_path AS entryPath,
    routing_mode AS routingMode, content_token AS contentToken,
    publisher_principal_id AS publisherPrincipalId, created_at AS createdAt
  FROM versions
`;
const idempotencySelect = `
  SELECT access_setting AS accessSetting, artifact_id AS artifactId,
    input_digest AS inputDigest, operation, tags_json AS tagsJson,
    version_id AS versionId
  FROM idempotency_records
`;

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

export type D1ArtifactRepository = ArtifactRepository &
  ContentSessionRepository & ProjectRepository & StagedUploadRepository & {
    readonly listPublicLinks: (
      command: ListPublicLinks,
    ) => Promise<PublicLinkInventoryPage>;
  };

/** Build Artifact Server persistence ports over one installation-scoped D1 binding. */
export function createD1ArtifactRepository(
  database: D1Database,
  installationId: string,
): D1ArtifactRepository {
  const readProjectOrNull = async (projectId: string): Promise<ProjectRecord | null> => {
    const row = await database.prepare(`
      SELECT id, installation_id AS installationId, name,
        created_at AS createdAt, archived_at AS archivedAt
      FROM projects WHERE installation_id = ? AND id = ?
    `).bind(installationId, projectId).first<z.input<typeof projectRowSchema>>();
    return row === null ? null : projectRowSchema.parse(row);
  };
  const readProject = async (projectId: string): Promise<ProjectRecord> => {
    const project = await readProjectOrNull(projectId);
    if (project === null) throw new ProjectNotFound({message: "The project does not exist."});
    return project;
  };
  const assertProjectActive = async (projectId: string): Promise<void> => {
    const project = await readProjectOrNull(projectId);
    if (project === null || project.archivedAt !== null) {
      throw new ProjectArchived({
        message: "The project is archived and cannot accept new work.",
      });
    }
  };
  const readTags = async (artifactId: string): Promise<readonly string[]> => {
    const result = await database.prepare(`
      SELECT artifact_id AS artifactId, tag FROM artifact_tags
      WHERE artifact_id = ? ORDER BY tag
    `).bind(artifactId).all<z.input<typeof tagRowSchema>>();
    return result.results.map((row) => tagRowSchema.parse(row).tag);
  };
  const readArtifactOrNull = async (
    projectId: string,
    artifactId: string,
    includeDeleted = false,
  ): Promise<ArtifactRecord | null> => {
    const row = await database.prepare(`${artifactSelect}
      WHERE project_id = ? AND id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
    `).bind(projectId, artifactId).first<z.input<typeof artifactRowSchema>>();
    if (row === null) return null;
    const artifact = artifactRowSchema.parse(row);
    return {...artifact, tags: await readTags(artifact.id)};
  };
  const readArtifact = async (
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> => {
    const artifact = await readArtifactOrNull(projectId, artifactId);
    if (artifact === null) throw new ArtifactNotFound({message: "The artifact does not exist."});
    return artifact;
  };
  const readVersionOrNull = async (
    projectId: string,
    versionId: string,
    artifactId: string,
  ): Promise<VersionRecord | null> => {
    const row = await database.prepare(`${versionSelect}
      WHERE project_id = ? AND id = ? AND artifact_id = ?
    `).bind(projectId, versionId, artifactId)
      .first<z.input<typeof versionRowSchema>>();
    return row === null ? null : versionRowSchema.parse(row);
  };
  const readManifest = async (version: VersionRecord) => {
    const result = await database.prepare(`
      SELECT path, size, media_type AS mediaType, sha256, disposition
      FROM manifest_entries WHERE version_id = ? ORDER BY path
    `).bind(version.id).all<z.input<typeof entryRowSchema>>();
    const stored = result.results.map((row) => entryRowSchema.parse(row));
    const manifest = createManifest({
      entryPath: version.entryPath,
      files: stored.map(({mediaType, path, sha256, size}) => ({
        mediaType,
        path,
        sha256,
        size,
      })),
      routingMode: version.routingMode,
    });
    if (manifest.digest !== version.manifestDigest) {
      throw new Error(`Saved version ${version.id} has an invalid manifest digest.`);
    }
    const canonicalByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    for (const storedEntry of stored) {
      if (canonicalByPath.get(storedEntry.path)?.disposition !== storedEntry.disposition) {
        throw new Error(`Saved version ${version.id} has invalid serving metadata.`);
      }
    }
    return manifest;
  };
  const readPublishedVersion = async (
    projectId: string,
    versionId: string,
    replayed: boolean,
  ): Promise<PublishedVersion> => {
    const versionRow = await database.prepare(`${versionSelect}
      WHERE project_id = ? AND id = ?
    `).bind(projectId, versionId).first<z.input<typeof versionRowSchema>>();
    if (versionRow === null) throw new Error(`Saved version ${versionId} is missing.`);
    const version = versionRowSchema.parse(versionRow);
    const artifact = await readArtifact(projectId, version.artifactId);
    return {artifact, replayed, version};
  };
  const readIdempotency = async (
    projectId: string,
    idempotencyKey: string,
  ) => {
    const row = await database.prepare(`${idempotencySelect}
      WHERE project_id = ? AND idempotency_key = ?
    `).bind(projectId, idempotencyKey)
      .first<z.input<typeof idempotencyRowSchema>>();
    return row === null ? null : idempotencyRowSchema.parse(row);
  };
  const findIdempotentPublication = async (
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> => {
    const record = await readIdempotency(projectId, idempotencyKey);
    if (record === null) return null;
    if (record.operation !== artifactActionKinds.publish || record.inputDigest !== inputDigest) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return readPublishedVersion(projectId, record.versionId, true);
  };
  const readStagedUploadOrNull = async (
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> => {
    const row = await database.prepare(`
      SELECT id, project_id AS projectId, principal_id AS principalId, status,
        manifest_digest AS manifestDigest, entry_path AS entryPath,
        routing_mode AS routingMode, created_at AS createdAt,
        expires_at AS expiresAt, committed_version_id AS committedVersionId
      FROM staged_uploads
      WHERE project_id = ? AND id = ? AND principal_id = ?
    `).bind(projectId, uploadId, principalId)
      .first<z.input<typeof stagedUploadSchema>>();
    if (row === null) return null;
    const upload = stagedUploadSchema.parse(row);
    const filesResult = await database.prepare(`
      SELECT storage_token AS storageToken, path, size,
        media_type AS mediaType, sha256, disposition,
        uploaded_at AS uploadedAt
      FROM staged_upload_files WHERE upload_id = ? ORDER BY path
    `).bind(uploadId).all<z.input<typeof stagedFileSchema>>();
    const files = filesResult.results.map((file) => stagedFileSchema.parse(file));
    const manifest = createManifest({
      entryPath: upload.entryPath,
      files: files.map(({mediaType, path, sha256, size}) => ({
        mediaType,
        path,
        sha256,
        size,
      })),
      routingMode: upload.routingMode,
    });
    if (manifest.digest !== upload.manifestDigest) {
      throw new Error(`Staged upload ${uploadId} has an invalid manifest digest.`);
    }
    const stagedFiles: readonly StagedUploadFile[] = files.map((file) => ({
      entry: {
        disposition: file.disposition,
        mediaType: file.mediaType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      },
      storageToken: file.storageToken,
      uploadedAt: file.uploadedAt,
    }));
    return {...upload, files: stagedFiles, manifest};
  };
  const assertSourceReady = async (
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> => {
    const row = await database.prepare(`
      SELECT u.status, u.expires_at AS expiresAt,
        u.manifest_digest AS manifestDigest,
        COUNT(f.storage_token) AS fileCount,
        COALESCE(SUM(CASE WHEN f.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS readyCount
      FROM staged_uploads u
      LEFT JOIN staged_upload_files f ON f.upload_id = u.id
      WHERE u.project_id = ? AND u.id = ? AND u.principal_id = ?
      GROUP BY u.id
    `).bind(source.projectId, source.uploadId, source.principalId)
      .first<z.input<typeof stagedCommitSchema>>();
    if (row === null) throw new UploadNotFound({message: "The staged upload does not exist."});
    const upload = stagedCommitSchema.parse(row);
    if (upload.status !== uploadStatuses.open) {
      throw new UploadClosed({message: "The staged upload is already committed."});
    }
    if (upload.expiresAt <= commitTime) {
      throw new UploadExpired({message: "The staged upload has expired."});
    }
    if (
      upload.fileCount === 0 || upload.readyCount !== upload.fileCount ||
      upload.manifestDigest !== manifestDigest
    ) {
      throw new UploadIncomplete({
        message: "Every declared upload file must be verified before commit.",
      });
    }
  };
  const artifactState = async (
    projectId: string,
    artifactId: string,
    versionId: string,
    replayed: boolean,
    accessSetting?: ArtifactRecord["accessSetting"],
    tags?: readonly string[],
  ): Promise<ArtifactState> => {
    const artifact = await readArtifact(projectId, artifactId);
    const version = await readVersionOrNull(projectId, versionId, artifactId);
    if (version === null) throw new Error(`Artifact state references missing version ${versionId}.`);
    return {
      artifact: {
        ...artifact,
        accessSetting: accessSetting ?? artifact.accessSetting,
        currentVersionId: versionId,
        tags: tags ?? artifact.tags,
      },
      replayed,
      version,
    };
  };
  const actionStatement = (
    command: {
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
    },
    versionId: string,
    action: ArtifactActionRecord["action"],
  ) => database.prepare(`
    INSERT INTO actions (
      id, project_id, artifact_id, version_id, action, principal_id,
      authorized_by_principal_id, idempotency_key, created_at
    ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    command.projectId,
    command.artifactId,
    versionId,
    action,
    command.principalId,
    command.authorizedByPrincipalId,
    command.idempotencyKey,
    command.createdAt,
  );
  const idempotencyStatement = (
    command: {
      readonly artifactId: string;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    versionId: string,
    operation: ArtifactActionRecord["action"],
    accessSetting: ArtifactRecord["accessSetting"] | null = null,
    tagsJson: string | null = null,
  ) => database.prepare(`
    INSERT INTO idempotency_records (
      project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    command.projectId,
    command.idempotencyKey,
    command.inputDigest,
    command.artifactId,
    versionId,
    operation,
    accessSetting,
    tagsJson,
    command.createdAt,
  );
  const mutationGuardStatements = (
    id: string,
    predicate: string,
    bindings: readonly (number | string | null)[],
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      INSERT INTO mutation_checks (id, succeeded)
      VALUES (?, CASE WHEN EXISTS (${predicate}) THEN 1 ELSE 0 END)
    `).bind(id, ...bindings),
    database.prepare("DELETE FROM mutation_checks WHERE id = ?").bind(id),
  ];
  const publicationGuardStatements = (
    command: CommitNewArtifact | CommitArtifactVersion,
  ): readonly D1PreparedStatement[] => mutationGuardStatements(
    `publish:${command.projectId}:${command.idempotencyKey}`,
    `SELECT 1 FROM artifacts a JOIN staged_uploads u ON u.id = ?
      JOIN idempotency_records i
        ON i.project_id = a.project_id AND i.idempotency_key = ?
      WHERE a.project_id = ? AND a.id = ? AND a.current_version_id = ?
        AND a.deleted_at IS NULL AND u.project_id = ? AND u.principal_id = ?
        AND u.status = 'committed' AND u.committed_version_id = ?
        AND i.input_digest = ? AND i.artifact_id = ? AND i.version_id = ?
        AND i.operation = 'publish'`,
    [
      command.source.uploadId,
      command.idempotencyKey,
      command.projectId,
      command.artifactId,
      command.versionId,
      command.source.projectId,
      command.source.principalId,
      command.versionId,
      command.inputDigest,
      command.artifactId,
      command.versionId,
    ],
  );
  const managementGuardStatements = (
    command: {
      readonly artifactId: string;
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    operation: ArtifactActionRecord["action"],
    currentVersionId: string,
    artifactPredicate: string,
    artifactBindings: readonly (number | string | null)[] = [],
  ): readonly D1PreparedStatement[] => mutationGuardStatements(
    `${operation}:${command.projectId}:${command.idempotencyKey}`,
    `SELECT 1 FROM artifacts a JOIN idempotency_records i
      ON i.project_id = a.project_id AND i.idempotency_key = ?
      WHERE a.project_id = ? AND a.id = ? AND a.current_version_id = ?
        AND ${artifactPredicate}
        AND i.input_digest = ? AND i.artifact_id = ? AND i.version_id = ?
        AND i.operation = ?`,
    [
      command.idempotencyKey,
      command.projectId,
      command.artifactId,
      currentVersionId,
      ...artifactBindings,
      command.inputDigest,
      command.artifactId,
      currentVersionId,
      operation,
    ],
  );
  const versionStatements = (
    command: CommitNewArtifact | CommitArtifactVersion,
    versionNumber: number,
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      INSERT INTO versions (
        id, project_id, artifact_id, number, manifest_digest, entry_path,
        routing_mode, content_token, publisher_principal_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      command.versionId,
      command.projectId,
      command.artifactId,
      versionNumber,
      command.manifest.digest,
      command.manifest.entryPath,
      command.manifest.routingMode,
      command.contentToken,
      command.principalId,
      command.createdAt,
    ),
    ...command.manifest.entries.map((entry) => database.prepare(`
      INSERT INTO manifest_entries (
        version_id, path, size, media_type, sha256, disposition
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      command.versionId,
      entry.path,
      entry.size,
      entry.mediaType,
      entry.sha256,
      entry.disposition,
    )),
  ];
  const managementReplay = async (
    command: {readonly idempotencyKey: string; readonly inputDigest: string; readonly projectId: string},
    operation: typeof artifactActionKinds.changeAccess | typeof artifactActionKinds.changeTags |
      typeof artifactActionKinds.restore,
  ): Promise<ArtifactState | null> => {
    const record = await readIdempotency(command.projectId, command.idempotencyKey);
    if (record === null) return null;
    if (record.inputDigest !== command.inputDigest || record.operation !== operation) {
      throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
    }
    const tags = record.tagsJson === null
      ? undefined
      : z.array(z.string()).parse(JSON.parse(record.tagsJson));
    return artifactState(
      command.projectId,
      record.artifactId,
      record.versionId,
      true,
      record.accessSetting ?? undefined,
      tags,
    );
  };
  const applyManagementMutation = async (
    command: {
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    operation: typeof artifactActionKinds.changeAccess |
      typeof artifactActionKinds.changeTags |
      typeof artifactActionKinds.restore,
    statements: D1PreparedStatement[],
    readState: () => Promise<ArtifactState>,
  ): Promise<ArtifactState> => {
    try {
      const results = await database.batch(statements);
      if (results[0]?.meta.changes !== 1) throw changedDuringManagement();
      return await readState();
    } catch (cause) {
      const raced = await managementReplay(command, operation);
      if (raced !== null) return raced;
      if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
        throw changedDuringManagement();
      }
      throw cause;
    }
  };

  return {
    assertPublicationSourceReady: assertSourceReady,
    close: () => undefined,

    createProject: async (command: CreateProject) => {
      if (command.installationId !== installationId) {
        throw new ProjectConflict({message: "The project belongs to another installation."});
      }
      try {
        await database.prepare(`
          INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          command.id,
          installationId,
          command.name,
          command.createdAt,
          command.archivedAt,
        ).run();
      } catch (cause) {
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new ProjectConflict({message: "The project identity is already in use."});
        }
        throw cause;
      }
      return readProject(command.id);
    },
    findProject: readProjectOrNull,
    listProjects: async () => {
      const result = await database.prepare(`
        SELECT id, installation_id AS installationId, name,
          created_at AS createdAt, archived_at AS archivedAt
        FROM projects WHERE installation_id = ? ORDER BY created_at, id
      `).bind(installationId).all<z.input<typeof projectRowSchema>>();
      return result.results.map((row) => projectRowSchema.parse(row));
    },
    renameProject: async (command: RenameProject) => {
      const result = await database.prepare(`
        UPDATE projects SET name = ? WHERE installation_id = ? AND id = ?
      `).bind(command.name, installationId, command.projectId).run();
      if (result.meta.changes !== 1) throw new ProjectNotFound({message: "The project does not exist."});
      return readProject(command.projectId);
    },
    setProjectArchive: async (command: SetProjectArchive) => {
      const result = await database.prepare(`
        UPDATE projects SET archived_at = ? WHERE installation_id = ? AND id = ?
      `).bind(command.archivedAt, installationId, command.projectId).run();
      if (result.meta.changes !== 1) throw new ProjectNotFound({message: "The project does not exist."});
      return readProject(command.projectId);
    },

    createStagedUpload: async (command: CreateStagedUpload) => {
      await assertProjectActive(command.projectId);
      await database.batch([
        database.prepare(`
          INSERT INTO staged_uploads (
            id, project_id, principal_id, status, manifest_digest, entry_path,
            routing_mode, created_at, expires_at, committed_version_id
          ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)
        `).bind(
          command.id,
          command.projectId,
          command.principalId,
          command.manifest.digest,
          command.manifest.entryPath,
          command.manifest.routingMode,
          command.createdAt,
          command.expiresAt,
        ),
        ...command.files.map((file) => database.prepare(`
          INSERT INTO staged_upload_files (
            upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `).bind(
          command.id,
          file.storageToken,
          file.entry.path,
          file.entry.size,
          file.entry.mediaType,
          file.entry.sha256,
          file.entry.disposition,
        )),
      ]);
      const upload = await readStagedUploadOrNull(
        command.projectId,
        command.id,
        command.principalId,
      );
      if (upload === null) throw new Error("The staged upload was not persisted.");
      return upload;
    },
    findStagedUpload: readStagedUploadOrNull,
    markStagedFileUploaded: async (
      projectId,
      uploadId,
      principalId,
      storageToken,
      uploadedAt,
    ) => {
      await assertProjectActive(projectId);
      const result = await database.prepare(`
        UPDATE staged_upload_files SET uploaded_at = ?
        WHERE upload_id = ? AND storage_token = ? AND EXISTS (
          SELECT 1 FROM staged_uploads u
          WHERE u.id = staged_upload_files.upload_id AND u.project_id = ?
            AND u.principal_id = ? AND u.status = 'open'
            AND u.expires_at > ?
        )
      `).bind(
        uploadedAt,
        uploadId,
        storageToken,
        projectId,
        principalId,
        uploadedAt,
      ).run();
      if (result.meta.changes !== 1) {
        const upload = await readStagedUploadOrNull(projectId, uploadId, principalId);
        if (upload === null) throw new UploadNotFound({message: "The staged upload does not exist."});
        if (upload.status !== uploadStatuses.open) {
          throw new UploadClosed({message: "The staged upload is already committed."});
        }
        if (upload.expiresAt <= uploadedAt) {
          throw new UploadExpired({message: "The staged upload has expired."});
        }
        throw new UploadFileNotFound({message: "The staged upload file does not exist."});
      }
      const upload = await readStagedUploadOrNull(projectId, uploadId, principalId);
      if (upload === null) throw new Error("The staged upload disappeared.");
      return upload;
    },

    commitNewArtifact: async (command: CommitNewArtifact) => {
      const replay = await findIdempotentPublication(
        command.projectId,
        command.idempotencyKey,
        command.inputDigest,
      );
      if (replay !== null) return replay;
      await assertProjectActive(command.projectId);
      await assertSourceReady(command.source, command.manifest.digest, command.createdAt);
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO artifacts (
              id, project_id, name, access_setting,
              current_version_id, created_at, deleted_at
            ) VALUES (?, ?, ?, ?, NULL, ?, NULL)
          `).bind(
            command.artifactId,
            command.projectId,
            command.name,
            command.accessSetting,
            command.createdAt,
          ),
          ...versionStatements(command, 1),
          database.prepare(`
            UPDATE artifacts SET current_version_id = ?
            WHERE project_id = ? AND id = ? AND current_version_id IS NULL
          `).bind(command.versionId, command.projectId, command.artifactId),
          ...command.tags.map((tag) => database.prepare(`
            INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)
          `).bind(command.artifactId, tag)),
          actionStatement(command, command.versionId, artifactActionKinds.publish),
          idempotencyStatement(command, command.versionId, artifactActionKinds.publish),
          database.prepare(`
            UPDATE staged_uploads SET status = 'committed', committed_version_id = ?
            WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'
          `).bind(
            command.versionId,
            command.source.projectId,
            command.source.uploadId,
            command.source.principalId,
          ),
          ...publicationGuardStatements(command),
        ]);
      } catch (cause) {
        const raced = await findIdempotentPublication(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (raced !== null) return raced;
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new PublishConflict({message: "The artifact changed during publication."});
        }
        throw cause;
      }
      return readPublishedVersion(command.projectId, command.versionId, false);
    },
    commitVersion: async (command: CommitArtifactVersion) => {
      const replay = await findIdempotentPublication(
        command.projectId,
        command.idempotencyKey,
        command.inputDigest,
      );
      if (replay !== null) return replay;
      await assertProjectActive(command.projectId);
      await assertSourceReady(command.source, command.manifest.digest, command.createdAt);
      const artifact = await readArtifact(command.projectId, command.artifactId);
      if (artifact.currentVersionId !== command.expectedCurrentVersionId) {
        throw new PublishConflict({message: `The artifact moved to version ${artifact.currentVersionId}.`});
      }
      const nextNumber = await database.prepare(`
        SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
        FROM versions WHERE project_id = ? AND artifact_id = ?
      `).bind(command.projectId, command.artifactId).first<number>("nextNumber");
      if (nextNumber === null) throw new Error("D1 did not calculate the next version number.");
      try {
        await database.batch([
          database.prepare(`
            UPDATE artifacts SET current_version_id = ?
            WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
          `).bind(
            command.versionId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          ),
          ...versionStatements(command, nextNumber),
          actionStatement(command, command.versionId, artifactActionKinds.publish),
          idempotencyStatement(command, command.versionId, artifactActionKinds.publish),
          database.prepare(`
            UPDATE staged_uploads SET status = 'committed', committed_version_id = ?
            WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'
          `).bind(
            command.versionId,
            command.source.projectId,
            command.source.uploadId,
            command.source.principalId,
          ),
          ...publicationGuardStatements(command),
        ]);
      } catch (cause) {
        const raced = await findIdempotentPublication(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (raced !== null) return raced;
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new PublishConflict({message: "The artifact changed during publication."});
        }
        throw cause;
      }
      return readPublishedVersion(command.projectId, command.versionId, false);
    },
    findIdempotentPublication,
    findArtifact: (projectId, artifactId) => readArtifactOrNull(projectId, artifactId),
    findArtifactForAdministration: (projectId, artifactId) =>
      readArtifactOrNull(projectId, artifactId, true),
    findCurrentVersion: async (projectId, artifactId) => {
      const row = await database.prepare(`
        SELECT project_id AS projectId, current_version_id AS currentVersionId
        FROM artifacts WHERE (? IS NULL OR project_id = ?) AND id = ? AND deleted_at IS NULL
      `).bind(projectId, projectId, artifactId).first<{
        readonly currentVersionId: string;
        readonly projectId: string;
      }>();
      return row === null
        ? null
        : readPublishedVersion(row.projectId, row.currentVersionId, false);
    },
    findArtifactVersion: async (projectId, artifactId, versionId) => {
      if (await readArtifactOrNull(projectId, artifactId) === null) return null;
      const version = await readVersionOrNull(projectId, versionId, artifactId);
      return version === null ? null : {manifest: await readManifest(version), version};
    },
    listArtifactVersions: async (projectId, artifactId) => {
      if (await readArtifactOrNull(projectId, artifactId) === null) return [];
      const result = await database.prepare(`${versionSelect}
        WHERE project_id = ? AND artifact_id = ? ORDER BY number DESC
      `).bind(projectId, artifactId).all<z.input<typeof versionRowSchema>>();
      return result.results.map((row) => versionRowSchema.parse(row));
    },
    listExpiredStagedUploads: async (
      expiredBefore: string,
      limit: number,
    ): Promise<readonly ExpiredStagedUpload[]> => {
      const result = await database.prepare(`
        WITH selected AS (
          SELECT id FROM staged_uploads
          WHERE status = 'open' AND expires_at <= ?
          ORDER BY expires_at, id
          LIMIT ?
        )
        SELECT selected.id, file.storage_token AS storageToken
        FROM selected
        JOIN staged_upload_files file ON file.upload_id = selected.id
        ORDER BY selected.id, file.storage_token
      `).bind(expiredBefore, limit)
        .all<z.input<typeof expiredStagedUploadRowSchema>>();
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const candidate of result.results) {
        const row = expiredStagedUploadRowSchema.parse(candidate);
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    },
    removeExpiredStagedUpload: async (
      uploadId: string,
      expiredBefore: string,
    ): Promise<boolean> => {
      const results = await database.batch([
        database.prepare(`
          DELETE FROM staged_upload_files
          WHERE upload_id = ? AND EXISTS (
            SELECT 1 FROM staged_uploads upload
            WHERE upload.id = staged_upload_files.upload_id
              AND upload.status = 'open' AND upload.expires_at <= ?
          )
        `).bind(uploadId, expiredBefore),
        database.prepare(`
          DELETE FROM staged_uploads
          WHERE id = ? AND status = 'open' AND expires_at <= ?
        `).bind(uploadId, expiredBefore),
      ]);
      return results[1]?.meta.changes === 1;
    },
    listArtifacts: async (command: ListArtifacts): Promise<ArtifactPage> => {
      const result = await database.prepare(`${artifactSelect}
        WHERE project_id = ? AND deleted_at IS NULL
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM artifact_tags
            WHERE artifact_tags.artifact_id = artifacts.id AND artifact_tags.tag = ?
          ))
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).bind(
        command.projectId,
        command.tag,
        command.tag,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof artifactRowSchema>>();
      const parsed = result.results.map((row) => artifactRowSchema.parse(row));
      const items = await Promise.all(
        parsed.slice(0, command.limit).map(async (artifact): Promise<ArtifactRecord> =>
          Object.assign({}, artifact, {tags: await readTags(artifact.id)})),
      );
      return pageResult(items, parsed, command.limit);
    },
    listPublicLinks: async (
      command: ListPublicLinks,
    ): Promise<PublicLinkInventoryPage> => {
      const result = await database.prepare(`
        SELECT
          artifact.id AS artifactId,
          artifact.project_id AS projectId,
          artifact.name AS artifactName,
          artifact.access_setting AS accessSetting,
          artifact.current_version_id AS currentVersionId,
          artifact.created_at AS artifactCreatedAt,
          artifact.deleted_at AS artifactDeletedAt,
          project.installation_id AS installationId,
          project.name AS projectName,
          project.created_at AS projectCreatedAt,
          project.archived_at AS projectArchivedAt,
          version.id AS versionId,
          version.number AS versionNumber,
          version.manifest_digest AS manifestDigest,
          version.entry_path AS entryPath,
          version.routing_mode AS routingMode,
          version.content_token AS contentToken,
          version.publisher_principal_id AS publisherPrincipalId,
          version.created_at AS versionCreatedAt
        FROM artifacts artifact
        INNER JOIN projects project ON project.id = artifact.project_id
        INNER JOIN versions version
          ON version.project_id = artifact.project_id
          AND version.artifact_id = artifact.id
          AND version.id = artifact.current_version_id
        WHERE artifact.deleted_at IS NULL
          AND artifact.access_setting = 'public_link'
          AND (? IS NULL OR artifact.created_at < ?
            OR (artifact.created_at = ? AND artifact.id < ?))
        ORDER BY artifact.created_at DESC, artifact.id DESC
        LIMIT ?
      `).bind(
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.output<typeof publicLinkInventoryRowSchema>>();
      const parsedRows = result.results.map((row) =>
        publicLinkInventoryRowSchema.parse(row)
      );
      const artifacts = await Promise.all(parsedRows.map(async (row) => ({
        accessSetting: row.accessSetting,
        createdAt: row.artifactCreatedAt,
        currentVersionId: row.currentVersionId,
        deletedAt: row.artifactDeletedAt,
        id: row.artifactId,
        name: row.artifactName,
        projectId: row.projectId,
        tags: await readTags(row.artifactId),
      })));
      return publicLinkPageFromRows(parsedRows, artifacts, command.limit);
    },
    listArtifactActions: async (command: ListArtifactActions): Promise<ArtifactActionPage> => {
      const result = await database.prepare(`
        SELECT id, project_id AS projectId, artifact_id AS artifactId,
          version_id AS versionId, action, principal_id AS principalId,
          authorized_by_principal_id AS authorizedByPrincipalId,
          idempotency_key AS idempotencyKey, created_at AS createdAt
        FROM actions WHERE project_id = ? AND artifact_id = ?
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).bind(
        command.projectId,
        command.artifactId,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof actionRowSchema>>();
      const parsed = result.results.map((row) => actionRowSchema.parse(row));
      return pageResult(parsed.slice(0, command.limit), parsed, command.limit);
    },
    findVersionContent: async (contentToken, requestedPath, fallback) => {
      const row = await database.prepare(`
        SELECT a.access_setting AS accessSetting, a.id AS artifactId,
          a.project_id AS projectId, v.content_token AS contentToken,
          v.id AS versionId, e.path, e.size, e.media_type AS mediaType,
          e.sha256, e.disposition,
          CASE WHEN v.id = a.current_version_id THEN 1 ELSE 0 END AS isCurrent
        FROM versions v JOIN artifacts a ON a.id = v.artifact_id
        JOIN manifest_entries e ON e.version_id = v.id
        WHERE v.content_token = ?
          AND e.path = CASE
            WHEN ? = '' THEN v.entry_path
            WHEN EXISTS (
              SELECT 1 FROM manifest_entries exact
              WHERE exact.version_id = v.id AND exact.path = ?
            ) THEN ?
            WHEN ? = 'entry' AND v.routing_mode = 'spa' THEN v.entry_path
            ELSE ?
          END
          AND a.deleted_at IS NULL
      `).bind(
        contentToken,
        requestedPath,
        requestedPath,
        requestedPath,
        fallback,
        requestedPath,
      )
        .first<z.input<typeof versionContentRowSchema>>();
      if (row === null) return null;
      const parsed = versionContentRowSchema.parse(row);
      const entry: ManifestEntry = {
        disposition: parsed.disposition,
        mediaType: parsed.mediaType,
        path: parsed.path,
        sha256: parsed.sha256,
        size: parsed.size,
      };
      const content: VersionContent = {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry,
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
      return content;
    },

    changeAccessSetting: async (command: ChangeArtifactAccessSetting) => {
      const replay = await managementReplay(command, artifactActionKinds.changeAccess);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      return applyManagementMutation(command, artifactActionKinds.changeAccess, [
        database.prepare(`
          UPDATE artifacts SET access_setting = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.accessSetting,
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.changeAccess),
        idempotencyStatement(
          command,
          command.expectedCurrentVersionId,
          artifactActionKinds.changeAccess,
          command.accessSetting,
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.changeAccess,
          command.expectedCurrentVersionId,
          "a.deleted_at IS NULL AND a.access_setting = ?",
          [command.accessSetting],
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          false,
          command.accessSetting,
        ));
    },
    changeTags: async (command: ChangeArtifactTags) => {
      const replay = await managementReplay(command, artifactActionKinds.changeTags);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      return applyManagementMutation(command, artifactActionKinds.changeTags, [
        database.prepare(`
          UPDATE artifacts SET current_version_id = current_version_id
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        database.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?").bind(command.artifactId),
        ...command.tags.map((tag) => database.prepare(`
          INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)
        `).bind(command.artifactId, tag)),
        actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.changeTags),
        idempotencyStatement(
          command,
          command.expectedCurrentVersionId,
          artifactActionKinds.changeTags,
          artifact.accessSetting,
          JSON.stringify(command.tags),
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.changeTags,
          command.expectedCurrentVersionId,
          "a.deleted_at IS NULL",
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          false,
          artifact.accessSetting,
          command.tags,
        ));
    },
    restoreVersion: async (command: RestoreArtifactVersion) => {
      const replay = await managementReplay(command, artifactActionKinds.restore);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      if (await readVersionOrNull(command.projectId, command.versionId, command.artifactId) === null) {
        throw new VersionNotFound({message: "The saved version does not exist on this artifact."});
      }
      return applyManagementMutation(command, artifactActionKinds.restore, [
        database.prepare(`
          UPDATE artifacts SET current_version_id = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.versionId,
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        actionStatement(command, command.versionId, artifactActionKinds.restore),
        idempotencyStatement(
          command,
          command.versionId,
          artifactActionKinds.restore,
          artifact.accessSetting,
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.restore,
          command.versionId,
          "a.deleted_at IS NULL",
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          false,
          artifact.accessSetting,
        ));
    },
    deleteArtifact: async (command: DeleteArtifact) => {
      const existingRecord = await readIdempotency(command.projectId, command.idempotencyKey);
      if (existingRecord !== null) {
        if (
          existingRecord.operation !== artifactActionKinds.delete ||
          existingRecord.inputDigest !== command.inputDigest
        ) {
          throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
        }
        return readDeletion(command.projectId, existingRecord.artifactId, true);
      }
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      try {
        const results = await database.batch([
          database.prepare(`
            UPDATE artifacts SET deleted_at = ?
            WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
          `).bind(
            command.createdAt,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          ),
          actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.delete),
          idempotencyStatement(
            command,
            command.expectedCurrentVersionId,
            artifactActionKinds.delete,
            artifact.accessSetting,
          ),
          ...managementGuardStatements(
            command,
            artifactActionKinds.delete,
            command.expectedCurrentVersionId,
            "a.deleted_at = ?",
            [command.createdAt],
          ),
        ]);
        if (results[0]?.meta.changes !== 1) throw changedDuringManagement();
        return await readDeletion(command.projectId, command.artifactId, false);
      } catch (cause) {
        const racedRecord = await readIdempotency(
          command.projectId,
          command.idempotencyKey,
        );
        if (racedRecord !== null) {
          if (
            racedRecord.operation !== artifactActionKinds.delete ||
            racedRecord.inputDigest !== command.inputDigest
          ) {
            throw new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return readDeletion(command.projectId, racedRecord.artifactId, true);
        }
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw changedDuringManagement();
        }
        throw cause;
      }
    },

    createContentBootstrap: async (command: CreateContentBootstrap) => {
      await database.prepare(`
        INSERT INTO content_bootstraps (
          token_digest, principal_id, project_id, artifact_id, version_id,
          content_token, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        command.tokenDigest,
        command.principalId,
        command.projectId,
        command.artifactId,
        command.versionId,
        command.contentToken,
        command.createdAt,
        command.expiresAt,
      ).run();
      return command;
    },
    exchangeContentBootstrap: async (command: ExchangeContentBootstrap) => {
      const row = await database.prepare(`
        SELECT b.token_digest AS tokenDigest, b.principal_id AS principalId,
          b.project_id AS projectId, b.artifact_id AS artifactId,
          b.version_id AS versionId, b.content_token AS contentToken,
          b.created_at AS createdAt, b.expires_at AS expiresAt
        FROM content_bootstraps b JOIN artifacts a ON a.id = b.artifact_id
        WHERE b.token_digest = ? AND b.content_token = ?
          AND b.consumed_at IS NULL AND b.expires_at > ? AND a.deleted_at IS NULL
      `).bind(
        command.bootstrapTokenDigest,
        command.contentToken,
        command.exchangedAt,
      ).first<z.input<typeof contentRecordSchema>>();
      if (row === null) return null;
      const bootstrap = contentRecordSchema.parse(row);
      const session: ContentSessionRecord = {
        artifactId: bootstrap.artifactId,
        contentToken: bootstrap.contentToken,
        createdAt: command.session.createdAt,
        expiresAt: command.session.expiresAt,
        principalId: bootstrap.principalId,
        projectId: bootstrap.projectId,
        tokenDigest: command.session.tokenDigest,
        versionId: bootstrap.versionId,
      };
      try {
        await database.batch([
          database.prepare(`
            UPDATE content_bootstraps
            SET consumed_at = ?, consumed_session_digest = ?
            WHERE token_digest = ? AND consumed_at IS NULL
          `).bind(
            command.exchangedAt,
            session.tokenDigest,
            command.bootstrapTokenDigest,
          ),
          database.prepare(`
            INSERT INTO content_sessions (
              token_digest, principal_id, project_id, artifact_id, version_id,
              content_token, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.tokenDigest,
            session.principalId,
            session.projectId,
            session.artifactId,
            session.versionId,
            session.contentToken,
            session.createdAt,
            session.expiresAt,
          ),
          ...mutationGuardStatements(
            `content-bootstrap:${command.bootstrapTokenDigest}`,
            `SELECT 1 FROM content_bootstraps b JOIN content_sessions s
              ON s.token_digest = ?
              WHERE b.token_digest = ? AND b.consumed_at = ?
                AND b.consumed_session_digest = ?`,
            [
              session.tokenDigest,
              command.bootstrapTokenDigest,
              command.exchangedAt,
              session.tokenDigest,
            ],
          ),
        ]);
        return session;
      } catch (cause) {
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          return null;
        }
        throw cause;
      }
    },
    findContentSession: async (tokenDigest, contentToken, requestTime) => {
      const row = await database.prepare(`
        SELECT s.token_digest AS tokenDigest, s.principal_id AS principalId,
          s.project_id AS projectId, s.artifact_id AS artifactId,
          s.version_id AS versionId, s.content_token AS contentToken,
          s.created_at AS createdAt, s.expires_at AS expiresAt
        FROM content_sessions s JOIN artifacts a ON a.id = s.artifact_id
        WHERE s.token_digest = ? AND s.content_token = ?
          AND s.expires_at > ? AND a.deleted_at IS NULL
      `).bind(tokenDigest, contentToken, requestTime)
        .first<z.input<typeof contentRecordSchema>>();
      return row === null ? null : contentRecordSchema.parse(row);
    },
  };

  async function readDeletion(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): Promise<ArtifactDeletion> {
    const artifact = await readArtifactOrNull(projectId, artifactId, true);
    if (artifact === null || artifact.deletedAt === null) {
      throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
    }
    const tombstone: ArtifactTombstone = {...artifact, deletedAt: artifact.deletedAt};
    const retainedVersionCount = await database.prepare(`
      SELECT COUNT(*) AS retainedVersionCount FROM versions
      WHERE project_id = ? AND artifact_id = ?
    `).bind(projectId, artifactId).first<number>("retainedVersionCount");
    if (retainedVersionCount === null) throw new Error("D1 did not count retained versions.");
    return {artifact: tombstone, replayed, retainedVersionCount};
  }
}

function changedDuringManagement(): ArtifactMutationConflict {
  return new ArtifactMutationConflict({
    message: "The artifact changed while this operation was being applied.",
  });
}

function assertCurrent(
  artifact: ArtifactRecord,
  expectedCurrentVersionId: string,
): void {
  if (artifact.currentVersionId !== expectedCurrentVersionId) {
    throw new ArtifactMutationConflict({
      message: `The artifact moved to version ${artifact.currentVersionId}.`,
    });
  }
}

function pageResult<Item extends {readonly createdAt: string; readonly id: string}>(
  items: readonly Item[],
  allRows: readonly {readonly createdAt: string; readonly id: string}[],
  limit: number,
): PageResult<Item> {
  const boundary = allRows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: boundary === undefined
      ? null
      : {createdAt: boundary.createdAt, id: boundary.id},
  };
}
