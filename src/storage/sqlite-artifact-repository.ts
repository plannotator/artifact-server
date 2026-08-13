import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  ArtifactMutationConflict,
  ArtifactNotFound,
  IdempotencyConflict,
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
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactRepository,
  ChangeArtifactAccessSetting,
  ChangeArtifactTags,
  CommitArtifactVersion,
  CommitNewArtifact,
  ContentSessionRepository,
  CreateContentBootstrap,
  CreateStagedUpload,
  DeleteArtifact,
  ExchangeContentBootstrap,
  ListArtifactActions,
  ListArtifacts,
  PublicationSource,
  RestoreArtifactVersion,
  StagedUploadRepository,
} from "../core/ports.js";
import { createManifest } from "../manifest/create-manifest.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const routingModeSchema = z.enum([routingModes.static]);
const artifactActionKindSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeTags,
  artifactActionKinds.delete,
  artifactActionKinds.publish,
  artifactActionKinds.restore,
]);
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
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
});
const contentBootstrapRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const contentSessionRowSchema = contentBootstrapRowSchema;
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
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
  versionId: z.string(),
});
const artifactRowSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string(),
});
const artifactTagRowSchema = z.object({
  artifactId: z.string(),
  tag: z.string(),
});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
});
const storedManifestEntryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  isCurrent: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  versionId: z.string(),
});
const stagedUploadBaseRowSchema = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  routingMode: routingModeSchema,
});
const stagedUploadRowSchema = z.discriminatedUnion("status", [
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.null(),
    status: z.literal(uploadStatuses.open),
  }),
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.string(),
    status: z.literal(uploadStatuses.committed),
  }),
]);
const stagedUploadFileRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const stagedUploadCommitRowSchema = z.object({
  expiresAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  manifestDigest: z.string(),
  readyCount: z.number().int().nonnegative(),
  status: uploadStatusSchema,
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

export class SqliteArtifactRepository implements
  ArtifactRepository,
  ContentSessionRepository,
  StagedUploadRepository
{
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.enableDefensive(true);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA synchronous = FULL;");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      this.#assertStagedUploadReady(source, manifestDigest, commitTime);
      return undefined;
    });
  }

  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentResult(
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );

        this.#database
          .prepare(
            `INSERT INTO artifacts (
              id, name, owner_principal_id, access_setting,
              current_version_id, created_at, deleted_at
            ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            command.artifactId,
            command.name,
            command.ownerPrincipalId,
            command.accessSetting,
            command.createdAt,
          );

        this.#replaceTags(command.artifactId, command.tags);

        this.#insertVersion(
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          1,
          command.manifest,
          command.principalId,
        );
        this.#database
          .prepare("UPDATE artifacts SET current_version_id = ? WHERE id = ?")
          .run(command.versionId, command.artifactId);
        this.#insertAction(
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "publish",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        this.#sealStagedUpload(command.source, command.versionId);

        return this.#readPublishedVersion(command.versionId, false);
      }),
    );
  }

  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentResult(
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );

        const currentRow = this.#database
          .prepare(
            `SELECT current_version_id AS currentVersionId
             FROM artifacts
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .get(command.artifactId);
        const current = z
          .object({currentVersionId: z.string()})
          .nullable()
          .parse(currentRow ?? null);
        if (current === null) {
          throw new ArtifactNotFound({message: "The artifact does not exist."});
        }
        if (current.currentVersionId !== command.expectedCurrentVersionId) {
          throw new PublishConflict({
            message: `The artifact moved to version ${current.currentVersionId}.`,
          });
        }

        const numberRow = this.#database
          .prepare(
            `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
             FROM versions
             WHERE artifact_id = ?`,
          )
          .get(command.artifactId);
        const {nextNumber} = z
          .object({nextNumber: z.number().int().positive()})
          .parse(numberRow);

        this.#insertVersion(
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          nextNumber,
          command.manifest,
          command.principalId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET current_version_id = ?
             WHERE id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.versionId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw new PublishConflict({
            message: "The artifact changed during publication.",
          });
        }

        this.#insertAction(
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "publish",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        this.#sealStagedUpload(command.source, command.versionId);

        return this.#readPublishedVersion(command.versionId, false);
      }),
    );
  }

  changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          "change_access",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET access_setting = ?
             WHERE id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.accessSetting,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          "change_access",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_access",
          command.accessSetting,
        );
        return this.#readArtifactState(
          command.artifactId,
          command.expectedCurrentVersionId,
          command.accessSetting,
          false,
        );
      }),
    );
  }

  changeTags(command: ChangeArtifactTags): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentTagResult(
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        this.#replaceTags(command.artifactId, command.tags);
        this.#insertAction(
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.changeTags,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_tags",
          artifact.accessSetting,
          JSON.stringify(command.tags),
        );
        return this.#readArtifactState(
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          command.tags,
        );
      }),
    );
  }

  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentDeletion(
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;

        const artifact = this.#readArtifact(command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET deleted_at = ?
             WHERE id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.createdAt,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.delete,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "delete",
          artifact.accessSetting,
        );
        return this.#readDeletionResult(command.artifactId, false);
      }),
    );
  }

  findArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() => this.#readArtifactOrNull(artifactId));
  }

  findArtifactForAdministration(
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() =>
      this.#readArtifactIncludingDeletedOrNull(artifactId)
    );
  }

  findArtifactVersion(
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null> {
    return Promise.resolve().then(() => {
      if (this.#readArtifactOrNull(artifactId) === null) return null;
      const version = this.#readVersionOrNull(versionId, artifactId);
      if (version === null) return null;
      return {
        manifest: this.#readManifest(version),
        version,
      };
    });
  }

  findCurrentVersion(artifactId: string): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT current_version_id AS currentVersionId
           FROM artifacts
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(artifactId);
      const result = z
        .object({currentVersionId: z.string()})
        .nullable()
        .parse(row ?? null);
      return result === null
        ? null
        : this.#readPublishedVersion(result.currentVersionId, false);
    });
  }

  listArtifactVersions(artifactId: string): Promise<readonly VersionRecord[]> {
    return Promise.resolve().then(() => {
      if (this.#readArtifactOrNull(artifactId) === null) return [];
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            artifact_id AS artifactId,
            number,
            manifest_digest AS manifestDigest,
            entry_path AS entryPath,
            routing_mode AS routingMode,
            content_token AS contentToken,
            publisher_principal_id AS publisherPrincipalId,
            created_at AS createdAt
           FROM versions
           WHERE artifact_id = ?
           ORDER BY number DESC`,
        )
        .all(artifactId);
      return z.array(versionRowSchema).parse(rows);
    });
  }

  listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            name,
            owner_principal_id AS ownerPrincipalId,
            access_setting AS accessSetting,
            current_version_id AS currentVersionId,
            created_at AS createdAt,
            deleted_at AS deletedAt
           FROM artifacts
           WHERE deleted_at IS NULL
             AND (? IS NULL OR owner_principal_id = ?)
             AND (
               ? IS NULL
               OR EXISTS (
                 SELECT 1 FROM artifact_tags
                 WHERE artifact_tags.artifact_id = artifacts.id
                   AND artifact_tags.tag = ?
               )
             )
             AND (
               ? IS NULL
               OR created_at < ?
               OR (created_at = ? AND id < ?)
             )
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          command.ownerPrincipalId,
          command.ownerPrincipalId,
          command.tag,
          command.tag,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        this.#withTagsForArtifacts(z.array(artifactRowSchema).parse(rows)),
        command.limit,
      );
    });
  }

  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            artifact_id AS artifactId,
            version_id AS versionId,
            action,
            principal_id AS principalId,
            authorized_by_principal_id AS authorizedByPrincipalId,
            idempotency_key AS idempotencyKey,
            created_at AS createdAt
           FROM actions
           WHERE artifact_id = ?
             AND (
               ? IS NULL
               OR created_at < ?
               OR (created_at = ? AND id < ?)
             )
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          command.artifactId,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        z.array(artifactActionRowSchema).parse(rows),
        command.limit,
      );
    });
  }

  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          "restore",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        if (this.#readVersionOrNull(command.versionId, command.artifactId) === null) {
          throw new VersionNotFound({
            message: "The saved version does not exist on this artifact.",
          });
        }
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET current_version_id = ?
             WHERE id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.versionId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "restore",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
          "restore",
          artifact.accessSetting,
        );
        return this.#readArtifactState(
          command.artifactId,
          command.versionId,
          artifact.accessSetting,
          false,
        );
      }),
    );
  }

  findIdempotentPublication(
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() =>
      this.#findIdempotentResult(idempotencyKey, inputDigest),
    );
  }

  findVersionContent(
    contentToken: string,
    requestedPath: string,
  ): Promise<VersionContent | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            a.access_setting AS accessSetting,
            a.id AS artifactId,
            v.content_token AS contentToken,
            v.id AS versionId,
            e.path AS path,
            e.size AS size,
            e.media_type AS mediaType,
            e.sha256 AS sha256,
            e.disposition AS disposition
            , CASE WHEN v.id = a.current_version_id THEN 1 ELSE 0 END AS isCurrent
          FROM versions v
          JOIN artifacts a ON a.id = v.artifact_id
          JOIN manifest_entries e ON e.version_id = v.id
          WHERE v.content_token = ?
            AND e.path = CASE WHEN ? = '' THEN v.entry_path ELSE ? END
            AND a.deleted_at IS NULL`,
        )
        .get(contentToken, requestedPath, requestedPath);
      const parsed = versionContentRowSchema.nullable().parse(row ?? null);
      if (parsed === null) return null;
      const entry: ManifestEntry = {
        disposition: parsed.disposition,
        mediaType: parsed.mediaType,
        path: parsed.path,
        sha256: parsed.sha256,
        size: parsed.size,
      };
      return {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry,
        isCurrent: parsed.isCurrent,
        versionId: parsed.versionId,
      };
    });
  }

  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord> {
    return Promise.resolve().then(() => {
      this.#database
        .prepare(
          `INSERT INTO content_bootstraps (
            token_digest, principal_id, artifact_id, version_id,
            content_token, created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          command.tokenDigest,
          command.principalId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          command.expiresAt,
        );
      return command;
    });
  }

  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#database
          .prepare(
            `SELECT
              b.token_digest AS tokenDigest,
              b.principal_id AS principalId,
              b.artifact_id AS artifactId,
              b.version_id AS versionId,
              b.content_token AS contentToken,
              b.created_at AS createdAt,
              b.expires_at AS expiresAt
            FROM content_bootstraps b
            JOIN artifacts a ON a.id = b.artifact_id
            WHERE b.token_digest = ?
              AND b.content_token = ?
              AND b.consumed_at IS NULL
              AND b.expires_at > ?
              AND a.deleted_at IS NULL`,
          )
          .get(
            command.bootstrapTokenDigest,
            command.contentToken,
            command.exchangedAt,
          );
        const bootstrap = contentBootstrapRowSchema.nullable().parse(row ?? null);
        if (bootstrap === null) return null;

        const consumed = this.#database
          .prepare(
            `UPDATE content_bootstraps
             SET consumed_at = ?
             WHERE token_digest = ? AND consumed_at IS NULL`,
          )
          .run(command.exchangedAt, command.bootstrapTokenDigest);
        if (consumed.changes !== 1) return null;

        const session: ContentSessionRecord = {
          artifactId: bootstrap.artifactId,
          contentToken: bootstrap.contentToken,
          createdAt: command.session.createdAt,
          expiresAt: command.session.expiresAt,
          principalId: bootstrap.principalId,
          tokenDigest: command.session.tokenDigest,
          versionId: bootstrap.versionId,
        };
        this.#database
          .prepare(
            `INSERT INTO content_sessions (
              token_digest, principal_id, artifact_id, version_id,
              content_token, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.tokenDigest,
            session.principalId,
            session.artifactId,
            session.versionId,
            session.contentToken,
            session.createdAt,
            session.expiresAt,
          );
        return session;
      }),
    );
  }

  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            s.token_digest AS tokenDigest,
            s.principal_id AS principalId,
            s.artifact_id AS artifactId,
            s.version_id AS versionId,
            s.content_token AS contentToken,
            s.created_at AS createdAt,
            s.expires_at AS expiresAt
          FROM content_sessions s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.token_digest = ?
            AND s.content_token = ?
            AND s.expires_at > ?
            AND a.deleted_at IS NULL`,
        )
        .get(tokenDigest, contentToken, requestTime);
      return contentSessionRowSchema.nullable().parse(row ?? null);
    });
  }

  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO staged_uploads (
              id, principal_id, status, manifest_digest, entry_path,
              routing_mode, created_at, expires_at, committed_version_id
            ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            command.id,
            command.principalId,
            command.manifest.digest,
            command.manifest.entryPath,
            command.manifest.routingMode,
            command.createdAt,
            command.expiresAt,
          );

        const insertFile = this.#database.prepare(
          `INSERT INTO staged_upload_files (
            upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        for (const file of command.files) {
          insertFile.run(
            command.id,
            file.storageToken,
            file.entry.path,
            file.entry.size,
            file.entry.mediaType,
            file.entry.sha256,
            file.entry.disposition,
          );
        }
        return this.#readStagedUpload(command.id, command.principalId);
      }),
    );
  }

  findStagedUpload(
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> {
    return Promise.resolve().then(() =>
      this.#readStagedUploadOrNull(uploadId, principalId),
    );
  }

  markStagedFileUploaded(
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const update = this.#database
          .prepare(
            `UPDATE staged_upload_files
             SET uploaded_at = ?
             WHERE upload_id = ?
               AND storage_token = ?
               AND EXISTS (
                 SELECT 1 FROM staged_uploads u
                 WHERE u.id = staged_upload_files.upload_id
                   AND u.principal_id = ?
                   AND u.status = 'open'
               )`,
          )
          .run(uploadedAt, uploadId, storageToken, principalId);
        if (update.changes !== 1) {
          const upload = this.#readStagedUploadOrNull(uploadId, principalId);
          if (upload === null) {
            throw new UploadNotFound({
              message: "The staged upload does not exist.",
            });
          }
          if (upload.status !== uploadStatuses.open) {
            throw new UploadClosed({
              message: "The staged upload is already committed.",
            });
          }
          throw new UploadFileNotFound({
            message: "The staged upload file does not exist.",
          });
        }
        return this.#readStagedUpload(uploadId, principalId);
      }),
    );
  }

  #assertExpectedCurrentVersion(
    artifact: ArtifactRecord,
    expectedCurrentVersionId: string,
  ): void {
    if (artifact.currentVersionId !== expectedCurrentVersionId) {
      throw new ArtifactMutationConflict({
        message: `The artifact moved to version ${artifact.currentVersionId}.`,
      });
    }
  }

  #findIdempotentManagementResult(
    operation: "change_access" | "restore",
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          version_id AS versionId
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== operation ||
      parsed.accessSetting === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readArtifactState(
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
    );
  }

  #findIdempotentTagResult(
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          version_id AS versionId
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== "change_tags" ||
      parsed.accessSetting === null ||
      parsed.tagsJson === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    const decoded: unknown = JSON.parse(parsed.tagsJson);
    const tags = z.array(z.string()).parse(decoded);
    return this.#readArtifactState(
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
      tags,
    );
  }

  #findIdempotentDeletion(
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactDeletion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          version_id AS versionId
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "delete") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readDeletionResult(parsed.artifactId, true);
  }

  #readArtifact(artifactId: string): ArtifactRecord {
    const artifact = this.#readArtifactOrNull(artifactId);
    if (artifact === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    return artifact;
  }

  #readArtifactOrNull(artifactId: string): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          name,
          owner_principal_id AS ownerPrincipalId,
          access_setting AS accessSetting,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #readArtifactIncludingDeletedOrNull(
    artifactId: string,
  ): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          name,
          owner_principal_id AS ownerPrincipalId,
          access_setting AS accessSetting,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE id = ?`,
      )
      .get(artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #withTags(artifact: z.infer<typeof artifactRowSchema>): ArtifactRecord {
    return {...artifact, tags: this.#readTags(artifact.id)};
  }

  #withTagsForArtifacts(
    artifacts: readonly z.infer<typeof artifactRowSchema>[],
  ): readonly ArtifactRecord[] {
    if (artifacts.length === 0) return [];
    const tagsByArtifact = new Map<string, string[]>();
    for (const artifact of artifacts) tagsByArtifact.set(artifact.id, []);
    const placeholders = artifacts.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id IN (${placeholders})
         ORDER BY artifact_id, tag`,
      )
      .all(...artifacts.map((artifact) => artifact.id));
    for (const row of z.array(artifactTagRowSchema).parse(rows)) {
      tagsByArtifact.get(row.artifactId)?.push(row.tag);
    }
    return artifacts.map((artifact) => ({
      ...artifact,
      tags: tagsByArtifact.get(artifact.id) ?? [],
    }));
  }

  #readTags(artifactId: string): readonly string[] {
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id = ?
         ORDER BY tag`,
      )
      .all(artifactId);
    return z.array(artifactTagRowSchema).parse(rows).map((row) => row.tag);
  }

  #replaceTags(artifactId: string, tags: readonly string[]): void {
    this.#database.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?")
      .run(artifactId);
    const insert = this.#database.prepare(
      "INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) insert.run(artifactId, tag);
  }

  #readDeletionResult(
    artifactId: string,
    replayed: boolean,
  ): ArtifactDeletion {
    const artifact = this.#readArtifactIncludingDeletedOrNull(artifactId);
    if (artifact === null || artifact.deletedAt === null) {
      throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
    }
    const tombstone: ArtifactTombstone = {
      ...artifact,
      deletedAt: artifact.deletedAt,
    };
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS retainedVersionCount
         FROM versions
         WHERE artifact_id = ?`,
      )
      .get(artifactId);
    const {retainedVersionCount} = z.object({
      retainedVersionCount: z.number().int().nonnegative(),
    }).parse(row);
    return {artifact: tombstone, replayed, retainedVersionCount};
  }

  #readArtifactState(
    artifactId: string,
    versionId: string,
    accessSetting: ArtifactRecord["accessSetting"],
    replayed: boolean,
    tags: readonly string[] | null = null,
  ): ArtifactState {
    const artifact = this.#readArtifact(artifactId);
    const version = this.#readVersionOrNull(versionId, artifactId);
    if (version === null) {
      throw new Error(`Artifact state references missing version ${versionId}.`);
    }
    return {
      artifact: {
        ...artifact,
        accessSetting,
        currentVersionId: versionId,
        tags: tags ?? artifact.tags,
      },
      replayed,
      version,
    };
  }

  #readManifest(version: VersionRecord) {
    const rows = this.#database
      .prepare(
        `SELECT
          path,
          size,
          media_type AS mediaType,
          sha256,
          disposition
         FROM manifest_entries
         WHERE version_id = ?
         ORDER BY path`,
      )
      .all(version.id);
    const storedEntries = z.array(storedManifestEntryRowSchema).parse(rows);
    const manifest = createManifest({
      entryPath: version.entryPath,
      files: storedEntries.map((entry) => ({
        mediaType: entry.mediaType,
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
      })),
      routingMode: version.routingMode,
    });
    if (manifest.digest !== version.manifestDigest) {
      throw new Error(`Saved version ${version.id} has an invalid manifest digest.`);
    }
    const canonicalByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    for (const stored of storedEntries) {
      const canonical = canonicalByPath.get(stored.path);
      if (canonical?.disposition !== stored.disposition) {
        throw new Error(`Saved version ${version.id} has invalid serving metadata.`);
      }
    }
    return manifest;
  }

  #readVersionOrNull(
    versionId: string,
    artifactId: string,
  ): VersionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          artifact_id AS artifactId,
          number,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          content_token AS contentToken,
          publisher_principal_id AS publisherPrincipalId,
          created_at AS createdAt
         FROM versions
         WHERE id = ? AND artifact_id = ?`,
      )
      .get(versionId, artifactId);
    return versionRowSchema.nullable().parse(row ?? null);
  }

  #findIdempotentResult(
    idempotencyKey: string,
    inputDigest: string,
  ): PublishedVersion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          version_id AS versionId
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "publish") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readPublishedVersion(parsed.versionId, true);
  }

  #insertAction(
    artifactId: string,
    versionId: string,
    idempotencyKey: string,
    createdAt: string,
    action: ArtifactActionRecord["action"],
    principalId: string,
    authorizedByPrincipalId: string | null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actions (
          id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        versionId,
        action,
        principalId,
        authorizedByPrincipalId,
        idempotencyKey,
        createdAt,
      );
  }

  #assertStagedUploadReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): void {
    if (source.kind === "inline") return;
    const row = this.#database
      .prepare(
        `SELECT
          u.status AS status,
          u.expires_at AS expiresAt,
          u.manifest_digest AS manifestDigest,
          COUNT(f.storage_token) AS fileCount,
          COALESCE(SUM(CASE WHEN f.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS readyCount
        FROM staged_uploads u
        LEFT JOIN staged_upload_files f ON f.upload_id = u.id
        WHERE u.id = ? AND u.principal_id = ?
        GROUP BY u.id`,
      )
      .get(source.uploadId, source.principalId);
    const upload = stagedUploadCommitRowSchema.nullable().parse(row ?? null);
    if (upload === null) {
      throw new UploadNotFound({message: "The staged upload does not exist."});
    }
    if (upload.status !== uploadStatuses.open) {
      throw new UploadClosed({
        message: "The staged upload is already committed.",
      });
    }
    if (upload.expiresAt <= commitTime) {
      throw new UploadExpired({message: "The staged upload has expired."});
    }
    if (
      upload.fileCount === 0 ||
      upload.readyCount !== upload.fileCount ||
      upload.manifestDigest !== manifestDigest
    ) {
      throw new UploadIncomplete({
        message: "Every declared upload file must be verified before commit.",
      });
    }
  }

  #sealStagedUpload(source: PublicationSource, versionId: string): void {
    if (source.kind === "inline") return;
    const update = this.#database
      .prepare(
        `UPDATE staged_uploads
         SET status = 'committed', committed_version_id = ?
         WHERE id = ? AND principal_id = ? AND status = 'open'`,
      )
      .run(versionId, source.uploadId, source.principalId);
    if (update.changes !== 1) {
      throw new UploadClosed({
        message: "The staged upload changed during commit.",
      });
    }
  }

  #insertIdempotency(
    idempotencyKey: string,
    inputDigest: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
    operation:
      | "change_access"
      | "change_tags"
      | "delete"
      | "publish"
      | "restore" = "publish",
    accessSetting: ArtifactRecord["accessSetting"] | null = null,
    tagsJson: string | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO idempotency_records (
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idempotencyKey,
        inputDigest,
        artifactId,
        versionId,
        operation,
        accessSetting,
        tagsJson,
        createdAt,
      );
  }

  #insertVersion(
    artifactId: string,
    versionId: string,
    contentToken: string,
    createdAt: string,
    number: number,
    manifest: CommitNewArtifact["manifest"],
    publisherPrincipalId: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO versions (
          id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        artifactId,
        number,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        contentToken,
        publisherPrincipalId,
        createdAt,
      );

    const insertEntry = this.#database.prepare(
      `INSERT INTO manifest_entries (
        version_id, path, size, media_type, sha256, disposition
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of manifest.entries) {
      insertEntry.run(
        versionId,
        entry.path,
        entry.size,
        entry.mediaType,
        entry.sha256,
        entry.disposition,
      );
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        number INTEGER NOT NULL CHECK (number > 0),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
        content_token TEXT NOT NULL UNIQUE,
        publisher_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (artifact_id, number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS manifest_entries (
        version_id TEXT NOT NULL REFERENCES versions(id),
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        PRIMARY KEY (version_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_tags (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (artifact_id, tag)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
        access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
        tags_json TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_uploads (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        committed_version_id TEXT REFERENCES versions(id),
        CHECK (
          (status = 'open' AND committed_version_id IS NULL)
          OR (status = 'committed' AND committed_version_id IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_upload_files (
        upload_id TEXT NOT NULL REFERENCES staged_uploads(id),
        storage_token TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        uploaded_at TEXT,
        PRIMARY KEY (upload_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_bootstraps (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_sessions (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS versions_artifact_id
        ON versions (artifact_id, number);
      CREATE INDEX IF NOT EXISTS artifacts_active_created
        ON artifacts (deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS artifact_tags_tag_artifact
        ON artifact_tags (tag, artifact_id);
      CREATE INDEX IF NOT EXISTS actions_artifact_created
        ON actions (artifact_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS manifest_entries_sha256
        ON manifest_entries (sha256);
      CREATE INDEX IF NOT EXISTS staged_uploads_expiry
        ON staged_uploads (status, expires_at);
      CREATE INDEX IF NOT EXISTS content_bootstraps_expiry
        ON content_bootstraps (expires_at, consumed_at);
      CREATE INDEX IF NOT EXISTS content_sessions_expiry
        ON content_sessions (expires_at);
    `);
    this.#addArtifactOwnerColumnIfMissing();
    this.#addVersionPublisherColumnIfMissing();
    this.#addActionAuthorizerColumnIfMissing();
    this.#addIdempotencyOperationColumnsIfMissing();
    this.#addTagIdempotencyOperationIfMissing();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS artifacts_owner_active_created
        ON artifacts (owner_principal_id, deleted_at, created_at DESC, id DESC);
    `);
  }

  #addTagIdempotencyOperationIfMissing(): void {
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_records'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (sql.includes("'change_tags'")) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE idempotency_records_next (
          idempotency_key TEXT PRIMARY KEY,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO idempotency_records_next (
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        )
        SELECT
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        FROM idempotency_records;

        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_next RENAME TO idempotency_records;
      `);
    });
  }

  #addActionAuthorizerColumnIfMissing(): void {
    const columns = this.#tableColumns("actions");
    if (columns.includes("authorized_by_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE actions ADD COLUMN authorized_by_principal_id TEXT",
    );
  }

  #addArtifactOwnerColumnIfMissing(): void {
    const columns = this.#tableColumns("artifacts");
    if (columns.includes("owner_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE artifacts ADD COLUMN owner_principal_id TEXT NOT NULL DEFAULT 'local-api-token'",
    );
  }

  #addIdempotencyOperationColumnsIfMissing(): void {
    const columns = this.#tableColumns("idempotency_records");
    if (!columns.includes("operation")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'delete'))",
      );
    }
    if (!columns.includes("access_setting")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link'))",
      );
    }
    if (!columns.includes("tags_json")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN tags_json TEXT",
      );
    }
  }

  #addVersionPublisherColumnIfMissing(): void {
    const columns = this.#tableColumns("versions");
    if (columns.includes("publisher_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE versions ADD COLUMN publisher_principal_id TEXT NOT NULL DEFAULT 'local-api-token'",
    );
  }

  #tableColumns(table: "actions" | "artifacts" | "idempotency_records" | "versions"): readonly string[] {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all();
    const columns = z.array(z.object({name: z.string()})).parse(rows);
    return columns.map((column) => column.name);
  }

  #readStagedUpload(uploadId: string, principalId: string): StagedUpload {
    const upload = this.#readStagedUploadOrNull(uploadId, principalId);
    if (upload === null) {
      throw new Error(`Staged upload ${uploadId} was not found after a successful write.`);
    }
    return upload;
  }

  #readStagedUploadOrNull(
    uploadId: string,
    principalId: string,
  ): StagedUpload | null {
    const row = this.#database
      .prepare(
        `SELECT
          id AS id,
          principal_id AS principalId,
          status AS status,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          created_at AS createdAt,
          expires_at AS expiresAt,
          committed_version_id AS committedVersionId
        FROM staged_uploads
        WHERE id = ? AND principal_id = ?`,
      )
      .get(uploadId, principalId);
    const header = stagedUploadRowSchema.nullable().parse(row ?? null);
    if (header === null) return null;

    const fileRows = this.#database
      .prepare(
        `SELECT
          storage_token AS storageToken,
          path AS path,
          size AS size,
          media_type AS mediaType,
          sha256 AS sha256,
          disposition AS disposition,
          uploaded_at AS uploadedAt
        FROM staged_upload_files
        WHERE upload_id = ?
        ORDER BY path`,
      )
      .all(uploadId);
    const parsedFiles = z.array(stagedUploadFileRowSchema).parse(fileRows);
    const manifest = createManifest({
      entryPath: header.entryPath,
      files: parsedFiles.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
      routingMode: header.routingMode,
    });
    if (manifest.digest !== header.manifestDigest) {
      throw new Error(`Staged upload ${uploadId} has an invalid persisted manifest digest.`);
    }
    const manifestByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    const files: readonly StagedUploadFile[] = parsedFiles.map((file) => {
      const entry = manifestByPath.get(file.path);
      if (entry === undefined || entry.disposition !== file.disposition) {
        throw new Error(`Staged upload ${uploadId} has invalid persisted file metadata.`);
      }
      return {
        entry,
        storageToken: file.storageToken,
        uploadedAt: file.uploadedAt,
      };
    });
    const commonUpload = {
      createdAt: header.createdAt,
      expiresAt: header.expiresAt,
      files,
      id: header.id,
      manifest,
      principalId: header.principalId,
    };
    if (header.status === uploadStatuses.open) {
      return {
        ...commonUpload,
        committedVersionId: header.committedVersionId,
        status: header.status,
      };
    }
    return {
      ...commonUpload,
      committedVersionId: header.committedVersionId,
      status: header.status,
    };
  }

  #readPublishedVersion(versionId: string, replayed: boolean): PublishedVersion {
    const row = this.#database
      .prepare(
        `SELECT
          a.id AS artifactId,
          a.name AS artifactName,
          a.owner_principal_id AS ownerPrincipalId,
          a.access_setting AS accessSetting,
          a.current_version_id AS currentVersionId,
          a.created_at AS artifactCreatedAt,
          a.deleted_at AS artifactDeletedAt,
          v.id AS versionId,
          v.number AS versionNumber,
          v.manifest_digest AS manifestDigest,
          v.entry_path AS entryPath,
          v.routing_mode AS routingMode,
          v.content_token AS contentToken,
          v.publisher_principal_id AS publisherPrincipalId,
          v.created_at AS versionCreatedAt
        FROM versions v
        JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.id = ? AND a.deleted_at IS NULL`,
      )
      .get(versionId);
    const parsed = publishedRowSchema.parse(row);
    const artifact: ArtifactRecord = {
      accessSetting: parsed.accessSetting,
      createdAt: parsed.artifactCreatedAt,
      currentVersionId: parsed.currentVersionId,
      deletedAt: parsed.artifactDeletedAt,
      id: parsed.artifactId,
      name: parsed.artifactName,
      ownerPrincipalId: parsed.ownerPrincipalId,
      tags: this.#readTags(parsed.artifactId),
    };
    const version: VersionRecord = {
      artifactId: parsed.artifactId,
      contentToken: parsed.contentToken,
      createdAt: parsed.versionCreatedAt,
      entryPath: parsed.entryPath,
      id: parsed.versionId,
      manifestDigest: parsed.manifestDigest,
      number: parsed.versionNumber,
      publisherPrincipalId: parsed.publisherPrincipalId,
      routingMode: parsed.routingMode,
    };
    return {artifact, replayed, version};
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}

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
