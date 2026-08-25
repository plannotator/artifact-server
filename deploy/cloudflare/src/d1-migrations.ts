import {
  defaultProjectId,
  defaultProjectName,
} from "../../../src/core/model.js";
import {normalizeArtifactSearchText} from
  "../../../src/application/artifact-tags.js";
import {defaultGitHistoryMaximumCopiedFiles} from
  "../../../src/git-history/git-history-capability.js";

/** D1 schema revision required by the Cloudflare runtime. */
export const requiredD1SchemaVersion = 9;

/** SQL literal list of every action kind the ledger accepts. */
const actionKindList = [
  "'publish'",
  "'restore'",
  "'change_access'",
  "'change_tags'",
  "'delete'",
  "'comment_create'",
  "'comment_reply'",
  "'comment_update'",
  "'comment_resolve'",
  "'comment_reopen'",
  "'comment_delete'",
].join(", ");

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
    search_name TEXT NOT NULL,
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
    routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
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
    action TEXT NOT NULL CHECK (action IN (${actionKindList})),
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
    routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
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

  CREATE TABLE IF NOT EXISTS git_history_provider_identity (
    installation_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider = 'cloudflare-artifacts'),
    account_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    UNIQUE (provider, account_id, namespace)
  );

  CREATE TABLE IF NOT EXISTS git_history_project_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    installation_id TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    file_copy_limit_bytes INTEGER NOT NULL DEFAULT 10485760,
    version_copy_limit_bytes INTEGER NOT NULL DEFAULT 52428800,
    maximum_copied_files INTEGER NOT NULL DEFAULT ${defaultGitHistoryMaximumCopiedFiles},
    storage_budget_bytes INTEGER,
    updated_by_principal_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_history_repositories (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    provider TEXT NOT NULL CHECK (provider = 'cloudflare-artifacts'),
    repository_name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    default_branch TEXT NOT NULL CHECK (default_branch = 'main'),
    status TEXT NOT NULL CHECK (status IN ('provisioned', 'deleting', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (installation_id, repository_name)
  );

  CREATE TABLE IF NOT EXISTS git_history_jobs (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT REFERENCES versions(id),
    kind TEXT NOT NULL CHECK (kind IN ('mirror-version', 'delete-repository')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    file_copy_limit_bytes INTEGER,
    version_copy_limit_bytes INTEGER,
    maximum_copied_files INTEGER,
    storage_budget_bytes INTEGER,
    copy_policy_digest TEXT,
    lease_expires_at TEXT,
    available_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (kind = 'mirror-version' AND version_id IS NOT NULL
        AND file_copy_limit_bytes IS NOT NULL
        AND version_copy_limit_bytes IS NOT NULL
        AND maximum_copied_files IS NOT NULL
        AND copy_policy_digest IS NOT NULL)
      OR (kind = 'delete-repository' AND version_id IS NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS git_history_mappings (
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    repository_name TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    copied_bytes INTEGER NOT NULL CHECK (copied_bytes >= 0),
    status TEXT NOT NULL CHECK (status IN ('recorded', 'deleted')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, project_id, artifact_id, version_id)
  );

  CREATE TABLE IF NOT EXISTS git_history_budget_reservations (
    job_id TEXT PRIMARY KEY REFERENCES git_history_jobs(id),
    installation_id TEXT NOT NULL,
    logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS git_history_jobs_ready
    ON git_history_jobs (installation_id, state, available_at, created_at);

  CREATE INDEX IF NOT EXISTS git_history_jobs_artifact
    ON git_history_jobs (installation_id, artifact_id, state);

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
    nonce TEXT,
    return_to TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mutation_checks (
    id TEXT PRIMARY KEY,
    succeeded INTEGER NOT NULL CHECK (succeeded = 1)
  );

  CREATE TABLE IF NOT EXISTS registered_agents (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    connection_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    agent_session_id TEXT,
    principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    capabilities_json TEXT,
    activity_state TEXT,
    activity_at TEXT,
    UNIQUE (installation_id, principal_id, connection_key)
  );

  CREATE TABLE IF NOT EXISTS agent_dispatches (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_id TEXT NOT NULL,
    agent_display_name TEXT NOT NULL,
    thread_ids_json TEXT NOT NULL,
    note TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('queued', 'claimed', 'delivered', 'addressed', 'failed', 'canceled')
    ),
    sender_principal_id TEXT NOT NULL,
    sender_principal_kind TEXT NOT NULL CHECK (sender_principal_kind IN ('human', 'service')),
    sender_display_name TEXT NOT NULL,
    sender_authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    claimed_at TEXT,
    lease_expires_at TEXT,
    delivered_at TEXT,
    addressed_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    canceled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (installation_id, project_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS comment_threads (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    path TEXT,
    anchor_json TEXT,
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    author_principal_id TEXT NOT NULL,
    author_principal_kind TEXT NOT NULL CHECK (author_principal_kind IN ('human', 'service')),
    author_display_name TEXT NOT NULL,
    author_authorized_by_principal_id TEXT,
    resolved_at TEXT,
    resolved_by_principal_id TEXT,
    resolved_by_principal_kind TEXT CHECK (resolved_by_principal_kind IS NULL OR resolved_by_principal_kind IN ('human', 'service')),
    resolved_by_display_name TEXT,
    resolved_by_authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    dispatch_id TEXT REFERENCES agent_dispatches(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS comment_replies (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    body TEXT NOT NULL,
    author_principal_id TEXT NOT NULL,
    author_principal_kind TEXT NOT NULL CHECK (author_principal_kind IN ('human', 'service')),
    author_display_name TEXT NOT NULL,
    author_authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS versions_artifact_id
    ON versions(project_id, artifact_id, number DESC);
  CREATE INDEX IF NOT EXISTS artifacts_active_created
    ON artifacts(project_id, deleted_at, created_at DESC, id DESC);
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
  CREATE INDEX IF NOT EXISTS comment_threads_artifact_created
    ON comment_threads(artifact_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS comment_threads_version_created
    ON comment_threads(version_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS comment_threads_updated
    ON comment_threads(artifact_id, updated_at);
  CREATE INDEX IF NOT EXISTS comment_replies_thread_created
    ON comment_replies(thread_id, created_at, id);
  CREATE INDEX IF NOT EXISTS agent_dispatches_claim
    ON agent_dispatches(agent_id, state, created_at, id);
  CREATE INDEX IF NOT EXISTS agent_dispatches_project_created
    ON agent_dispatches(project_id, created_at DESC, id DESC);
`;

const upgradeFromVersion1Statements = [
  "PRAGMA defer_foreign_keys = ON",
  `CREATE TABLE versions_upgrade_snapshot AS SELECT
    id, project_id, artifact_id, number, manifest_digest, entry_path,
    routing_mode, content_token, publisher_principal_id, created_at
    FROM versions`,
  `CREATE TABLE versions_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    number INTEGER NOT NULL CHECK (number > 0),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
    content_token TEXT NOT NULL UNIQUE,
    publisher_principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (artifact_id, number)
  )`,
  "DROP TABLE versions",
  "ALTER TABLE versions_next RENAME TO versions",
  `INSERT INTO versions (
    id, project_id, artifact_id, number, manifest_digest, entry_path,
    routing_mode, content_token, publisher_principal_id, created_at
  ) SELECT id, project_id, artifact_id, number, manifest_digest, entry_path,
    routing_mode, content_token, publisher_principal_id, created_at
    FROM versions_upgrade_snapshot`,
  "DROP TABLE versions_upgrade_snapshot",
  `CREATE TABLE staged_uploads_upgrade_snapshot AS SELECT
    id, project_id, principal_id, status, manifest_digest, entry_path,
    routing_mode, created_at, expires_at, committed_version_id
    FROM staged_uploads`,
  `CREATE TABLE staged_uploads_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    principal_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    committed_version_id TEXT REFERENCES versions(id)
  )`,
  "DROP TABLE staged_uploads",
  "ALTER TABLE staged_uploads_next RENAME TO staged_uploads",
  `INSERT INTO staged_uploads (
    id, project_id, principal_id, status, manifest_digest, entry_path,
    routing_mode, created_at, expires_at, committed_version_id
  ) SELECT id, project_id, principal_id, status, manifest_digest, entry_path,
    routing_mode, created_at, expires_at, committed_version_id
    FROM staged_uploads_upgrade_snapshot`,
  "DROP TABLE staged_uploads_upgrade_snapshot",
  `CREATE TABLE idempotency_records_upgrade_snapshot AS SELECT
    project_id, idempotency_key, input_digest, artifact_id, version_id,
    operation, access_setting, tags_json, created_at
    FROM idempotency_records`,
  `CREATE TABLE idempotency_records_next (
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
  )`,
  "DROP TABLE idempotency_records",
  "ALTER TABLE idempotency_records_next RENAME TO idempotency_records",
  `INSERT INTO idempotency_records (
    project_id, idempotency_key, input_digest, artifact_id, version_id,
    operation, access_setting, tags_json, created_at
  ) SELECT project_id, idempotency_key, input_digest, artifact_id, version_id,
    operation, access_setting, tags_json, created_at
    FROM idempotency_records_upgrade_snapshot`,
  "DROP TABLE idempotency_records_upgrade_snapshot",
  `CREATE TABLE actions_upgrade_snapshot AS SELECT
    id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
    FROM actions`,
  `CREATE TABLE actions_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
    principal_id TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "DROP TABLE actions",
  "ALTER TABLE actions_next RENAME TO actions",
  `INSERT INTO actions (
    id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
  ) SELECT id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
    FROM actions_upgrade_snapshot`,
  "DROP TABLE actions_upgrade_snapshot",
  `CREATE INDEX versions_artifact_id
    ON versions(project_id, artifact_id, number DESC)`,
  `CREATE INDEX actions_artifact_created
    ON actions(project_id, artifact_id, created_at DESC, id DESC)`,
  `CREATE INDEX staged_uploads_expiry
    ON staged_uploads(status, expires_at)`,
] as const;

const upgradeFromVersion2Statements = [
  "PRAGMA defer_foreign_keys = ON",
  `CREATE TABLE actions_upgrade_snapshot AS SELECT
    id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
    FROM actions`,
  `CREATE TABLE actions_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    action TEXT NOT NULL CHECK (action IN (${actionKindList})),
    principal_id TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "DROP TABLE actions",
  "ALTER TABLE actions_next RENAME TO actions",
  `INSERT INTO actions (
    id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
  ) SELECT id, project_id, artifact_id, version_id, action, principal_id,
    authorized_by_principal_id, idempotency_key, created_at
    FROM actions_upgrade_snapshot`,
  "DROP TABLE actions_upgrade_snapshot",
  `CREATE INDEX actions_artifact_created
    ON actions(project_id, artifact_id, created_at DESC, id DESC)`,
] as const;

const upgradeFromVersion3Statements = [
  "ALTER TABLE login_attempts ADD COLUMN nonce TEXT",
] as const;

const upgradeFromVersion4Statements = [
  "ALTER TABLE comment_threads ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id)",
] as const;

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
  if (current === 1) {
    await database.batch(
      upgradeFromVersion1Statements.map((statement) =>
        database.prepare(statement)),
    );
  }
  if (current === 1 || current === 2) {
    await database.batch(
      upgradeFromVersion2Statements.map((statement) =>
        database.prepare(statement)),
    );
  }
  if (current === 1 || current === 2 || current === 3) {
    await addLoginAttemptNonceIfMissing(database);
  }
  if (current === null || current < requiredD1SchemaVersion) {
    await addCommentThreadDispatchMarkerIfMissing(database);
    await addGitHistoryMirrorColumnsIfMissing(database);
    await widenRegisteredAgentsIfNeeded(database);
    await addArtifactSearchNameIfMissing(database);
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

async function addArtifactSearchNameIfMissing(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(artifacts)")
    .all<{name: string}>();
  if (!columns.results.some((column) => column.name === "search_name")) {
    await database.prepare(
      "ALTER TABLE artifacts ADD COLUMN search_name TEXT",
    ).run();
  }
  const artifacts = await database.prepare(
    "SELECT id, name FROM artifacts WHERE search_name IS NULL",
  )
    .all<{id: string; name: string}>();
  if (artifacts.results.length === 0) return;
  await database.batch(artifacts.results.map((artifact) =>
    database.prepare("UPDATE artifacts SET search_name = ? WHERE id = ?").bind(
      normalizeArtifactSearchText(artifact.name),
      artifact.id,
    )
  ));
}

async function addGitHistoryMirrorColumnsIfMissing(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare(
    "PRAGMA table_info(git_history_project_settings)",
  ).all<{readonly name: string}>();
  const names = new Set(columns.results.map((column) => column.name));
  const statements: D1PreparedStatement[] = [];
  if (!names.has("file_copy_limit_bytes")) {
    statements.push(database.prepare(
      "ALTER TABLE git_history_project_settings ADD COLUMN file_copy_limit_bytes INTEGER NOT NULL DEFAULT 10485760",
    ));
  }
  if (!names.has("version_copy_limit_bytes")) {
    statements.push(database.prepare(
      "ALTER TABLE git_history_project_settings ADD COLUMN version_copy_limit_bytes INTEGER NOT NULL DEFAULT 52428800",
    ));
  }
  if (!names.has("maximum_copied_files")) {
    statements.push(database.prepare(
      `ALTER TABLE git_history_project_settings
        ADD COLUMN maximum_copied_files INTEGER NOT NULL
        DEFAULT ${defaultGitHistoryMaximumCopiedFiles}`,
    ));
  }
  if (!names.has("storage_budget_bytes")) {
    statements.push(database.prepare(
      "ALTER TABLE git_history_project_settings ADD COLUMN storage_budget_bytes INTEGER",
    ));
  }
  if (statements.length > 0) await database.batch(statements);
}

/**
 * Add the dispatch back-marker to `comment_threads`. The column and its index
 * cannot live in the shared schema statements: a database created before this
 * revision already holds the table, so `CREATE TABLE IF NOT EXISTS` leaves the
 * column absent and an index over it would fail the whole schema batch.
 */
async function addCommentThreadDispatchMarkerIfMissing(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(comment_threads)")
    .all<{name: string}>();
  if (!columns.results.some((column) => column.name === "dispatch_id")) {
    await database.batch(
      upgradeFromVersion4Statements.map((statement) =>
        database.prepare(statement)),
    );
  }
  await database.prepare(`
    CREATE INDEX IF NOT EXISTS comment_threads_dispatch
      ON comment_threads(dispatch_id)
  `).run();
}

async function addLoginAttemptNonceIfMissing(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(login_attempts)")
    .all<{name: string}>();
  if (columns.results.some((column) => column.name === "nonce")) return;
  await database.batch(
    upgradeFromVersion3Statements.map((statement) =>
      database.prepare(statement)),
  );
}

const widenRegisteredAgentsStatements = [
  `CREATE TABLE registered_agents_next (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    connection_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    agent_session_id TEXT,
    principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    capabilities_json TEXT,
    activity_state TEXT,
    activity_at TEXT,
    UNIQUE (installation_id, principal_id, connection_key)
  )`,
  `INSERT INTO registered_agents_next (
    id, installation_id, connection_key, display_name, kind,
    working_directory, agent_session_id, principal_id, created_at,
    last_seen_at
  ) SELECT id, installation_id, connection_key, display_name, kind,
    working_directory, agent_session_id, principal_id, created_at,
    last_seen_at
    FROM registered_agents`,
  "DROP TABLE registered_agents",
  "ALTER TABLE registered_agents_next RENAME TO registered_agents",
] as const;

/**
 * Rebuild `registered_agents` without the closed-set kind CHECK and with the
 * capability and activity columns. The kind is validated as a slug in the
 * application layer, so the schema stops constraining it. A rebuild is the
 * only path: SQLite cannot drop a CHECK constraint in place, and a database
 * created before this revision already holds the narrow table, so the shared
 * `CREATE TABLE IF NOT EXISTS` leaves it untouched.
 */
async function widenRegisteredAgentsIfNeeded(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(registered_agents)")
    .all<{name: string}>();
  if (columns.results.some((column) => column.name === "capabilities_json")) {
    return;
  }
  await database.batch(
    widenRegisteredAgentsStatements.map((statement) =>
      database.prepare(statement)),
  );
}
