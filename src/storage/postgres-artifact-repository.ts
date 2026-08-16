import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {z} from "zod";

import {
  ArtifactMutationConflict,
  ArtifactNotFound,
  IdempotencyConflict,
  ProjectConflict,
  ProjectArchived,
  ProjectNotFound,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
} from "../core/errors.js";
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
  type ArtifactVersion,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type PageCursor,
  defaultProjectId,
  defaultProjectName,
  type PublishedVersion,
  type ProjectRecord,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactRepository,
  ChangeArtifactAccessSetting,
  ChangeArtifactOwnership,
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
} from "../core/ports.js";
import {createManifest} from "../manifest/create-manifest.js";
import type {PostgresDatabase} from "./postgres-database.js";

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
const artifactActionKindSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeOwner,
  artifactActionKinds.changeTags,
  artifactActionKinds.delete,
  artifactActionKinds.publish,
  artifactActionKinds.restore,
]);
const nonnegativeIntegerSchema = z.coerce.number().int().nonnegative();
const positiveIntegerSchema = z.coerce.number().int().positive();
const artifactRowSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string(),
  projectId: z.string(),
});
const artifactTagRowSchema = z.object({artifactId: z.string(), tag: z.string()});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: positiveIntegerSchema,
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const publishedRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactCreatedAt: z.string(),
  artifactDeletedAt: z.string().nullable(),
  artifactId: z.string(),
  artifactName: z.string(),
  contentToken: z.string(),
  currentVersionId: z.string(),
  entryPath: z.string(),
  manifestDigest: z.string(),
  ownerPrincipalId: z.string(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: positiveIntegerSchema,
});
const storedManifestEntryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
});
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  isCurrent: z.boolean(),
  mediaType: z.string(),
  path: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
  versionId: z.string(),
});
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_owner",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
  targetOwnerPrincipalId: z.string().nullable(),
  versionId: z.string(),
});
const artifactActionRowSchema = z.object({
  action: artifactActionKindSchema,
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  targetOwnerPrincipalId: z.string().nullable(),
  versionId: z.string(),
});
const contentRecordRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const stagedUploadRowSchema = z.object({
  committedVersionId: z.string().nullable(),
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
  status: uploadStatusSchema,
});
const stagedUploadFileRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});
const stagedUploadCommitRowSchema = z.object({
  expiresAt: z.string(),
  fileCount: nonnegativeIntegerSchema,
  manifestDigest: z.string(),
  readyCount: nonnegativeIntegerSchema,
  status: uploadStatusSchema,
});
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

/** Installation-scoped Postgres persistence for artifacts and browser content sessions. */
export class PostgresArtifactRepository implements
  ArtifactRepository,
  ContentSessionRepository,
  ProjectRepository,
  StagedUploadRepository
{
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  private constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  /** Create a ready repository scoped to one trusted installation. */
  static async open(
    database: PostgresDatabase,
    installationId: string,
  ): Promise<PostgresArtifactRepository> {
    await database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO artifact_installations (id, created_at)
        VALUES (${installationId}, ${new Date().toISOString()})
        ON CONFLICT (id) DO NOTHING`;
      yield* sql`INSERT INTO projects (
          installation_id, id, name, created_at, archived_at
        ) VALUES (
          ${installationId}, ${defaultProjectId}, ${defaultProjectName},
          ${new Date().toISOString()}, NULL
        ) ON CONFLICT (installation_id, id) DO NOTHING`;
    }));
    return new PostgresArtifactRepository(database, installationId);
  }

  async createProject(command: CreateProject): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`INSERT INTO projects (
          installation_id, id, name, created_at, archived_at
        ) VALUES (
          ${installationId}, ${command.id}, ${command.name},
          ${command.createdAt}, ${command.archivedAt}
        ) ON CONFLICT (installation_id, id) DO NOTHING
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectConflict({message: "The project identity is already in use."});
    }
    return project;
  }

  async findProject(projectId: string): Promise<ProjectRecord | null> {
    return this.#database.run(this.#readProjectOrNull(projectId));
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1
         ORDER BY created_at, id`,
        [installationId],
      );
      return projectRowSchema.array().parse(rows);
    }));
  }

  async renameProject(command: RenameProject): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`UPDATE projects SET name = ${command.name}
        WHERE installation_id = ${installationId} AND id = ${command.projectId}
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  async setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`UPDATE projects SET archived_at = ${command.archivedAt}
        WHERE installation_id = ${installationId} AND id = ${command.projectId}
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  /** The owning Postgres database closes the process pool. */
  close(): void {}

  async assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> {
    await this.#database.run(this.#assertStagedUploadReady(
      source,
      manifestDigest,
      commitTime,
    ));
  }

  async commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        yield* this.#assertProjectActive(command.projectId);
        yield* this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );
        yield* sql`INSERT INTO artifacts (
          installation_id, project_id, id, name, owner_principal_id, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.artifactId}, ${command.name},
          ${command.ownerPrincipalId}, ${command.accessSetting}, NULL,
          ${command.createdAt}, NULL
        )`;
        yield* this.#replaceTags(command.artifactId, command.tags);
        yield* this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          1,
          command.manifest,
          command.principalId,
        );
        yield* sql`UPDATE artifacts SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}`;
        yield* this.#insertAction(command, "publish", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: null,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "publish",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        yield* this.#sealStagedUpload(command.source, command.versionId);
        return yield* this.#readPublishedVersion(
          command.projectId,
          command.versionId,
          false,
        );
      }));
    }));
  }

  async commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        yield* this.#assertProjectActive(command.projectId);
        yield* this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );
        const currentRows = yield* sql.unsafe<{currentVersionId: string}>(
          `SELECT current_version_id AS "currentVersionId"
           FROM artifacts
           WHERE installation_id = $1 AND project_id = $2
             AND id = $3 AND deleted_at IS NULL
           FOR UPDATE`,
          [installationId, command.projectId, command.artifactId],
        );
        const current = z.object({currentVersionId: z.string()}).nullable()
          .parse(currentRows[0] ?? null);
        if (current === null) {
          return yield* new ArtifactNotFound({message: "The artifact does not exist."});
        }
        if (current.currentVersionId !== command.expectedCurrentVersionId) {
          return yield* new PublishConflict({
            message: `The artifact moved to version ${current.currentVersionId}.`,
          });
        }
        const numberRows = yield* sql.unsafe<{nextNumber: number}>(
          `SELECT COALESCE(MAX(number), 0) + 1 AS "nextNumber"
           FROM versions WHERE installation_id = $1 AND project_id = $2
             AND artifact_id = $3`,
          [installationId, command.projectId, command.artifactId],
        );
        const {nextNumber} = z.object({nextNumber: positiveIntegerSchema})
          .parse(numberRows[0]);
        yield* this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          nextNumber,
          command.manifest,
          command.principalId,
        );
        const updated = yield* sql`UPDATE artifacts
          SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) {
          return yield* new PublishConflict({
            message: "The artifact changed during publication.",
          });
        }
        yield* this.#insertAction(command, "publish", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: null,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "publish",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        yield* this.#sealStagedUpload(command.source, command.versionId);
        return yield* this.#readPublishedVersion(
          command.projectId,
          command.versionId,
          false,
        );
      }));
    }));
  }

  async changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactState> {
    return this.#managementTransaction(
      command,
      "change_access",
      command.accessSetting,
      null,
      (sql) => sql`UPDATE artifacts
        SET access_setting = ${command.accessSetting}
        WHERE installation_id = ${this.#installationId}
          AND project_id = ${command.projectId}
          AND id = ${command.artifactId}
          AND current_version_id = ${command.expectedCurrentVersionId}
          AND deleted_at IS NULL
        RETURNING id`,
    );
  }

  async changeOwnership(command: ChangeArtifactOwnership): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentOwnershipResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        if (artifact.ownerPrincipalId === command.targetOwnerPrincipalId) {
          return yield* new ArtifactMutationConflict({
            message: "The target member already owns this artifact.",
          });
        }
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const updated = yield* sql`UPDATE artifacts
          SET owner_principal_id = ${command.targetOwnerPrincipalId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(
          command,
          artifactActionKinds.changeOwner,
          command.expectedCurrentVersionId,
          command.targetOwnerPrincipalId,
        );
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "change_owner",
          projectId: command.projectId,
          tagsJson: null,
          targetOwnerPrincipalId: command.targetOwnerPrincipalId,
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          null,
          command.targetOwnerPrincipalId,
        );
      }));
    }));
  }

  async changeTags(command: ChangeArtifactTags): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentTagResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        yield* this.#replaceTags(command.artifactId, command.tags);
        yield* this.#insertAction(
          command,
          artifactActionKinds.changeTags,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "change_tags",
          projectId: command.projectId,
          tagsJson: JSON.stringify(command.tags),
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          command.tags,
        );
      }));
    }));
  }

  async deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentDeletion(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const updated = yield* sql`UPDATE artifacts
          SET deleted_at = ${command.createdAt}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(
          command,
          artifactActionKinds.delete,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "delete",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readDeletionResult(
          command.projectId,
          command.artifactId,
          false,
        );
      }));
    }));
  }

  async findArtifact(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return this.#database.run(this.#readArtifactOrNull(
      projectId,
      artifactId,
      false,
    ));
  }

  async findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return this.#database.run(this.#readArtifactOrNull(
      projectId,
      artifactId,
      true,
    ));
  }

  async findArtifactVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null> {
    return this.#database.run(Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        false,
      );
      if (artifact === null) return null;
      const version = yield* this.#readVersionOrNull(
        projectId,
        versionId,
        artifactId,
      );
      if (version === null) return null;
      return {manifest: yield* this.#readManifest(version), version};
    }));
  }

  async findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{currentVersionId: string}>(
        `SELECT current_version_id AS "currentVersionId"
         FROM artifacts
         WHERE installation_id = $1
           AND ($2::text IS NULL OR project_id = $2)
           AND id = $3 AND deleted_at IS NULL`,
        [installationId, projectId, artifactId],
      );
      const row = z.object({currentVersionId: z.string()}).nullable()
        .parse(rows[0] ?? null);
      return row === null
        ? null
        : yield* this.#readPublishedVersion(
          projectId,
          row.currentVersionId,
          false,
        );
    }));
  }

  async listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        false,
      );
      if (artifact === null) return [];
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT
          id,
          artifact_id AS "artifactId",
          number,
          manifest_digest AS "manifestDigest",
          entry_path AS "entryPath",
          routing_mode AS "routingMode",
          content_token AS "contentToken",
          publisher_principal_id AS "publisherPrincipalId",
          project_id AS "projectId", created_at AS "createdAt"
         FROM versions
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
         ORDER BY number DESC`,
        [installationId, projectId, artifactId],
      );
      return z.array(versionRowSchema).parse(rows);
    }));
  }

  async listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", name,
          owner_principal_id AS "ownerPrincipalId",
          access_setting AS "accessSetting",
          current_version_id AS "currentVersionId",
          created_at AS "createdAt", deleted_at AS "deletedAt"
         FROM artifacts
         WHERE installation_id = $1 AND project_id = $2
           AND deleted_at IS NULL
           AND ($3::text IS NULL OR owner_principal_id = $3)
           AND ($4::text IS NULL OR EXISTS (
             SELECT 1 FROM artifact_tags
             WHERE artifact_tags.installation_id = artifacts.installation_id
               AND artifact_tags.artifact_id = artifacts.id
               AND artifact_tags.tag = $4
           ))
           AND ($5::text IS NULL OR created_at < $5
             OR (created_at = $5 AND id < $6))
         ORDER BY created_at DESC, id DESC
         LIMIT $7`,
        [
          installationId,
          command.projectId,
          command.ownerPrincipalId,
          command.tag,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      const artifacts = z.array(artifactRowSchema).parse(rows);
      return pageFromRows(
        yield* this.#withTagsForArtifacts(artifacts),
        command.limit,
      );
    }));
  }

  async listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", artifact_id AS "artifactId",
          version_id AS "versionId",
          action, principal_id AS "principalId",
          authorized_by_principal_id AS "authorizedByPrincipalId",
          target_owner_principal_id AS "targetOwnerPrincipalId",
          idempotency_key AS "idempotencyKey", created_at AS "createdAt"
         FROM actions
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
           AND ($4::text IS NULL OR created_at < $4
             OR (created_at = $4 AND id < $5))
         ORDER BY created_at DESC, id DESC
         LIMIT $6`,
        [
          installationId,
          command.projectId,
          command.artifactId,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      return pageFromRows(
        z.array(artifactActionRowSchema).parse(rows),
        command.limit,
      );
    }));
  }

  async restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentManagementResult(
          command.projectId,
          "restore",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const restoredVersion = yield* this.#readVersionOrNull(
          command.projectId,
          command.versionId,
          command.artifactId,
        );
        if (restoredVersion === null) {
          return yield* new VersionNotFound({
            message: "The saved version does not exist on this artifact.",
          });
        }
        const updated = yield* sql`UPDATE artifacts
          SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(command, "restore", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "restore",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          artifact.accessSetting,
          false,
        );
      }));
    }));
  }

  async findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> {
    return this.#database.run(this.#findIdempotentResult(
      projectId,
      idempotencyKey,
      inputDigest,
    ));
  }

  async findVersionContent(
    contentToken: string,
    requestedPath: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT a.access_setting AS "accessSetting", a.id AS "artifactId",
          a.project_id AS "projectId",
          v.content_token AS "contentToken", v.id AS "versionId",
          e.path, e.size, e.media_type AS "mediaType", e.sha256,
          e.disposition, v.id = a.current_version_id AS "isCurrent"
         FROM versions v
         JOIN artifacts a
           ON a.installation_id = v.installation_id AND a.id = v.artifact_id
         JOIN manifest_entries e
           ON e.installation_id = v.installation_id AND e.version_id = v.id
         WHERE v.installation_id = $1 AND v.content_token = $2
           AND e.path = CASE
             WHEN $3 = '' THEN v.entry_path
             WHEN EXISTS (
               SELECT 1 FROM manifest_entries exact
               WHERE exact.installation_id = v.installation_id
                 AND exact.version_id = v.id AND exact.path = $3
             ) THEN $3
             WHEN $4 = 'entry' AND v.routing_mode = 'spa' THEN v.entry_path
             ELSE $3
           END
           AND a.deleted_at IS NULL`,
        [installationId, contentToken, requestedPath, fallback],
      );
      const parsed = versionContentRowSchema.nullable().parse(rows[0] ?? null);
      if (parsed === null) return null;
      return {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry: {
          disposition: parsed.disposition,
          mediaType: parsed.mediaType,
          path: parsed.path,
          sha256: parsed.sha256,
          size: parsed.size,
        },
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
    }));
  }

  async createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO content_bootstraps (
        installation_id, project_id, token_digest, principal_id, artifact_id, version_id,
        content_token, created_at, expires_at, consumed_at
      ) VALUES (
        ${installationId}, ${command.projectId}, ${command.tokenDigest}, ${command.principalId},
        ${command.artifactId}, ${command.versionId}, ${command.contentToken},
        ${command.createdAt}, ${command.expiresAt}, NULL
      )`;
    }));
    return command;
  }

  async exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT b.token_digest AS "tokenDigest",
            b.principal_id AS "principalId", b.artifact_id AS "artifactId",
            b.project_id AS "projectId",
            b.version_id AS "versionId", b.content_token AS "contentToken",
            b.created_at AS "createdAt", b.expires_at AS "expiresAt"
           FROM content_bootstraps b
           JOIN artifacts a
             ON a.installation_id = b.installation_id AND a.id = b.artifact_id
           WHERE b.installation_id = $1 AND b.token_digest = $2
             AND b.content_token = $3 AND b.consumed_at IS NULL
             AND b.expires_at > $4 AND a.deleted_at IS NULL
           FOR UPDATE OF b`,
          [
            installationId,
            command.bootstrapTokenDigest,
            command.contentToken,
            command.exchangedAt,
          ],
        );
        const bootstrap = contentRecordRowSchema.nullable().parse(rows[0] ?? null);
        if (bootstrap === null) return null;
        const consumed = yield* sql`UPDATE content_bootstraps
          SET consumed_at = ${command.exchangedAt}
          WHERE installation_id = ${installationId}
            AND token_digest = ${command.bootstrapTokenDigest}
            AND consumed_at IS NULL
          RETURNING token_digest`;
        if (consumed.length !== 1) return null;
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
        yield* sql`INSERT INTO content_sessions (
          installation_id, project_id, token_digest, principal_id, artifact_id, version_id,
          content_token, created_at, expires_at
        ) VALUES (
          ${installationId}, ${session.projectId}, ${session.tokenDigest}, ${session.principalId},
          ${session.artifactId}, ${session.versionId}, ${session.contentToken},
          ${session.createdAt}, ${session.expiresAt}
        )`;
        return session;
      }));
    }));
  }

  async findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT s.token_digest AS "tokenDigest",
          s.principal_id AS "principalId", s.artifact_id AS "artifactId",
          s.project_id AS "projectId",
          s.version_id AS "versionId", s.content_token AS "contentToken",
          s.created_at AS "createdAt", s.expires_at AS "expiresAt"
         FROM content_sessions s
         JOIN artifacts a
           ON a.installation_id = s.installation_id AND a.id = s.artifact_id
         WHERE s.installation_id = $1 AND s.token_digest = $2
           AND s.content_token = $3 AND s.expires_at > $4
           AND a.deleted_at IS NULL`,
        [installationId, tokenDigest, contentToken, requestTime],
      );
      return contentRecordRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#assertProjectActive(command.projectId);
        yield* sql`INSERT INTO staged_uploads (
          installation_id, project_id, id, principal_id, status, manifest_digest,
          entry_path, routing_mode, created_at, expires_at, committed_version_id
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.id},
          ${command.principalId}, 'open',
          ${command.manifest.digest}, ${command.manifest.entryPath},
          ${command.manifest.routingMode}, ${command.createdAt},
          ${command.expiresAt}, NULL
        )`;
        for (const file of command.files) {
          yield* sql`INSERT INTO staged_upload_files (
            installation_id, upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (
            ${installationId}, ${command.id}, ${file.storageToken},
            ${file.entry.path}, ${file.entry.size}, ${file.entry.mediaType},
            ${file.entry.sha256}, ${file.entry.disposition}, NULL
          )`;
        }
        return yield* this.#readStagedUpload(
          command.projectId,
          command.id,
          command.principalId,
        );
      }));
    }));
  }

  async findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> {
    return this.#database.run(this.#readStagedUploadOrNull(
      projectId,
      uploadId,
      principalId,
    ));
  }

  async listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        WITH selected AS (
          SELECT id FROM staged_uploads
          WHERE installation_id = $1 AND status = 'open' AND expires_at <= $2
          ORDER BY expires_at, id
          LIMIT $3
        )
        SELECT selected.id, file.storage_token AS "storageToken"
        FROM selected
        JOIN staged_upload_files file
          ON file.installation_id = $1 AND file.upload_id = selected.id
        ORDER BY selected.id, file.storage_token
      `, [installationId, expiredBefore, limit]);
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const row of z.array(expiredStagedUploadRowSchema).parse(rows)) {
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    }));
  }

  async removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const selected = yield* sql`SELECT id FROM staged_uploads
          WHERE installation_id = ${installationId} AND id = ${uploadId}
            AND status = 'open' AND expires_at <= ${expiredBefore}
          FOR UPDATE`;
        if (selected.length === 0) return false;
        yield* sql`DELETE FROM staged_upload_files
          WHERE installation_id = ${installationId} AND upload_id = ${uploadId}`;
        const deleted = yield* sql`DELETE FROM staged_uploads
          WHERE installation_id = ${installationId} AND id = ${uploadId}
            AND status = 'open' AND expires_at <= ${expiredBefore}
          RETURNING id`;
        return deleted.length === 1;
      }));
    }));
  }

  async markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#assertProjectActive(projectId);
        const updated = yield* sql`UPDATE staged_upload_files AS file
          SET uploaded_at = ${uploadedAt}
          FROM staged_uploads AS upload
          WHERE file.installation_id = ${installationId}
            AND file.upload_id = ${uploadId}
            AND file.storage_token = ${storageToken}
            AND upload.installation_id = file.installation_id
            AND upload.project_id = ${projectId}
            AND upload.id = file.upload_id
            AND upload.principal_id = ${principalId}
            AND upload.status = 'open'
            AND upload.expires_at > ${uploadedAt}
          RETURNING file.path`;
        if (updated.length !== 1) {
          const upload = yield* this.#readStagedUploadOrNull(
            projectId,
            uploadId,
            principalId,
          );
          if (upload === null) {
            return yield* new UploadNotFound({
              message: "The staged upload does not exist.",
            });
          }
          if (upload.status !== uploadStatuses.open) {
            return yield* new UploadClosed({
              message: "The staged upload is already committed.",
            });
          }
          if (upload.expiresAt <= uploadedAt) {
            return yield* new UploadExpired({
              message: "The staged upload has expired.",
            });
          }
          return yield* new UploadFileNotFound({
            message: "The staged upload file does not exist.",
          });
        }
        return yield* this.#readStagedUpload(projectId, uploadId, principalId);
      }));
    }));
  }

  #managementTransaction(
    command: ChangeArtifactAccessSetting,
    operation: "change_access",
    accessSetting: ArtifactRecord["accessSetting"],
    tagsJson: string | null,
    mutate: (sql: SqlClient) => Effect.Effect<readonly object[], unknown>,
  ): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentManagementResult(
          command.projectId,
          operation,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const updated = yield* mutate(sql);
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(
          command,
          operation,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation,
          projectId: command.projectId,
          tagsJson,
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          accessSetting,
          false,
        );
      }));
    }));
  }

  #readProjectOrNull(
    projectId: string,
  ): Effect.Effect<ProjectRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1 AND id = $2`,
        [installationId, projectId],
      );
      return projectRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #assertProjectActive(
    projectId: string,
  ) {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1 AND id = $2
         FOR SHARE`,
        [installationId, projectId],
      );
      const project = z.object({archivedAt: z.string().nullable()})
        .nullable()
        .parse(rows[0] ?? null);
      if (project === null || project.archivedAt !== null) {
        yield* new ProjectArchived({
          message: "The project is archived and cannot accept new work.",
        });
      }
    });
  }

  #readArtifact(
    projectId: string,
    artifactId: string,
    lock: boolean,
  ): Effect.Effect<ArtifactRecord, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        false,
        lock,
      );
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      return artifact;
    });
  }

  #readArtifactOrNull(
    projectId: string,
    artifactId: string,
    includeDeleted: boolean,
    lock = false,
  ): Effect.Effect<ArtifactRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", name,
          owner_principal_id AS "ownerPrincipalId",
          access_setting AS "accessSetting",
          current_version_id AS "currentVersionId",
          created_at AS "createdAt", deleted_at AS "deletedAt"
         FROM artifacts
         WHERE installation_id = $1 AND project_id = $2 AND id = $3
           ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ${lock ? "FOR UPDATE" : ""}`,
        [installationId, projectId, artifactId],
      );
      const artifact = artifactRowSchema.nullable().parse(rows[0] ?? null);
      return artifact === null
        ? null
        : {...artifact, tags: yield* this.#readTags(artifact.id)};
    });
  }

  #readTags(artifactId: string): Effect.Effect<readonly string[], unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT artifact_id AS "artifactId", tag
         FROM artifact_tags
         WHERE installation_id = $1 AND artifact_id = $2
         ORDER BY tag`,
        [installationId, artifactId],
      );
      return z.array(artifactTagRowSchema).parse(rows).map((row) => row.tag);
    });
  }

  #withTagsForArtifacts(
    artifacts: readonly z.infer<typeof artifactRowSchema>[],
  ): Effect.Effect<readonly ArtifactRecord[], unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      if (artifacts.length === 0) return [];
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT artifact_id AS "artifactId", tag
         FROM artifact_tags
         WHERE installation_id = $1 AND artifact_id = ANY($2::text[])
         ORDER BY artifact_id, tag`,
        [installationId, artifacts.map(({id}) => id)],
      );
      const tagsByArtifact = new Map<string, string[]>();
      for (const artifact of artifacts) tagsByArtifact.set(artifact.id, []);
      for (const row of z.array(artifactTagRowSchema).parse(rows)) {
        tagsByArtifact.get(row.artifactId)?.push(row.tag);
      }
      return artifacts.map((artifact) => ({
        ...artifact,
        tags: tagsByArtifact.get(artifact.id) ?? [],
      }));
    });
  }

  #replaceTags(
    artifactId: string,
    tags: readonly string[],
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM artifact_tags
        WHERE installation_id = ${installationId} AND artifact_id = ${artifactId}`;
      for (const tag of tags) {
        yield* sql`INSERT INTO artifact_tags (
          installation_id, artifact_id, tag
        ) VALUES (${installationId}, ${artifactId}, ${tag})`;
      }
    });
  }

  #readVersionOrNull(
    projectId: string,
    versionId: string,
    artifactId: string,
  ): Effect.Effect<VersionRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, artifact_id AS "artifactId", number,
          manifest_digest AS "manifestDigest", entry_path AS "entryPath",
          routing_mode AS "routingMode", content_token AS "contentToken",
          publisher_principal_id AS "publisherPrincipalId",
          project_id AS "projectId", created_at AS "createdAt"
         FROM versions
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND artifact_id = $4`,
        [installationId, projectId, versionId, artifactId],
      );
      return versionRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #readManifest(
    version: VersionRecord,
  ): Effect.Effect<ArtifactVersion["manifest"], unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT path, size, media_type AS "mediaType", sha256, disposition
         FROM manifest_entries
         WHERE installation_id = $1 AND version_id = $2
         ORDER BY path`,
        [installationId, version.id],
      );
      const storedEntries = z.array(storedManifestEntryRowSchema).parse(rows);
      const manifest = createManifest({
        entryPath: version.entryPath,
        files: storedEntries.map(({mediaType, path, sha256, size}) => ({
          mediaType,
          path,
          sha256,
          size,
        })),
        routingMode: version.routingMode,
      });
      if (manifest.digest !== version.manifestDigest) {
        throw new Error(
          `Saved version ${version.id} has an invalid manifest digest.`,
        );
      }
      const canonicalByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry] as const),
      );
      for (const stored of storedEntries) {
        if (canonicalByPath.get(stored.path)?.disposition !== stored.disposition) {
          throw new Error(
            `Saved version ${version.id} has invalid serving metadata.`,
          );
        }
      }
      return manifest;
    });
  }

  #readPublishedVersion(
    projectId: string | null,
    versionId: string,
    replayed: boolean,
  ): Effect.Effect<PublishedVersion, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT a.id AS "artifactId", a.name AS "artifactName",
          a.project_id AS "projectId",
          a.owner_principal_id AS "ownerPrincipalId",
          a.access_setting AS "accessSetting",
          a.current_version_id AS "currentVersionId",
          a.created_at AS "artifactCreatedAt", a.deleted_at AS "artifactDeletedAt",
          v.id AS "versionId", v.number AS "versionNumber",
          v.manifest_digest AS "manifestDigest", v.entry_path AS "entryPath",
          v.routing_mode AS "routingMode", v.content_token AS "contentToken",
          v.publisher_principal_id AS "publisherPrincipalId",
          v.created_at AS "versionCreatedAt"
         FROM versions v
         JOIN artifacts a
           ON a.installation_id = v.installation_id AND a.id = v.artifact_id
         WHERE v.installation_id = $1
           AND ($2::text IS NULL OR v.project_id = $2)
           AND v.id = $3 AND a.deleted_at IS NULL`,
        [installationId, projectId, versionId],
      );
      const parsed = publishedRowSchema.parse(rows[0]);
      return {
        artifact: {
          accessSetting: parsed.accessSetting,
          createdAt: parsed.artifactCreatedAt,
          currentVersionId: parsed.currentVersionId,
          deletedAt: parsed.artifactDeletedAt,
          id: parsed.artifactId,
          name: parsed.artifactName,
          ownerPrincipalId: parsed.ownerPrincipalId,
          projectId: parsed.projectId,
          tags: yield* this.#readTags(parsed.artifactId),
        },
        replayed,
        version: {
          artifactId: parsed.artifactId,
          contentToken: parsed.contentToken,
          createdAt: parsed.versionCreatedAt,
          entryPath: parsed.entryPath,
          id: parsed.versionId,
          manifestDigest: parsed.manifestDigest,
          number: parsed.versionNumber,
          publisherPrincipalId: parsed.publisherPrincipalId,
          projectId: parsed.projectId,
          routingMode: parsed.routingMode,
        },
      };
    });
  }

  #findIdempotency(
    projectId: string,
    idempotencyKey: string,
  ): Effect.Effect<z.infer<typeof idempotencyRowSchema> | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT access_setting AS "accessSetting", artifact_id AS "artifactId",
          input_digest AS "inputDigest", operation, tags_json AS "tagsJson",
          target_owner_principal_id AS "targetOwnerPrincipalId",
          version_id AS "versionId"
         FROM idempotency_records
         WHERE installation_id = $1 AND project_id = $2
           AND idempotency_key = $3`,
        [installationId, projectId, idempotencyKey],
      );
      return idempotencyRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #findIdempotentResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<PublishedVersion | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (parsed.inputDigest !== inputDigest || parsed.operation !== "publish") {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readPublishedVersion(projectId, parsed.versionId, true);
    });
  }

  #findIdempotentManagementResult(
    projectId: string,
    operation: "change_access" | "restore",
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactState | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (
        parsed.inputDigest !== inputDigest ||
        parsed.operation !== operation ||
        parsed.accessSetting === null
      ) {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readArtifactState(
        projectId,
        parsed.artifactId,
        parsed.versionId,
        parsed.accessSetting,
        true,
      );
    });
  }

  #findIdempotentOwnershipResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactState | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (
        parsed.inputDigest !== inputDigest ||
        parsed.operation !== "change_owner" ||
        parsed.accessSetting === null ||
        parsed.targetOwnerPrincipalId === null
      ) {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readArtifactState(
        projectId,
        parsed.artifactId,
        parsed.versionId,
        parsed.accessSetting,
        true,
        null,
        parsed.targetOwnerPrincipalId,
      );
    });
  }

  #findIdempotentTagResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactState | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (
        parsed.inputDigest !== inputDigest ||
        parsed.operation !== "change_tags" ||
        parsed.accessSetting === null ||
        parsed.tagsJson === null
      ) {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      const decoded: unknown = JSON.parse(parsed.tagsJson);
      const tags = z.array(z.string()).parse(decoded);
      return yield* this.#readArtifactState(
        projectId,
        parsed.artifactId,
        parsed.versionId,
        parsed.accessSetting,
        true,
        tags,
      );
    });
  }

  #findIdempotentDeletion(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactDeletion | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (parsed.inputDigest !== inputDigest || parsed.operation !== "delete") {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readDeletionResult(projectId, parsed.artifactId, true);
    });
  }

  #readArtifactState(
    projectId: string,
    artifactId: string,
    versionId: string,
    accessSetting: ArtifactRecord["accessSetting"],
    replayed: boolean,
    tags: readonly string[] | null = null,
    ownerPrincipalId: string | null = null,
  ): Effect.Effect<ArtifactState, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifact(projectId, artifactId, false);
      const version = yield* this.#readVersionOrNull(
        projectId,
        versionId,
        artifactId,
      );
      if (version === null) {
        throw new Error(`Artifact state references missing version ${versionId}.`);
      }
      return {
        artifact: {
          ...artifact,
          accessSetting,
          currentVersionId: versionId,
          ownerPrincipalId: ownerPrincipalId ?? artifact.ownerPrincipalId,
          tags: tags ?? artifact.tags,
        },
        replayed,
        version,
      };
    });
  }

  #readDeletionResult(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): Effect.Effect<ArtifactDeletion, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        true,
      );
      if (artifact === null || artifact.deletedAt === null) {
        throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
      }
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{retainedVersionCount: number}>(
        `SELECT COUNT(*) AS "retainedVersionCount"
         FROM versions WHERE installation_id = $1 AND project_id = $2
           AND artifact_id = $3`,
        [installationId, projectId, artifactId],
      );
      const {retainedVersionCount} = z.object({
        retainedVersionCount: nonnegativeIntegerSchema,
      }).parse(rows[0]);
      const tombstone: ArtifactTombstone = {
        ...artifact,
        deletedAt: artifact.deletedAt,
      };
      return {artifact: tombstone, replayed, retainedVersionCount};
    });
  }

  #insertVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
    contentToken: string,
    createdAt: string,
    number: number,
    manifest: CommitNewArtifact["manifest"],
    publisherPrincipalId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO versions (
        installation_id, project_id, id, artifact_id, number, manifest_digest, entry_path,
        routing_mode, content_token, publisher_principal_id, created_at
      ) VALUES (
        ${installationId}, ${projectId}, ${versionId}, ${artifactId}, ${number},
        ${manifest.digest}, ${manifest.entryPath}, ${manifest.routingMode},
        ${contentToken}, ${publisherPrincipalId}, ${createdAt}
      )`;
      for (const entry of manifest.entries) {
        yield* sql`INSERT INTO manifest_entries (
          installation_id, version_id, path, size, media_type, sha256, disposition
        ) VALUES (
          ${installationId}, ${versionId}, ${entry.path}, ${entry.size},
          ${entry.mediaType}, ${entry.sha256}, ${entry.disposition}
        )`;
      }
    });
  }

  #insertAction(
    command: {
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
    },
    action: ArtifactActionRecord["action"],
    versionId: string,
    targetOwnerPrincipalId: string | null = null,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO actions (
        installation_id, project_id, id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, target_owner_principal_id,
        idempotency_key, created_at
      ) VALUES (
        ${installationId}, ${command.projectId},
        ${sql.literal("gen_random_uuid()::text")},
        ${command.artifactId}, ${versionId}, ${action}, ${command.principalId},
        ${command.authorizedByPrincipalId}, ${targetOwnerPrincipalId},
        ${command.idempotencyKey},
        ${command.createdAt}
      )`;
    });
  }

  #insertIdempotency(record: {
    readonly accessSetting: ArtifactRecord["accessSetting"] | null;
    readonly artifactId: string;
    readonly createdAt: string;
    readonly idempotencyKey: string;
    readonly inputDigest: string;
    readonly operation: z.infer<typeof idempotencyRowSchema>["operation"];
    readonly projectId: string;
    readonly tagsJson: string | null;
    readonly targetOwnerPrincipalId?: string;
    readonly versionId: string;
  }): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO idempotency_records (
        installation_id, project_id, idempotency_key, input_digest, artifact_id, version_id,
        operation, access_setting, tags_json, target_owner_principal_id, created_at
      ) VALUES (
        ${installationId}, ${record.projectId}, ${record.idempotencyKey},
        ${record.inputDigest},
        ${record.artifactId}, ${record.versionId}, ${record.operation},
        ${record.accessSetting}, ${record.tagsJson},
        ${record.targetOwnerPrincipalId ?? null}, ${record.createdAt}
      )`;
    });
  }

  #assertStagedUploadReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const uploadRows = yield* sql.unsafe<object>(
        `SELECT status, expires_at AS "expiresAt",
          manifest_digest AS "manifestDigest"
         FROM staged_uploads
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND principal_id = $4
         FOR UPDATE`,
        [installationId, source.projectId, source.uploadId, source.principalId],
      );
      const uploadRow = z.object({
        expiresAt: z.string(),
        manifestDigest: z.string(),
        status: uploadStatusSchema,
      }).nullable().parse(uploadRows[0] ?? null);
      if (uploadRow === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      const countRows = yield* sql.unsafe<object>(
        `SELECT COUNT(*) AS "fileCount",
          COUNT(*) FILTER (WHERE uploaded_at IS NOT NULL) AS "readyCount"
         FROM staged_upload_files
         WHERE installation_id = $1 AND upload_id = $2`,
        [installationId, source.uploadId],
      );
      const counts = z.object({
        fileCount: nonnegativeIntegerSchema,
        readyCount: nonnegativeIntegerSchema,
      }).parse(countRows[0]);
      const upload = stagedUploadCommitRowSchema.parse({
        ...uploadRow,
        ...counts,
      });
      if (upload.status !== uploadStatuses.open) {
        return yield* new UploadClosed({
          message: "The staged upload is already committed.",
        });
      }
      if (upload.expiresAt <= commitTime) {
        return yield* new UploadExpired({message: "The staged upload has expired."});
      }
      if (
        upload.fileCount === 0 ||
        upload.readyCount !== upload.fileCount ||
        upload.manifestDigest !== manifestDigest
      ) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }
      return undefined;
    });
  }

  #sealStagedUpload(
    source: PublicationSource,
    versionId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const updated = yield* sql`UPDATE staged_uploads
        SET status = 'committed', committed_version_id = ${versionId}
        WHERE installation_id = ${installationId}
          AND project_id = ${source.projectId}
          AND id = ${source.uploadId}
          AND principal_id = ${source.principalId}
          AND status = 'open'
        RETURNING id`;
      if (updated.length !== 1) {
        return yield* new UploadClosed({
          message: "The staged upload changed during commit.",
        });
      }
      return undefined;
    });
  }

  #readStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const upload = yield* this.#readStagedUploadOrNull(
        projectId,
        uploadId,
        principalId,
      );
      if (upload === null) {
        throw new Error(
          `Staged upload ${uploadId} was not found after a successful write.`,
        );
      }
      return upload;
    });
  }

  #readStagedUploadOrNull(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const headerRows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", principal_id AS "principalId", status,
          manifest_digest AS "manifestDigest", entry_path AS "entryPath",
          routing_mode AS "routingMode", created_at AS "createdAt",
          expires_at AS "expiresAt", committed_version_id AS "committedVersionId"
         FROM staged_uploads
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND principal_id = $4`,
        [installationId, projectId, uploadId, principalId],
      );
      const header = stagedUploadRowSchema.nullable().parse(headerRows[0] ?? null);
      if (header === null) return null;
      const fileRows = yield* sql.unsafe<object>(
        `SELECT storage_token AS "storageToken", path, size,
          media_type AS "mediaType", sha256, disposition,
          uploaded_at AS "uploadedAt"
         FROM staged_upload_files
         WHERE installation_id = $1 AND upload_id = $2
         ORDER BY path`,
        [installationId, uploadId],
      );
      const parsedFiles = z.array(stagedUploadFileRowSchema).parse(fileRows);
      const manifest = createManifest({
        entryPath: header.entryPath,
        files: parsedFiles.map(({mediaType, path, sha256, size}) => ({
          mediaType,
          path,
          sha256,
          size,
        })),
        routingMode: header.routingMode,
      });
      if (manifest.digest !== header.manifestDigest) {
        throw new Error(
          `Staged upload ${uploadId} has an invalid persisted manifest digest.`,
        );
      }
      const manifestByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry] as const),
      );
      const files: readonly StagedUploadFile[] = parsedFiles.map((file) => {
        const entry = manifestByPath.get(file.path);
        if (entry === undefined || entry.disposition !== file.disposition) {
          throw new Error(
            `Staged upload ${uploadId} has invalid persisted file metadata.`,
          );
        }
        return {
          entry,
          storageToken: file.storageToken,
          uploadedAt: file.uploadedAt,
        };
      });
      const common = {
        createdAt: header.createdAt,
        expiresAt: header.expiresAt,
        files,
        id: header.id,
        manifest,
        principalId: header.principalId,
        projectId: header.projectId,
      };
      if (header.status === uploadStatuses.open) {
        return {
          ...common,
          committedVersionId: null,
          status: uploadStatuses.open,
        };
      }
      if (header.committedVersionId === null) {
        throw new Error(`Committed staged upload ${uploadId} has no version.`);
      }
      return {
        ...common,
        committedVersionId: header.committedVersionId,
        status: uploadStatuses.committed,
      };
    });
  }
}

function lockIdempotency(
  sql: SqlClient,
  installationId: string,
  projectId: string,
  idempotencyKey: string,
): Effect.Effect<readonly object[], unknown> {
  return sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`${installationId}:${projectId}:${idempotencyKey}`}, 0)
  )`;
}

const assertExpectedVersion = Effect.fn(
  "PostgresArtifactRepository.assertExpectedVersion",
)(function*(
  artifact: ArtifactRecord,
  expectedCurrentVersionId: string,
): Effect.fn.Return<void, ArtifactMutationConflict> {
  if (artifact.currentVersionId !== expectedCurrentVersionId) {
    return yield* new ArtifactMutationConflict({
      message: `The artifact moved to version ${artifact.currentVersionId}.`,
    });
  }
  return yield* Effect.void;
});

function changedDuringManagement(): ArtifactMutationConflict {
  return new ArtifactMutationConflict({
    message: "The artifact changed during the management operation.",
  });
}

function pageFromRows<Item extends PageCursor>(
  rows: readonly Item[],
  limit: number,
): PageResult<Item> {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastItem !== undefined
      ? {createdAt: lastItem.createdAt, id: lastItem.id}
      : null,
  };
}
