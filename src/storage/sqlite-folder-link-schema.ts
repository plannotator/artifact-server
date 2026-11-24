import type {DatabaseSync} from "node:sqlite";

/**
 * Schema revision introduced by linked folders (ADR 0031). It is one
 * self-contained step so it can be renumbered when it is merged after other
 * schema steps; it assumes only the phase-one folder tables (revision 13).
 */
export const folderLinkSchemaVersion = 15;

/** Install the local-only folder-link, inventory, capture, and live-grant tables. */
export function migrateSqliteFolderLinks(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE folder_links (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      folder_id TEXT NOT NULL REFERENCES folders(id),
      path TEXT NOT NULL,
      root_device TEXT NOT NULL,
      ignore_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'unavailable', 'over-limit')),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      over_limit_reason TEXT CHECK (over_limit_reason IS NULL OR over_limit_reason IN ('entries', 'ignore-file')),
      scan_generation INTEGER NOT NULL DEFAULT 0,
      last_scan_started_at TEXT,
      last_scan_completed_at TEXT,
      ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      UNIQUE (installation_id, path),
      UNIQUE (folder_id),
      UNIQUE (project_id, idempotency_key)
    ) STRICT;

    CREATE TABLE folder_inventory (
      id TEXT PRIMARY KEY,
      folder_link_id TEXT NOT NULL REFERENCES folder_links(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      disk_path TEXT NOT NULL,
      fingerprint TEXT,
      size INTEGER CHECK (size IS NULL OR size >= 0),
      observed_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('untracked', 'tracked', 'skipped')),
      skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN (
        'symlink', 'special', 'too-large', 'too-deep', 'unreadable',
        'hostile-name', 'other-device', 'bound-elsewhere'
      )),
      artifact_id TEXT,
      pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
      seen_generation INTEGER NOT NULL,
      UNIQUE (folder_link_id, disk_path),
      CHECK ((state = 'skipped') = (skip_reason IS NOT NULL)),
      CHECK (state <> 'tracked' OR artifact_id IS NOT NULL)
    ) STRICT;

    CREATE INDEX folder_inventory_state
      ON folder_inventory (folder_link_id, state, relative_path);
    CREATE INDEX folder_inventory_pending
      ON folder_inventory (folder_link_id, pending, relative_path);
    CREATE INDEX folder_inventory_path
      ON folder_inventory (folder_link_id, relative_path);

    CREATE TABLE folder_link_captures (
      folder_link_id TEXT NOT NULL REFERENCES folder_links(id) ON DELETE CASCADE,
      batch_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      entry_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (folder_link_id, batch_key, entry_id)
    ) STRICT;

    CREATE TABLE folder_entry_live_grants (
      token_digest TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'session')),
      principal_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      folder_link_id TEXT NOT NULL REFERENCES folder_links(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      content_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;

    CREATE INDEX folder_entry_live_grants_expiry
      ON folder_entry_live_grants (expires_at);

    CREATE INDEX artifacts_source_path
      ON artifacts (source_path) WHERE source_path IS NOT NULL;
  `);
  database.exec(`PRAGMA user_version = ${folderLinkSchemaVersion};`);
}
