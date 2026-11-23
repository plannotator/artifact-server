import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {
  type ArtifactInsightFacts,
  type InsightActivityEvent,
  type InsightActivityPage,
  insightActivityKinds,
  type InsightDispatchState,
  insightDispatchStates,
  type ListInsightActivity,
  type ReadArtifactInsights,
} from "../core/insights.js";

const count = z.number().int().nonnegative();
const bytes = z.number().int().nonnegative();
const timestamp = z.string().min(1);

const projectRowSchema = z.object({
  archived: z.union([z.literal(0), z.literal(1)]),
  artifactCount: count,
  latestVersionAt: timestamp.nullable(),
  name: z.string(),
  projectId: z.string(),
  versionCount: count,
});
const catalogTotalsSchema = z.object({
  publicLinkCount: count,
  untaggedArtifactCount: count,
  versionsInWindow: count,
});
const recentArtifactSchema = z.object({
  artifactId: z.string(),
  latestVersionAt: timestamp,
  latestVersionNumber: z.number().int().positive(),
  name: z.string(),
  projectId: z.string(),
});
const tagRowSchema = z.object({artifactCount: count, tag: z.string()});
const threadTotalsSchema = z.object({
  oldestOpenThreadAt: timestamp.nullable(),
  openDispatchedThreads: count,
  openThreads: count,
  resolvedThreads: count,
  threadsOpenedInWindow: count,
  threadsResolvedInWindow: count,
});
const repliesSchema = z.object({repliesInWindow: count});
const dispatchRowSchema = z.object({
  dispatches: count,
  inWindow: count,
  state: z.enum(insightDispatchStates),
});
const openThreadArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  openThreads: count,
  projectId: z.string(),
});
const storageTotalsSchema = z.object({
  baselineBytes: bytes,
  fileCount: count,
  firstPublicationDay: z.string().nullable(),
  logicalBytes: bytes,
});
const storedSchema = z.object({distinctBlobCount: count, storedBytes: bytes});
const growthRowSchema = z.object({
  addedBytes: bytes,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  versions: count,
});
const largestArtifactSchema = z.object({
  artifactId: z.string(),
  logicalBytes: bytes,
  name: z.string(),
  projectId: z.string(),
});
const gitHistoryProjectSchema = z.object({
  budgetBytes: bytes.nullable(),
  committedBytes: bytes,
  enabled: z.union([z.literal(0), z.literal(1)]),
  projectId: z.string(),
  reservedBytes: bytes,
});
const gitHistoryJobsSchema = z.object({failingJobs: count, pendingJobs: count});
const activityRowSchema = z.object({
  actorDisplayName: z.string().nullable(),
  actorKind: z.enum(["human", "service"]).nullable(),
  actorPrincipalId: z.string().nullable(),
  artifactId: z.string().nullable(),
  artifactName: z.string().nullable(),
  id: z.string(),
  kind: z.enum(insightActivityKinds),
  occurredAt: timestamp,
  projectId: z.string(),
  versionNumber: z.number().int().positive().nullable(),
});

/**
 * The installation and project filter every insights query shares. Bound as
 * `installationId, projectId, projectId` against `project.*`.
 */
const scope = "project.installation_id = ? AND (? IS NULL OR project.id = ?)";

/**
 * Resolve a principal to a visible member name without exposing API key names.
 * Registered agents are not consulted: their principal is the identity that
 * connected them, not the agent itself.
 */
const actorColumns = (principal: string) => `
  ${principal} AS actorPrincipalId,
  (SELECT member.display_name FROM installation_members member
    WHERE member.installation_id = project.installation_id
      AND member.id = ${principal}) AS actorDisplayName,
  COALESCE(
    (SELECT 'human' FROM installation_members member
      WHERE member.installation_id = project.installation_id
        AND member.id = ${principal}),
    (SELECT key.principal_kind FROM managed_api_keys key
      WHERE key.installation_id = project.installation_id
        AND key.principal_id = ${principal}
      ORDER BY key.created_at DESC, key.id DESC LIMIT 1)
  ) AS actorKind`;

const actionKinds = `CASE action.action
  WHEN 'publish' THEN 'artifact.published'
  WHEN 'restore' THEN 'artifact.restored'
  WHEN 'delete' THEN 'artifact.deleted'
  WHEN 'capture' THEN 'artifact.captured'
  WHEN 'link' THEN 'artifact.linked'
  WHEN 'relink' THEN 'artifact.relinked'
  WHEN 'change_access' THEN 'artifact.access_changed'
  WHEN 'change_tags' THEN 'artifact.tags_changed'
  WHEN 'comment_create' THEN 'comment.opened'
  WHEN 'comment_reply' THEN 'comment.replied'
  WHEN 'comment_resolve' THEN 'comment.resolved'
  WHEN 'comment_reopen' THEN 'comment.reopened'
  WHEN 'comment_update' THEN 'comment.edited'
  WHEN 'comment_delete' THEN 'comment.deleted'
END`;

/** One dispatch transition column projected as an activity row. */
const dispatchTransition = (
  suffix: string,
  column: string,
  actor: "sender" | "agent" | "none",
) => {
  const actorSql = actor === "sender"
    ? `dispatch.sender_principal_id AS actorPrincipalId,
       dispatch.sender_display_name AS actorDisplayName,
       dispatch.sender_principal_kind AS actorKind`
    : actor === "agent"
    ? `dispatch.agent_id AS actorPrincipalId,
       dispatch.agent_display_name AS actorDisplayName,
       'service' AS actorKind`
    : `NULL AS actorPrincipalId, NULL AS actorDisplayName, NULL AS actorKind`;
  return `
    SELECT 'dispatch:' || dispatch.id || ':${suffix}' AS id,
      'dispatch.${suffix}' AS kind,
      dispatch.${column} AS occurredAt,
      dispatch.project_id AS projectId,
      NULL AS artifactId, NULL AS artifactName, NULL AS versionNumber,
      ${actorSql}
    FROM agent_dispatches dispatch
    INNER JOIN projects project ON project.id = dispatch.project_id
    WHERE ${scope} AND dispatch.installation_id = project.installation_id
      AND dispatch.${column} IS NOT NULL`;
};

/**
 * Read-only dashboard queries over the local SQLite database. It owns a
 * separate connection marked query-only, so a dashboard read can never write,
 * and it never changes the schema that the artifact repository migrates.
 */
export class SqliteArtifactInsightsStore {
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId = "local") {
    this.#installationId = installationId;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.enableDefensive(true);
    this.#database.exec("PRAGMA query_only = ON;");
  }

  close(): void {
    this.#database.close();
  }

  readInsights(command: ReadArtifactInsights): Promise<ArtifactInsightFacts> {
    return Promise.resolve().then(() => {
      // One read transaction gives every section the same snapshot.
      this.#database.exec("BEGIN");
      try {
        return this.#readInsights(command);
      } finally {
        this.#database.exec("COMMIT");
      }
    });
  }

  listActivity(command: ListInsightActivity): Promise<InsightActivityPage> {
    return Promise.resolve().then(() => {
      const scoped = [this.#installationId, command.projectId, command.projectId];
      const cursorAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = z.array(activityRowSchema).parse(this.#database.prepare(`
        SELECT * FROM (
          SELECT 'action:' || action.id AS id,
            ${actionKinds} AS kind,
            action.created_at AS occurredAt,
            action.project_id AS projectId,
            action.artifact_id AS artifactId,
            artifact.name AS artifactName,
            version.number AS versionNumber,
            ${actorColumns("action.principal_id")}
          FROM actions action
          INNER JOIN projects project ON project.id = action.project_id
          INNER JOIN artifacts artifact ON artifact.id = action.artifact_id
          INNER JOIN versions version ON version.id = action.version_id
          WHERE ${scope}
          UNION ALL ${dispatchTransition("sent", "created_at", "sender")}
          UNION ALL ${dispatchTransition("delivered", "delivered_at", "agent")}
          UNION ALL ${dispatchTransition("addressed", "addressed_at", "none")}
          UNION ALL ${dispatchTransition("failed", "failed_at", "none")}
          UNION ALL ${dispatchTransition("canceled", "canceled_at", "none")}
        ) activity
        WHERE activity.kind IS NOT NULL
          AND (? IS NULL OR activity.occurredAt >= ?)
          AND (
            ? IS NULL
            OR activity.occurredAt < ?
            OR (activity.occurredAt = ? AND activity.id < ?)
          )
        ORDER BY activity.occurredAt DESC, activity.id DESC
        LIMIT ?
      `).all(
        ...scoped,
        ...scoped,
        ...scoped,
        ...scoped,
        ...scoped,
        ...scoped,
        command.since,
        command.since,
        cursorAt,
        cursorAt,
        cursorAt,
        cursorId,
        command.limit + 1,
      ));
      const page = rows.slice(0, command.limit);
      const last = page.at(-1);
      return {
        items: page.map(activityEvent),
        nextCursor: rows.length > command.limit && last !== undefined
          ? {createdAt: last.occurredAt, id: last.id}
          : null,
      };
    });
  }

  #readInsights(command: ReadArtifactInsights): ArtifactInsightFacts {
    const scoped = [this.#installationId, command.projectId, command.projectId];
    const since = command.since;
    const limit = command.listLimit;

    const projects = z.array(projectRowSchema).parse(this.#database.prepare(`
      SELECT project.id AS projectId, project.name AS name,
        (project.archived_at IS NOT NULL) AS archived,
        (SELECT COUNT(*) FROM artifacts artifact
          WHERE artifact.project_id = project.id
            AND artifact.deleted_at IS NULL) AS artifactCount,
        (SELECT COUNT(*) FROM versions version
          INNER JOIN artifacts artifact ON artifact.id = version.artifact_id
          WHERE version.project_id = project.id
            AND artifact.deleted_at IS NULL) AS versionCount,
        (SELECT MAX(version.created_at) FROM versions version
          INNER JOIN artifacts artifact ON artifact.id = version.artifact_id
          WHERE version.project_id = project.id
            AND artifact.deleted_at IS NULL) AS latestVersionAt
      FROM projects project
      WHERE ${scope}
      ORDER BY project.created_at, project.id
    `).all(...scoped));

    const catalog = catalogTotalsSchema.parse(this.#database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM versions version
          INNER JOIN artifacts artifact ON artifact.id = version.artifact_id
          INNER JOIN projects project ON project.id = version.project_id
          WHERE ${scope} AND artifact.deleted_at IS NULL
            AND (? IS NULL OR version.created_at >= ?)) AS versionsInWindow,
        (SELECT COUNT(*) FROM artifacts artifact
          INNER JOIN projects project ON project.id = artifact.project_id
          WHERE ${scope} AND artifact.deleted_at IS NULL
            AND artifact.access_setting = 'public_link') AS publicLinkCount,
        (SELECT COUNT(*) FROM artifacts artifact
          INNER JOIN projects project ON project.id = artifact.project_id
          WHERE ${scope} AND artifact.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM artifact_tags tag WHERE tag.artifact_id = artifact.id
            )) AS untaggedArtifactCount
    `).get(...scoped, since, since, ...scoped, ...scoped));

    const recentArtifacts = z.array(recentArtifactSchema).parse(this.#database.prepare(`
      SELECT artifact.id AS artifactId, artifact.name AS name,
        artifact.project_id AS projectId,
        latest.number AS latestVersionNumber,
        latest.created_at AS latestVersionAt
      FROM artifacts artifact
      INNER JOIN projects project ON project.id = artifact.project_id
      INNER JOIN versions latest ON latest.artifact_id = artifact.id
        AND latest.number = (
          SELECT MAX(version.number) FROM versions version
          WHERE version.artifact_id = artifact.id
        )
      WHERE ${scope} AND artifact.deleted_at IS NULL
      ORDER BY latest.created_at DESC, artifact.id DESC
      LIMIT ?
    `).all(...scoped, limit));

    const tags = z.array(tagRowSchema).parse(this.#database.prepare(`
      SELECT tag.tag AS tag, COUNT(*) AS artifactCount
      FROM artifact_tags tag
      INNER JOIN artifacts artifact ON artifact.id = tag.artifact_id
      INNER JOIN projects project ON project.id = artifact.project_id
      WHERE ${scope} AND artifact.deleted_at IS NULL
      GROUP BY tag.tag
      ORDER BY artifactCount DESC, tag.tag
      LIMIT ?
    `).all(...scoped, limit));

    const threads = threadTotalsSchema.parse(this.#database.prepare(`
      SELECT
        COALESCE(SUM(thread.state = 'open'), 0) AS openThreads,
        COALESCE(SUM(thread.state = 'resolved'), 0) AS resolvedThreads,
        COALESCE(SUM(thread.state = 'open' AND thread.dispatch_id IS NOT NULL), 0)
          AS openDispatchedThreads,
        MIN(CASE WHEN thread.state = 'open' THEN thread.created_at END)
          AS oldestOpenThreadAt,
        COALESCE(SUM(? IS NULL OR thread.created_at >= ?), 0)
          AS threadsOpenedInWindow,
        COALESCE(SUM(
          thread.resolved_at IS NOT NULL AND (? IS NULL OR thread.resolved_at >= ?)
        ), 0) AS threadsResolvedInWindow
      FROM comment_threads thread
      INNER JOIN artifacts artifact ON artifact.id = thread.artifact_id
      INNER JOIN projects project ON project.id = thread.project_id
      WHERE ${scope} AND thread.installation_id = project.installation_id
        AND artifact.deleted_at IS NULL
    `).get(since, since, since, since, ...scoped));

    const replies = repliesSchema.parse(this.#database.prepare(`
      SELECT COUNT(*) AS repliesInWindow
      FROM comment_replies reply
      INNER JOIN comment_threads thread ON thread.id = reply.thread_id
      INNER JOIN artifacts artifact ON artifact.id = thread.artifact_id
      INNER JOIN projects project ON project.id = reply.project_id
      WHERE ${scope} AND thread.installation_id = project.installation_id
        AND artifact.deleted_at IS NULL
        AND (? IS NULL OR reply.created_at >= ?)
    `).get(...scoped, since, since));

    const dispatchRows = z.array(dispatchRowSchema).parse(this.#database.prepare(`
      SELECT dispatch.state AS state, COUNT(*) AS dispatches,
        COALESCE(SUM(? IS NULL OR dispatch.created_at >= ?), 0) AS inWindow
      FROM agent_dispatches dispatch
      INNER JOIN projects project ON project.id = dispatch.project_id
      WHERE ${scope} AND dispatch.installation_id = project.installation_id
      GROUP BY dispatch.state
    `).all(since, since, ...scoped));
    const dispatches = {
      addressed: 0,
      canceled: 0,
      claimed: 0,
      delivered: 0,
      failed: 0,
      queued: 0,
    } satisfies Record<InsightDispatchState, number>;
    let dispatchesInWindow = 0;
    for (const row of dispatchRows) {
      dispatches[row.state] = row.dispatches;
      dispatchesInWindow += row.inWindow;
    }

    const openThreadsByArtifact = z.array(openThreadArtifactSchema).parse(
      this.#database.prepare(`
        SELECT artifact.id AS artifactId, artifact.name AS name,
          artifact.project_id AS projectId, COUNT(*) AS openThreads
        FROM comment_threads thread
        INNER JOIN artifacts artifact ON artifact.id = thread.artifact_id
        INNER JOIN projects project ON project.id = thread.project_id
        WHERE ${scope} AND thread.installation_id = project.installation_id
          AND artifact.deleted_at IS NULL AND thread.state = 'open'
        GROUP BY artifact.id
        ORDER BY openThreads DESC, artifact.id
        LIMIT ?
      `).all(...scoped, limit),
    );

    // Storage counts every retained version, including those of deleted
    // artifacts: deletion hides an artifact but keeps its immutable bytes.
    const storageTotals = storageTotalsSchema.parse(this.#database.prepare(`
      SELECT
        COALESCE(SUM(entry.size), 0) AS logicalBytes,
        COUNT(entry.path) AS fileCount,
        COALESCE(SUM(
          CASE WHEN ? IS NOT NULL AND version.created_at < ? THEN entry.size END
        ), 0) AS baselineBytes,
        MIN(substr(version.created_at, 1, 10)) AS firstPublicationDay
      FROM versions version
      INNER JOIN projects project ON project.id = version.project_id
      INNER JOIN manifest_entries entry ON entry.version_id = version.id
      WHERE ${scope}
    `).get(since, since, ...scoped));

    const stored = storedSchema.parse(this.#database.prepare(`
      SELECT COUNT(*) AS distinctBlobCount,
        COALESCE(SUM(blob.size), 0) AS storedBytes
      FROM (
        SELECT entry.sha256, MAX(entry.size) AS size
        FROM versions version
        INNER JOIN projects project ON project.id = version.project_id
        INNER JOIN manifest_entries entry ON entry.version_id = version.id
        WHERE ${scope}
        GROUP BY entry.sha256
      ) blob
    `).get(...scoped));

    const dailyGrowth = z.array(growthRowSchema).parse(this.#database.prepare(`
      SELECT substr(version.created_at, 1, 10) AS day,
        COUNT(*) AS versions,
        COALESCE(SUM(sized.bytes), 0) AS addedBytes
      FROM versions version
      INNER JOIN projects project ON project.id = version.project_id
      INNER JOIN (
        SELECT entry.version_id, SUM(entry.size) AS bytes
        FROM manifest_entries entry
        GROUP BY entry.version_id
      ) sized ON sized.version_id = version.id
      WHERE ${scope} AND (? IS NULL OR version.created_at >= ?)
      GROUP BY day
      ORDER BY day
    `).all(...scoped, since, since));

    const largestArtifacts = z.array(largestArtifactSchema).parse(this.#database.prepare(`
      SELECT artifact.id AS artifactId, artifact.name AS name,
        artifact.project_id AS projectId,
        COALESCE(SUM(entry.size), 0) AS logicalBytes
      FROM artifacts artifact
      INNER JOIN projects project ON project.id = artifact.project_id
      INNER JOIN versions version ON version.artifact_id = artifact.id
      INNER JOIN manifest_entries entry ON entry.version_id = version.id
      WHERE ${scope} AND artifact.deleted_at IS NULL
      GROUP BY artifact.id
      ORDER BY logicalBytes DESC, artifact.id
      LIMIT ?
    `).all(...scoped, limit));

    const gitHistoryProjects = z.array(gitHistoryProjectSchema).parse(
      this.#database.prepare(`
        SELECT project.id AS projectId,
          COALESCE(setting.enabled, 0) AS enabled,
          setting.storage_budget_bytes AS budgetBytes,
          COALESCE((
            SELECT SUM(reservation.logical_bytes)
            FROM git_history_budget_reservations reservation
            INNER JOIN git_history_jobs job ON job.id = reservation.job_id
            WHERE job.project_id = project.id
              AND reservation.installation_id = project.installation_id
              AND reservation.state = 'committed'
          ), 0) AS committedBytes,
          COALESCE((
            SELECT SUM(reservation.logical_bytes)
            FROM git_history_budget_reservations reservation
            INNER JOIN git_history_jobs job ON job.id = reservation.job_id
            WHERE job.project_id = project.id
              AND reservation.installation_id = project.installation_id
              AND reservation.state = 'reserved'
          ), 0) AS reservedBytes
        FROM projects project
        LEFT JOIN git_history_project_settings setting
          ON setting.project_id = project.id
          AND setting.installation_id = project.installation_id
        WHERE ${scope}
        ORDER BY project.created_at, project.id
      `).all(...scoped),
    );

    const gitHistoryJobs = gitHistoryJobsSchema.parse(this.#database.prepare(`
      SELECT
        COALESCE(SUM(job.state IN ('queued', 'claimed')), 0) AS pendingJobs,
        COALESCE(SUM(job.state <> 'done' AND job.last_error IS NOT NULL), 0)
          AS failingJobs
      FROM git_history_jobs job
      INNER JOIN projects project ON project.id = job.project_id
      WHERE ${scope} AND job.installation_id = project.installation_id
    `).get(...scoped));

    return {
      overview: {
        artifactCount: sum(projects.map((project) => project.artifactCount)),
        projects: projects.map((project) => ({
          ...project,
          archived: project.archived === 1,
        })),
        publicLinkCount: catalog.publicLinkCount,
        recentArtifacts,
        tags,
        untaggedArtifactCount: catalog.untaggedArtifactCount,
        versionCount: sum(projects.map((project) => project.versionCount)),
        versionsInWindow: catalog.versionsInWindow,
      },
      review: {
        ...threads,
        dispatches,
        dispatchesInWindow,
        openThreadsByArtifact,
        repliesInWindow: replies.repliesInWindow,
      },
      storage: {
        baselineBytes: storageTotals.baselineBytes,
        dailyGrowth,
        distinctBlobCount: stored.distinctBlobCount,
        fileCount: storageTotals.fileCount,
        firstPublicationDay: storageTotals.firstPublicationDay,
        gitHistory: {
          committedBytes: sum(gitHistoryProjects.map((row) => row.committedBytes)),
          failingJobs: gitHistoryJobs.failingJobs,
          pendingJobs: gitHistoryJobs.pendingJobs,
          projects: gitHistoryProjects.map((row) => ({
            ...row,
            enabled: row.enabled === 1,
          })),
          reservedBytes: sum(gitHistoryProjects.map((row) => row.reservedBytes)),
        },
        largestArtifacts,
        logicalBytes: storageTotals.logicalBytes,
        storedBytes: stored.storedBytes,
      },
    };
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function activityEvent(row: z.infer<typeof activityRowSchema>): InsightActivityEvent {
  return {
    actor: row.actorPrincipalId === null
      ? null
      : {
        displayName: row.actorDisplayName,
        kind: row.actorKind,
        principalId: row.actorPrincipalId,
      },
    artifactId: row.artifactId,
    artifactName: row.artifactName,
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt,
    projectId: row.projectId,
    versionNumber: row.versionNumber,
  };
}
