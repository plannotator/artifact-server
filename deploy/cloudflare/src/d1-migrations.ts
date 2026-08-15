import {
  defaultProjectId,
  defaultProjectName,
} from "../../../src/core/model.js";

/** D1 schema revision required by the Cloudflare runtime. */
export const requiredD1SchemaVersion = 1;

const schemaSql = `
  CREATE TABLE IF NOT EXISTS artifact_server_schema (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
    current_version_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    number INTEGER NOT NULL CHECK (number > 0),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
    content_token TEXT NOT NULL UNIQUE,
    publisher_principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (artifact_id, number)
  );

  CREATE TABLE IF NOT EXISTS manifest_entries (
    version_id TEXT NOT NULL REFERENCES versions(id),
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
    PRIMARY KEY (version_id, path)
  );

  CREATE TABLE IF NOT EXISTS artifact_tags (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (artifact_id, tag)
  );

  CREATE TABLE IF NOT EXISTS idempotency_records (
    project_id TEXT NOT NULL REFERENCES projects(id),
    idempotency_key TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    operation TEXT NOT NULL CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
    access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
    tags_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
    principal_id TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staged_uploads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    principal_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    committed_version_id TEXT REFERENCES versions(id)
  );

  CREATE TABLE IF NOT EXISTS staged_upload_files (
    upload_id TEXT NOT NULL REFERENCES staged_uploads(id),
    storage_token TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
    uploaded_at TEXT,
    PRIMARY KEY (upload_id, storage_token),
    UNIQUE (upload_id, path)
  );

  CREATE TABLE IF NOT EXISTS content_bootstraps (
    token_digest TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    content_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_session_digest TEXT
  );

  CREATE TABLE IF NOT EXISTS content_sessions (
    token_digest TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    content_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS installation_members (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (installation_id, email)
  );

  CREATE TABLE IF NOT EXISTS external_identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES installation_members(id),
    email TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject),
    UNIQUE (provider, member_id)
  );

  CREATE TABLE IF NOT EXISTS application_sessions (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES installation_members(id),
    token_digest TEXT NOT NULL UNIQUE,
    csrf_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS managed_api_keys (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
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
    rotated_from_id TEXT REFERENCES managed_api_keys(id),
    UNIQUE (installation_id, prefix)
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    state_digest TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mutation_checks (
    id TEXT PRIMARY KEY,
    succeeded INTEGER NOT NULL CHECK (succeeded = 1)
  );

  CREATE INDEX IF NOT EXISTS versions_artifact_id
    ON versions(project_id, artifact_id, number DESC);
  CREATE INDEX IF NOT EXISTS artifacts_active_created
    ON artifacts(project_id, deleted_at, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS artifacts_owner_active_created
    ON artifacts(project_id, owner_principal_id, deleted_at, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS artifact_tags_tag_artifact
    ON artifact_tags(tag, artifact_id);
  CREATE INDEX IF NOT EXISTS actions_artifact_created
    ON actions(project_id, artifact_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS manifest_entries_sha256
    ON manifest_entries(sha256);
  CREATE INDEX IF NOT EXISTS staged_uploads_expiry
    ON staged_uploads(status, expires_at);
  CREATE INDEX IF NOT EXISTS content_bootstraps_expiry
    ON content_bootstraps(expires_at);
  CREATE INDEX IF NOT EXISTS content_sessions_expiry
    ON content_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS application_sessions_member_idx
    ON application_sessions(installation_id, member_id);
`;

/** Create or verify the Cloudflare D1 schema and installation default project. */
export async function migrateD1(
  database: D1Database,
  installationId: string,
): Promise<void> {
  const statements = schemaSql.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "")
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
  const current = await database.prepare(`
    SELECT version FROM artifact_server_schema WHERE component = 'runtime'
  `).first<number>("version");
  if (current !== null && current > requiredD1SchemaVersion) {
    throw new Error(
      `D1 schema ${current} is newer than supported revision ${requiredD1SchemaVersion}.`,
    );
  }
  await database.batch([
    database.prepare(`
      INSERT INTO artifact_server_schema (component, version)
      VALUES ('runtime', ?)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version
      WHERE artifact_server_schema.version <= excluded.version
    `).bind(requiredD1SchemaVersion),
    database.prepare(`
      INSERT INTO projects (id, installation_id, name, created_at, archived_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      defaultProjectId,
      installationId,
      defaultProjectName,
      new Date(0).toISOString(),
    ),
  ]);
}
