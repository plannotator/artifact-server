import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  ArtifactNotFound,
  IdempotencyConflict,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
} from "../core/errors.js";
import {
  accessSettings,
  fileDispositions,
  routingModes,
  uploadStatuses,
  type ArtifactRecord,
  type ManifestEntry,
  type PublishedVersion,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactRepository,
  CommitArtifactVersion,
  CommitNewArtifact,
  CreateStagedUpload,
  PublicationSource,
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
const publishedRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactCreatedAt: z.string(),
  artifactId: z.string(),
  artifactName: z.string(),
  contentToken: z.string(),
  currentVersionId: z.string(),
  manifestDigest: z.string(),
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
});
const idempotencyRowSchema = z.object({
  inputDigest: z.string(),
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

export class SqliteArtifactRepository implements ArtifactRepository, StagedUploadRepository {
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
              id, name, access_setting, current_version_id, created_at, deleted_at
            ) VALUES (?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            command.artifactId,
            command.name,
            command.accessSetting,
            command.createdAt,
          );

        this.#insertVersion(
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          1,
          command.manifest,
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

  #findIdempotentResult(
    idempotencyKey: string,
    inputDigest: string,
  ): PublishedVersion | null {
    const row = this.#database
      .prepare(
        `SELECT input_digest AS inputDigest, version_id AS versionId
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest) {
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
    action: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actions (
          id, artifact_id, version_id, action, principal_id, idempotency_key, created_at
        ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'local-api-token', ?, ?)`,
      )
      .run(artifactId, versionId, action, idempotencyKey, createdAt);
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
  ): void {
    this.#database
      .prepare(
        `INSERT INTO idempotency_records (
          idempotency_key, input_digest, artifact_id, version_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(idempotencyKey, inputDigest, artifactId, versionId, createdAt);
  }

  #insertVersion(
    artifactId: string,
    versionId: string,
    contentToken: string,
    createdAt: string,
    number: number,
    manifest: CommitNewArtifact["manifest"],
  ): void {
    this.#database
      .prepare(
        `INSERT INTO versions (
          id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        artifactId,
        number,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        contentToken,
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

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS versions_artifact_id
        ON versions (artifact_id, number);
      CREATE INDEX IF NOT EXISTS manifest_entries_sha256
        ON manifest_entries (sha256);
      CREATE INDEX IF NOT EXISTS staged_uploads_expiry
        ON staged_uploads (status, expires_at);
    `);
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
          a.access_setting AS accessSetting,
          a.current_version_id AS currentVersionId,
          a.created_at AS artifactCreatedAt,
          v.id AS versionId,
          v.number AS versionNumber,
          v.manifest_digest AS manifestDigest,
          v.content_token AS contentToken,
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
      id: parsed.artifactId,
      name: parsed.artifactName,
    };
    const version: VersionRecord = {
      artifactId: parsed.artifactId,
      contentToken: parsed.contentToken,
      createdAt: parsed.versionCreatedAt,
      id: parsed.versionId,
      manifestDigest: parsed.manifestDigest,
      number: parsed.versionNumber,
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
