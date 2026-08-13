import {Effect} from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import {SqlClient} from "effect/unstable/sql/SqlClient";

const initialSchema = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `CREATE TABLE artifact_installations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE artifacts (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (installation_id, id)
    )`,
    `CREATE TABLE versions (
      installation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      manifest_digest TEXT NOT NULL,
      entry_path TEXT NOT NULL,
      routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
      content_token TEXT NOT NULL,
      publisher_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, content_token),
      UNIQUE (installation_id, artifact_id, number),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id)
    )`,
    `ALTER TABLE artifacts ADD CONSTRAINT artifacts_current_version_fk
      FOREIGN KEY (installation_id, current_version_id)
      REFERENCES versions(installation_id, id)
      DEFERRABLE INITIALLY DEFERRED`,
    `CREATE TABLE manifest_entries (
      installation_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size BIGINT NOT NULL CHECK (size >= 0),
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
      PRIMARY KEY (installation_id, version_id, path),
      FOREIGN KEY (installation_id, version_id)
        REFERENCES versions(installation_id, id)
    )`,
    `CREATE TABLE artifact_tags (
      installation_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (installation_id, artifact_id, tag),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id)
    )`,
    `CREATE TABLE idempotency_records (
      installation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'publish'
        CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
      access_setting TEXT
        CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
      tags_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, idempotency_key),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id),
      FOREIGN KEY (installation_id, version_id)
        REFERENCES versions(installation_id, id)
    )`,
    `CREATE TABLE actions (
      installation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
      principal_id TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, idempotency_key),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id),
      FOREIGN KEY (installation_id, version_id)
        REFERENCES versions(installation_id, id)
    )`,
    `CREATE TABLE staged_uploads (
      installation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
      manifest_digest TEXT NOT NULL,
      entry_path TEXT NOT NULL,
      routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_version_id TEXT,
      PRIMARY KEY (installation_id, id),
      FOREIGN KEY (installation_id, committed_version_id)
        REFERENCES versions(installation_id, id),
      CHECK (
        (status = 'open' AND committed_version_id IS NULL)
        OR (status = 'committed' AND committed_version_id IS NOT NULL)
      )
    )`,
    `CREATE TABLE staged_upload_files (
      installation_id TEXT NOT NULL,
      upload_id TEXT NOT NULL,
      storage_token TEXT NOT NULL,
      path TEXT NOT NULL,
      size BIGINT NOT NULL CHECK (size >= 0),
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
      uploaded_at TEXT,
      PRIMARY KEY (installation_id, upload_id, path),
      UNIQUE (installation_id, storage_token),
      FOREIGN KEY (installation_id, upload_id)
        REFERENCES staged_uploads(installation_id, id)
    )`,
    `CREATE TABLE content_bootstraps (
      installation_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      content_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      PRIMARY KEY (installation_id, token_digest),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id),
      FOREIGN KEY (installation_id, version_id)
        REFERENCES versions(installation_id, id)
    )`,
    `CREATE TABLE content_sessions (
      installation_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      content_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, token_digest),
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES artifacts(installation_id, id),
      FOREIGN KEY (installation_id, version_id)
        REFERENCES versions(installation_id, id)
    )`,
    `CREATE TABLE installation_members (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, email)
    )`,
    `CREATE TABLE external_identities (
      installation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      member_id TEXT NOT NULL,
      email TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, provider, subject),
      UNIQUE (installation_id, provider, member_id),
      FOREIGN KEY (installation_id, member_id)
        REFERENCES installation_members(installation_id, id)
    )`,
    `CREATE TABLE application_sessions (
      installation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      csrf_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, token_digest),
      FOREIGN KEY (installation_id, member_id)
        REFERENCES installation_members(installation_id, id)
    )`,
    `CREATE TABLE managed_api_keys (
      installation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      secret_digest TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('human', 'service')),
      capabilities_json TEXT NOT NULL,
      authorized_by_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_from_id TEXT,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, prefix),
      FOREIGN KEY (installation_id, rotated_from_id)
        REFERENCES managed_api_keys(installation_id, id)
    )`,
    `CREATE TABLE login_attempts (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      state_digest TEXT NOT NULL,
      provider TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      return_to TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      PRIMARY KEY (installation_id, state_digest)
    )`,
    "CREATE INDEX versions_artifact_id ON versions (installation_id, artifact_id, number)",
    "CREATE INDEX artifacts_active_created ON artifacts (installation_id, deleted_at, created_at DESC, id DESC)",
    "CREATE INDEX artifacts_owner_active_created ON artifacts (installation_id, owner_principal_id, deleted_at, created_at DESC, id DESC)",
    "CREATE INDEX artifact_tags_tag_artifact ON artifact_tags (installation_id, tag, artifact_id)",
    "CREATE INDEX actions_artifact_created ON actions (installation_id, artifact_id, created_at DESC, id DESC)",
    "CREATE INDEX manifest_entries_sha256 ON manifest_entries (installation_id, sha256)",
    "CREATE INDEX staged_uploads_expiry ON staged_uploads (installation_id, status, expires_at)",
    "CREATE INDEX content_bootstraps_expiry ON content_bootstraps (installation_id, expires_at, consumed_at)",
    "CREATE INDEX content_sessions_expiry ON content_sessions (installation_id, expires_at)",
    "CREATE INDEX application_sessions_member_idx ON application_sessions (installation_id, member_id)",
  ] as const;

  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});

const migrationLoader = Migrator.fromRecord({
  "0001_initial_shared_schema": initialSchema,
});

const migrate = Migrator.make({})({
  loader: migrationLoader,
  table: "artifact_server_postgres_migrations",
});

/** Apply provider-specific migrations under one cross-process lock. */
export const runPostgresMigrations = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended('artifact-server:migrations', 0)
      )
    `;
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS artifact_server_postgres_migrations (
      migration_id INTEGER PRIMARY KEY,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      name TEXT NOT NULL
    )`);
    yield* migrate;
  }));
});
