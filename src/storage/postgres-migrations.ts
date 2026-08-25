import {Effect} from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {normalizeArtifactSearchText} from "../application/artifact-tags.js";
import {defaultGitHistoryMaximumCopiedFiles} from
  "../git-history/git-history-capability.js";

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

const addProjectScope = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `CREATE TABLE projects (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (installation_id, id)
    )`,
    `INSERT INTO projects (installation_id, id, name, created_at, archived_at)
      SELECT installation.id, 'prj_default', 'Default',
        COALESCE(MIN(artifact.created_at), installation.created_at), NULL
      FROM artifact_installations installation
      LEFT JOIN artifacts artifact
        ON artifact.installation_id = installation.id
      GROUP BY installation.id, installation.created_at`,
    `ALTER TABLE artifacts ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE versions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE idempotency_records ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE actions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE staged_uploads ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE content_bootstraps ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE content_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'prj_default'`,
    `ALTER TABLE artifacts ADD CONSTRAINT artifacts_project_fk
      FOREIGN KEY (installation_id, project_id)
      REFERENCES projects(installation_id, id)`,
    `ALTER TABLE versions ADD CONSTRAINT versions_project_fk
      FOREIGN KEY (installation_id, project_id)
      REFERENCES projects(installation_id, id)`,
    `ALTER TABLE staged_uploads ADD CONSTRAINT staged_uploads_project_fk
      FOREIGN KEY (installation_id, project_id)
      REFERENCES projects(installation_id, id)`,
    `ALTER TABLE artifacts ADD CONSTRAINT artifacts_project_identity
      UNIQUE (installation_id, project_id, id)`,
    `ALTER TABLE versions ADD CONSTRAINT versions_project_identity
      UNIQUE (installation_id, project_id, id)`,
    `ALTER TABLE versions ADD CONSTRAINT versions_project_artifact_version_identity
      UNIQUE (installation_id, project_id, artifact_id, id)`,
    `ALTER TABLE versions ADD CONSTRAINT versions_project_artifact_fk
      FOREIGN KEY (installation_id, project_id, artifact_id)
      REFERENCES artifacts(installation_id, project_id, id)`,
    `ALTER TABLE artifacts DROP CONSTRAINT artifacts_current_version_fk`,
    `ALTER TABLE artifacts ADD CONSTRAINT artifacts_current_version_fk
      FOREIGN KEY (installation_id, project_id, id, current_version_id)
      REFERENCES versions(installation_id, project_id, artifact_id, id)
      DEFERRABLE INITIALLY DEFERRED`,
    `ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_project_artifact_fk
      FOREIGN KEY (installation_id, project_id, artifact_id)
      REFERENCES artifacts(installation_id, project_id, id)`,
    `ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_project_version_fk
      FOREIGN KEY (installation_id, project_id, version_id)
      REFERENCES versions(installation_id, project_id, id)`,
    `ALTER TABLE actions ADD CONSTRAINT actions_project_artifact_fk
      FOREIGN KEY (installation_id, project_id, artifact_id)
      REFERENCES artifacts(installation_id, project_id, id)`,
    `ALTER TABLE actions ADD CONSTRAINT actions_project_version_fk
      FOREIGN KEY (installation_id, project_id, version_id)
      REFERENCES versions(installation_id, project_id, id)`,
    `ALTER TABLE staged_uploads ADD CONSTRAINT staged_uploads_project_version_fk
      FOREIGN KEY (installation_id, project_id, committed_version_id)
      REFERENCES versions(installation_id, project_id, id)`,
    `ALTER TABLE content_bootstraps ADD CONSTRAINT content_bootstraps_project_artifact_fk
      FOREIGN KEY (installation_id, project_id, artifact_id)
      REFERENCES artifacts(installation_id, project_id, id)`,
    `ALTER TABLE content_bootstraps ADD CONSTRAINT content_bootstraps_project_version_fk
      FOREIGN KEY (installation_id, project_id, version_id)
      REFERENCES versions(installation_id, project_id, id)`,
    `ALTER TABLE content_sessions ADD CONSTRAINT content_sessions_project_artifact_fk
      FOREIGN KEY (installation_id, project_id, artifact_id)
      REFERENCES artifacts(installation_id, project_id, id)`,
    `ALTER TABLE content_sessions ADD CONSTRAINT content_sessions_project_version_fk
      FOREIGN KEY (installation_id, project_id, version_id)
      REFERENCES versions(installation_id, project_id, id)`,
    `ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_pkey`,
    `ALTER TABLE idempotency_records ADD PRIMARY KEY (
      installation_id, project_id, idempotency_key
    )`,
    `ALTER TABLE actions DROP CONSTRAINT actions_installation_id_idempotency_key_key`,
    `ALTER TABLE actions ADD CONSTRAINT actions_project_idempotency_key
      UNIQUE (installation_id, project_id, idempotency_key)`,
    "DROP INDEX versions_artifact_id",
    "DROP INDEX artifacts_active_created",
    "DROP INDEX actions_artifact_created",
    "CREATE INDEX versions_project_artifact_id ON versions (installation_id, project_id, artifact_id, number)",
    "CREATE INDEX artifacts_project_active_created ON artifacts (installation_id, project_id, deleted_at, created_at DESC, id DESC)",
    "CREATE INDEX actions_project_artifact_created ON actions (installation_id, project_id, artifact_id, created_at DESC, id DESC)",
  ] as const;

  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});

const addSpaRouting = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`ALTER TABLE versions
    DROP CONSTRAINT versions_routing_mode_check,
    ADD CONSTRAINT versions_routing_mode_check
      CHECK (routing_mode IN ('static', 'spa'))`);
  yield* sql.unsafe(`ALTER TABLE staged_uploads
    DROP CONSTRAINT staged_uploads_routing_mode_check,
    ADD CONSTRAINT staged_uploads_routing_mode_check
      CHECK (routing_mode IN ('static', 'spa'))`);
});

const addCommentThreads = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `CREATE TABLE comment_threads (
      installation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      path TEXT,
      anchor_json TEXT,
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
      author_principal_id TEXT NOT NULL,
      author_principal_kind TEXT NOT NULL
        CHECK (author_principal_kind IN ('human', 'service')),
      author_display_name TEXT NOT NULL,
      author_authorized_by_principal_id TEXT,
      resolved_at TEXT,
      resolved_by_principal_id TEXT,
      resolved_by_principal_kind TEXT
        CHECK (
          resolved_by_principal_kind IS NULL
          OR resolved_by_principal_kind IN ('human', 'service')
        ),
      resolved_by_display_name TEXT,
      resolved_by_authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, project_id, id),
      UNIQUE (installation_id, project_id, idempotency_key),
      FOREIGN KEY (installation_id, project_id, artifact_id)
        REFERENCES artifacts(installation_id, project_id, id),
      FOREIGN KEY (installation_id, project_id, version_id)
        REFERENCES versions(installation_id, project_id, id)
    )`,
    `CREATE TABLE comment_replies (
      installation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      body TEXT NOT NULL,
      author_principal_id TEXT NOT NULL,
      author_principal_kind TEXT NOT NULL
        CHECK (author_principal_kind IN ('human', 'service')),
      author_display_name TEXT NOT NULL,
      author_authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, project_id, idempotency_key),
      FOREIGN KEY (installation_id, project_id, thread_id)
        REFERENCES comment_threads(installation_id, project_id, id)
        ON DELETE CASCADE
    )`,
    `ALTER TABLE actions
      DROP CONSTRAINT actions_action_check,
      ADD CONSTRAINT actions_action_check
        CHECK (action IN (
          'publish', 'restore', 'change_access', 'change_tags', 'delete',
          'comment_create', 'comment_reply', 'comment_update',
          'comment_resolve', 'comment_reopen', 'comment_delete'
        ))`,
    `CREATE INDEX comment_threads_artifact_created
      ON comment_threads (installation_id, project_id, artifact_id, created_at DESC, id DESC)`,
    `CREATE INDEX comment_threads_version_created
      ON comment_threads (installation_id, project_id, version_id, created_at DESC, id DESC)`,
    `CREATE INDEX comment_threads_updated
      ON comment_threads (installation_id, project_id, artifact_id, updated_at)`,
    `CREATE INDEX comment_replies_thread_created
      ON comment_replies (installation_id, thread_id, created_at, id)`,
  ] as const;

  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});

const addLoginAttemptNonce = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe("ALTER TABLE login_attempts ADD COLUMN nonce TEXT");
});

const addAgentDispatch = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `CREATE TABLE registered_agents (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      connection_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pi')),
      working_directory TEXT NOT NULL,
      agent_session_id TEXT,
      principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, principal_id, connection_key)
    )`,
    `CREATE TABLE agent_dispatches (
      installation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_display_name TEXT NOT NULL,
      thread_ids_json TEXT NOT NULL,
      note TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'claimed', 'delivered', 'addressed', 'failed', 'canceled'
      )),
      sender_principal_id TEXT NOT NULL,
      sender_principal_kind TEXT NOT NULL
        CHECK (sender_principal_kind IN ('human', 'service')),
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
      PRIMARY KEY (installation_id, id),
      UNIQUE (installation_id, project_id, id),
      UNIQUE (installation_id, project_id, idempotency_key),
      FOREIGN KEY (installation_id, project_id)
        REFERENCES projects(installation_id, id)
    )`,
    `ALTER TABLE comment_threads ADD COLUMN dispatch_id TEXT`,
    `ALTER TABLE comment_threads ADD CONSTRAINT comment_threads_dispatch_fk
      FOREIGN KEY (installation_id, dispatch_id)
      REFERENCES agent_dispatches(installation_id, id)`,
    `CREATE INDEX agent_dispatches_claim
      ON agent_dispatches (installation_id, agent_id, state, created_at, id)`,
    `CREATE INDEX agent_dispatches_project_created
      ON agent_dispatches (installation_id, project_id, created_at DESC, id DESC)`,
    `CREATE INDEX comment_threads_dispatch
      ON comment_threads (installation_id, dispatch_id)`,
  ] as const;

  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});

const addGitHistoryProviderIdentity = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`CREATE TABLE git_history_provider_identity (
    installation_id TEXT PRIMARY KEY REFERENCES artifact_installations(id),
    provider TEXT NOT NULL CHECK (provider = 'cloudflare-artifacts'),
    account_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    UNIQUE (provider, account_id, namespace)
  )`);
});

const addProjectGitHistorySetting = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`CREATE TABLE git_history_project_settings (
    installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
    project_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    updated_by_principal_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, project_id),
    FOREIGN KEY (installation_id, project_id)
      REFERENCES projects(installation_id, id)
  )`);
});

const addGitHistoryMirror = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `ALTER TABLE git_history_project_settings
      ADD COLUMN file_copy_limit_bytes BIGINT NOT NULL DEFAULT 10485760,
      ADD COLUMN version_copy_limit_bytes BIGINT NOT NULL DEFAULT 52428800,
      ADD COLUMN maximum_copied_files INTEGER NOT NULL
        DEFAULT ${defaultGitHistoryMaximumCopiedFiles},
      ADD COLUMN storage_budget_bytes BIGINT`,
    `CREATE TABLE git_history_repositories (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      project_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider = 'cloudflare-artifacts'),
      repository_name TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      default_branch TEXT NOT NULL CHECK (default_branch = 'main'),
      status TEXT NOT NULL CHECK (status IN ('provisioned', 'deleting', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, artifact_id),
      UNIQUE (installation_id, repository_name),
      FOREIGN KEY (installation_id, project_id, artifact_id)
        REFERENCES artifacts(installation_id, project_id, id)
    )`,
    `CREATE TABLE git_history_jobs (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('mirror-version', 'delete-repository')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      file_copy_limit_bytes BIGINT,
      version_copy_limit_bytes BIGINT,
      maximum_copied_files INTEGER,
      storage_budget_bytes BIGINT,
      copy_policy_digest TEXT,
      lease_expires_at TEXT,
      available_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, id),
      FOREIGN KEY (installation_id, project_id, artifact_id)
        REFERENCES artifacts(installation_id, project_id, id),
      CHECK (
        (kind = 'mirror-version' AND version_id IS NOT NULL
          AND file_copy_limit_bytes IS NOT NULL
          AND version_copy_limit_bytes IS NOT NULL
          AND maximum_copied_files IS NOT NULL
          AND copy_policy_digest IS NOT NULL)
        OR (kind = 'delete-repository' AND version_id IS NULL)
      )
    )`,
    `CREATE TABLE git_history_mappings (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      project_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      attempts INTEGER NOT NULL CHECK (attempts > 0),
      copied_bytes BIGINT NOT NULL CHECK (copied_bytes >= 0),
      status TEXT NOT NULL CHECK (status IN ('recorded', 'deleted')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, project_id, artifact_id, version_id)
    )`,
    `CREATE TABLE git_history_budget_reservations (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      job_id TEXT NOT NULL,
      logical_bytes BIGINT NOT NULL CHECK (logical_bytes >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, job_id),
      FOREIGN KEY (installation_id, job_id)
        REFERENCES git_history_jobs(installation_id, id)
    )`,
    `CREATE INDEX git_history_jobs_ready
      ON git_history_jobs (installation_id, state, available_at, created_at)`,
    `CREATE INDEX git_history_jobs_artifact
      ON git_history_jobs (installation_id, artifact_id, state)`,
  ] as const;
  for (const statement of statements) yield* sql.unsafe(statement);
});

const widenRegisteredAgentKind = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    // The kind becomes an open slug validated in the application layer, so
    // the closed-set CHECK constraint stops describing the contract.
    `ALTER TABLE registered_agents
      DROP CONSTRAINT registered_agents_kind_check`,
    `ALTER TABLE registered_agents
      ADD COLUMN capabilities_json TEXT,
      ADD COLUMN activity_state TEXT,
      ADD COLUMN activity_at TEXT`,
  ] as const;
  for (const statement of statements) yield* sql.unsafe(statement);
});

const addArtifactSearchName = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe("ALTER TABLE artifacts ADD COLUMN search_name TEXT");
  const rows = yield* sql.unsafe<{
    readonly id: string;
    readonly installationId: string;
    readonly name: string;
  }>(`SELECT installation_id AS "installationId", id, name FROM artifacts`);
  for (const row of rows) {
    yield* sql.unsafe(
      `UPDATE artifacts SET search_name = $1
       WHERE installation_id = $2 AND id = $3`,
      [normalizeArtifactSearchText(row.name), row.installationId, row.id],
    );
  }
  yield* sql.unsafe(
    "ALTER TABLE artifacts ALTER COLUMN search_name SET NOT NULL",
  );
});

const migrationLoader = Migrator.fromRecord({
  "0001_initial_shared_schema": initialSchema,
  "0002_project_scoped_artifacts": addProjectScope,
  "0003_spa_routing": addSpaRouting,
  "0004_comment_threads": addCommentThreads,
  "0005_login_attempt_nonce": addLoginAttemptNonce,
  "0006_agent_dispatch": addAgentDispatch,
  "0007_git_history_provider_identity": addGitHistoryProviderIdentity,
  "0008_project_git_history_setting": addProjectGitHistorySetting,
  "0009_git_history_mirror": addGitHistoryMirror,
  "0010_agent_capabilities": widenRegisteredAgentKind,
  "0011_artifact_search_name": addArtifactSearchName,
});

/** Schema revision required by this Artifact Server build. */
export const requiredPostgresSchemaVersion = 11;

/** Migration compatibility observed without changing Postgres. */
export interface PostgresMigrationStatus {
  readonly compatibility: "current" | "divergent" | "missing" | "newer" | "pending";
  readonly currentVersion: number;
  readonly requiredVersion: number;
}

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

/** Inspect the migration table without creating it or applying work. */
export const readPostgresMigrationStatus = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const presentRows = yield* sql<{readonly present: boolean}>`
    SELECT to_regclass('public.artifact_server_postgres_migrations') IS NOT NULL AS present
  `.withoutTransform;
  const present = presentRows[0]?.present === true;
  if (!present) {
    return {
      compatibility: "missing",
      currentVersion: 0,
      requiredVersion: requiredPostgresSchemaVersion,
    } satisfies PostgresMigrationStatus;
  }
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name
    FROM artifact_server_postgres_migrations
    ORDER BY migration_id
  `.withoutTransform;
  const currentVersion = rows.at(-1)?.migration_id ?? 0;
  const expectedHistory = [{
    migration_id: 1,
    name: "initial_shared_schema",
  }, {
    migration_id: 2,
    name: "project_scoped_artifacts",
  }, {
    migration_id: 3,
    name: "spa_routing",
  }, {
    migration_id: 4,
    name: "comment_threads",
  }, {
    migration_id: 5,
    name: "login_attempt_nonce",
  }, {
    migration_id: 6,
    name: "agent_dispatch",
  }, {
    migration_id: 7,
    name: "git_history_provider_identity",
  }, {
    migration_id: 8,
    name: "project_git_history_setting",
  }, {
    migration_id: 9,
    name: "git_history_mirror",
  }, {
    migration_id: 10,
    name: "agent_capabilities",
  }, {
    migration_id: 11,
    name: "artifact_search_name",
  }] as const;
  const observedRequiredHistory = rows.filter(
    (row) => row.migration_id <= requiredPostgresSchemaVersion,
  );
  const historyMatches = observedRequiredHistory.length === expectedHistory.length &&
    observedRequiredHistory.every((row, index) => {
      const expected = expectedHistory[index];
      return expected !== undefined &&
        row.migration_id === expected.migration_id && row.name === expected.name;
    });
  const compatibility = currentVersion > requiredPostgresSchemaVersion
    ? "newer" as const
    : currentVersion < requiredPostgresSchemaVersion
    ? "pending" as const
    : historyMatches
    ? "current" as const
    : "divergent" as const;
  return {
    compatibility,
    currentVersion,
    requiredVersion: requiredPostgresSchemaVersion,
  } satisfies PostgresMigrationStatus;
});
