import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {normalizeArtifactSearchText} from "../../src/application/artifact-tags.js";
import {classifyFileKind} from "../../src/core/file-kind.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {type LatencySummary, summarizeLatencies} from "./latency-summary.js";

const configSchema = z.object({
  artifacts: z.number().int().min(1_000).max(200_000),
  projects: z.number().int().min(1).max(100),
  folders: z.number().int().min(10).max(10_000),
  folderArtifacts: z.number().int().min(100).max(10_000),
  heavyVersions: z.number().int().min(1).max(1_000),
  heavyThreads: z.number().int().min(0).max(5_000),
  iterations: z.number().int().min(5).max(200),
});

export type FileOverviewBaselineConfig = z.infer<typeof configSchema>;

/**
 * The section 13 data set: 100,000 artifacts, 20 projects, 2,000 folders, one
 * leaf folder holding 10,000 artifacts, and one artifact with 200 versions and
 * 500 comment threads for the cross-project move.
 */
export const defaultFileOverviewBaselineConfig: FileOverviewBaselineConfig = {
  artifacts: 100_000,
  projects: 20,
  folders: 2_000,
  folderArtifacts: 10_000,
  heavyVersions: 200,
  heavyThreads: 500,
  iterations: 40,
};

/** Section 13 budgets (p95, warm, milliseconds). Budgets to establish, not gates from one run. */
export const fileOverviewBudgets = {
  listFilesDefault: 150,
  listFilesFiltered: 200,
  listFolderChildren: 50,
  folderRename: 20,
  crossProjectMove: 250,
  folderTrash: 2_000,
  batchOfHundredMoves: 1_500,
} as const;

export type {LatencySummary} from "./latency-summary.js";

export interface FileOverviewBaselineReport {
  readonly configuration: FileOverviewBaselineConfig;
  readonly environment: {readonly node: string; readonly platform: string; readonly arch: string};
  readonly seedMilliseconds: number;
  readonly operations: Readonly<Record<keyof typeof fileOverviewBudgets | "fileFacets", LatencySummary>>;
  readonly budgets: typeof fileOverviewBudgets;
  readonly withinBudget: Readonly<Record<keyof typeof fileOverviewBudgets, boolean>>;
}

const installationId = "local";
const mediaTypes = [
  ["text/html; charset=utf-8", "index.html"],
  ["text/markdown", "notes.md"],
  ["text/csv", "table.csv"],
  ["image/png", "chart.png"],
  ["application/pdf", "paper.pdf"],
  ["text/javascript", "tool.js"],
  ["application/octet-stream", "export.md"],
  ["video/mp4", "clip.mp4"],
] as const;

/**
 * Seed a temporary compact database at the section 13 scale, then time the
 * storage paths behind the Files page. Seeding writes rows directly: the
 * point is to measure reads and per-item writes at scale, not publication.
 */
export async function runFileOverviewBaseline(input: FileOverviewBaselineConfig): Promise<FileOverviewBaselineReport> {
  const config = configSchema.parse(input);
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-server-files-baseline-"));
  const databasePath = path.join(directory, "artifact-server.db");
  try {
    new SqliteArtifactRepository(databasePath, installationId).close();
    const seedStarted = performance.now();
    const seed = seedDatabase(databasePath, config);
    const seedMilliseconds = round(performance.now() - seedStarted);
    const repository = new SqliteArtifactRepository(databasePath, installationId);
    try {
      const unfiltered = {
        installationId, projectIds: [], folder: null, kinds: [], tags: [], linked: "any" as const,
        createdAfter: null, createdBefore: null, updatedAfter: null, updatedBefore: null, search: null,
      };
      const filtered = {
        ...unfiltered,
        kinds: ["markdown" as const, "data" as const],
        tags: ["tag-7", "tag-42"],
        updatedAfter: seed.midpoint,
      };
      const listFilesDefault = await measure(config.iterations, () => repository.fileCatalog.listFiles({
        ...unfiltered, sort: "updated", direction: "desc", cursor: null, limit: 100,
      }));
      const listFilesFiltered = await measure(config.iterations, () => repository.fileCatalog.listFiles({
        ...filtered, sort: "updated", direction: "desc", cursor: null, limit: 100,
      }));
      const fileFacets = await measure(Math.min(config.iterations, 10), () => repository.fileCatalog.fileFacets(unfiltered));
      const listFolderChildren = await measure(config.iterations, () => repository.folders.listFolder({
        installationId, projectId: seed.hotProjectId, folderId: seed.hotFolderId, cursor: null, limit: 100,
        comments: "all", sort: "newest", tags: [], search: null,
      }));
      const observer = new DatabaseSync(databasePath, {readOnly: true});
      const revision = z.object({revision: z.number().int()});
      const folderRevision = (folderId: string) =>
        revision.parse(observer.prepare("SELECT revision FROM folders WHERE id = ?").get(folderId)).revision;
      const write = () => ({
        installationId, principalId: "perf-baseline", authorizedByPrincipalId: null,
        createdAt: new Date().toISOString(), idempotencyKey: randomUUID(), inputDigest: randomUUID(),
      });
      // Renaming the folder that holds 10,000 artifacts is one row (section 13).
      const folderRename = await measure(config.iterations, async (iteration) => {
        const name = `Hot folder ${iteration}`;
        await repository.folders.writeFolder({...write(), projectId: seed.hotProjectId}, {
          kind: "update", id: seed.hotFolderId, expectedRevision: folderRevision(seed.hotFolderId),
          label: {name, nameKey: normalizeArtifactSearchText(name)},
        });
      });
      // Trash the 10,000-artifact subtree in one transaction; recovery between samples is not timed.
      const folderTrash = await measure(Math.min(config.iterations, 5), async () => {
        await repository.folders.writeFolder({...write(), projectId: seed.hotProjectId}, {
          kind: "delete", id: seed.hotFolderId, expectedRevision: folderRevision(seed.hotFolderId),
          trashGroupId: `trg_${randomUUID()}`,
        });
      }, async () => {
        const trashed = z.object({count: z.number().int()}).parse(observer.prepare(
          "SELECT COUNT(*) AS count FROM artifacts WHERE folder_id = ? AND trash_group_id IS NOT NULL",
        ).get(seed.hotFolderId)).count;
        if (trashed !== config.folderArtifacts) {
          throw new Error(`The folder trash carried ${trashed} of ${config.folderArtifacts} artifacts.`);
        }
        await repository.trash.recover({...write(), projectId: seed.hotProjectId}, {
          kind: "folder", folderId: seed.hotFolderId, label: null,
        });
      });
      // Move the 200-version, 500-thread artifact back and forth between two projects.
      const crossProjectMove = await measure(Math.min(config.iterations, 20), async (iteration) => {
        const [from, to] = iteration % 2 === 0
          ? [seed.heavy.projectId, seed.heavy.otherProjectId]
          : [seed.heavy.otherProjectId, seed.heavy.projectId];
        await repository.folders.moveArtifactToProject({
          ...write(), projectId: from, toProjectId: to, toFolderId: null,
          artifactId: seed.heavy.id, expectedCurrentVersionId: seed.heavy.versionId,
        });
      });
      observer.close();
      const moved = seed.hotArtifacts.slice(0, 100);
      const batchOfHundredMoves = await measure(Math.min(config.iterations, 10), async (iteration) => {
        const toFolderId = iteration % 2 === 0 ? seed.otherFolderId : seed.hotFolderId;
        for (const artifact of moved) {
          // A batch runs its items in request order, one transaction each.
          // eslint-disable-next-line no-await-in-loop
          await repository.folders.writeArtifactPlacement({
            installationId, projectId: seed.hotProjectId, principalId: "perf-baseline",
            authorizedByPrincipalId: null, createdAt: new Date().toISOString(), idempotencyKey: randomUUID(),
            inputDigest: randomUUID(), artifactId: artifact.id, expectedCurrentVersionId: artifact.versionId,
          }, {kind: "move", toFolderId});
        }
      });
      const operations = {
        listFilesDefault, listFilesFiltered, fileFacets, listFolderChildren, folderRename, crossProjectMove,
        folderTrash, batchOfHundredMoves,
      };
      return {
        configuration: config,
        environment: {node: process.version, platform: process.platform, arch: process.arch},
        seedMilliseconds,
        operations,
        budgets: fileOverviewBudgets,
        withinBudget: {
          listFilesDefault: listFilesDefault.p95Milliseconds <= fileOverviewBudgets.listFilesDefault,
          listFilesFiltered: listFilesFiltered.p95Milliseconds <= fileOverviewBudgets.listFilesFiltered,
          listFolderChildren: listFolderChildren.p95Milliseconds <= fileOverviewBudgets.listFolderChildren,
          folderRename: folderRename.p95Milliseconds <= fileOverviewBudgets.folderRename,
          crossProjectMove: crossProjectMove.p95Milliseconds <= fileOverviewBudgets.crossProjectMove,
          folderTrash: folderTrash.p95Milliseconds <= fileOverviewBudgets.folderTrash,
          batchOfHundredMoves: batchOfHundredMoves.p95Milliseconds <= fileOverviewBudgets.batchOfHundredMoves,
        },
      };
    } finally {
      repository.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

interface SeededDataSet {
  readonly hotProjectId: string;
  readonly hotFolderId: string;
  readonly otherFolderId: string;
  readonly hotArtifacts: readonly {readonly id: string; readonly versionId: string}[];
  readonly midpoint: string;
  readonly heavy: {
    readonly id: string;
    readonly projectId: string;
    readonly otherProjectId: string;
    readonly versionId: string;
  };
}

function seedDatabase(databasePath: string, config: FileOverviewBaselineConfig): SeededDataSet {
  const database = new DatabaseSync(databasePath, {enableForeignKeyConstraints: true});
  try {
    database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const projectIds = Array.from({length: config.projects}, (_, index) => `prj_perf_${index}`);
    const insertProject = database.prepare("INSERT INTO projects (id, installation_id, name, created_at, archived_at) VALUES (?, ?, ?, ?, NULL)");
    for (const [index, id] of projectIds.entries()) insertProject.run(id, installationId, `Project ${index}`, new Date(start).toISOString());
    const insertFolder = database.prepare(`
      INSERT INTO folders (id, installation_id, project_id, parent_folder_id, name, name_key, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const foldersByProject = new Map<string, string[]>();
    for (let index = 0; index < config.folders; index += 1) {
      const projectId = projectIds[index % projectIds.length] ?? "prj_default";
      const siblings = foldersByProject.get(projectId) ?? [];
      // Nest under one of the first ten folders, never the first: it stays a
      // leaf whose subtree is exactly the 10,000 artifacts it holds.
      const parent = siblings.length >= 10 ? siblings[1 + (siblings.length % 9)] ?? null : null;
      const id = `fld_${randomUUID()}`;
      const created = new Date(start).toISOString();
      insertFolder.run(id, installationId, projectId, parent, `Folder ${index}`, `folder ${index}`, created, created);
      foldersByProject.set(projectId, [...siblings, id]);
    }
    const hotProjectId = projectIds[0] ?? "prj_default";
    const hotFolders = foldersByProject.get(hotProjectId) ?? [];
    const hotFolderId = hotFolders[0] ?? "";
    const otherFolderId = hotFolders[1] ?? "";
    const insertArtifact = database.prepare(`
      INSERT INTO artifacts (
        id, project_id, name, search_name, access_setting, current_version_id, created_at, deleted_at,
        folder_id, file_kind, current_version_created_at, current_size
      ) VALUES (?, ?, ?, ?, 'account_required', ?, ?, NULL, ?, ?, ?, ?)
    `);
    const insertVersion = database.prepare(`
      INSERT INTO versions (
        id, project_id, artifact_id, number, manifest_digest, entry_path, routing_mode, content_token,
        publisher_principal_id, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, 'static', ?, 'perf-baseline', ?)
    `);
    const insertEntry = database.prepare(`
      INSERT INTO manifest_entries (version_id, path, size, media_type, sha256, disposition)
      VALUES (?, ?, ?, ?, ?, 'inline')
    `);
    const insertTag = database.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)");
    const hotArtifacts: {id: string; versionId: string}[] = [];
    const stepMilliseconds = Math.floor((365 * 24 * 60 * 60 * 1_000) / config.artifacts);
    for (let index = 0; index < config.artifacts; index += 1) {
      const hot = index < config.folderArtifacts;
      const projectId = hot ? hotProjectId : projectIds[index % projectIds.length] ?? hotProjectId;
      const folders = foldersByProject.get(projectId) ?? [];
      const folderId = hot ? hotFolderId : index % 5 === 0 ? null : folders[index % folders.length] ?? null;
      const [mediaType, entryPath] = mediaTypes[index % mediaTypes.length] ?? mediaTypes[0];
      const id = `art_${randomUUID()}`;
      const versionId = `ver_${randomUUID()}`;
      const created = new Date(start + index * stepMilliseconds).toISOString();
      const size = 1_000 + (index * 7_919) % 500_000;
      const name = `Report ${index}`;
      insertArtifact.run(id, projectId, name, name.toLowerCase(), versionId, created, folderId,
        classifyFileKind(mediaType, entryPath, 1), created, size);
      insertVersion.run(versionId, projectId, id, `sha256:${index}`, entryPath, `ctk_${randomUUID()}`, created);
      insertEntry.run(versionId, entryPath, size, mediaType, "0".repeat(64));
      if (index % 3 !== 0) insertTag.run(id, `tag-${index % 200}`);
      if (index % 7 === 0) insertTag.run(id, `tag-${(index + 100) % 200}`);
      if (hot) hotArtifacts.push({id, versionId});
    }
    const heavy = seedHeavyArtifact(database, config, {
      projectId: projectIds[1] ?? hotProjectId,
      otherProjectId: projectIds[2] ?? hotProjectId,
      createdAt: new Date(start).toISOString(),
      insertArtifact, insertEntry,
    });
    database.exec("COMMIT;");
    return {
      hotProjectId, hotFolderId, otherFolderId, hotArtifacts, heavy,
      midpoint: new Date(start + Math.floor(config.artifacts / 2) * stepMilliseconds).toISOString(),
    };
  } finally {
    database.close();
  }
}

/** One artifact with many versions and comment threads, at the project root. */
function seedHeavyArtifact(database: DatabaseSync, config: FileOverviewBaselineConfig, input: {
  readonly projectId: string;
  readonly otherProjectId: string;
  readonly createdAt: string;
  readonly insertArtifact: ReturnType<DatabaseSync["prepare"]>;
  readonly insertEntry: ReturnType<DatabaseSync["prepare"]>;
}): SeededDataSet["heavy"] {
  const id = `art_${randomUUID()}`;
  const versionIds = Array.from({length: config.heavyVersions}, () => `ver_${randomUUID()}`);
  const currentVersionId = versionIds.at(-1) ?? "";
  input.insertArtifact.run(id, input.projectId, "Heavy report", "heavy report", currentVersionId, input.createdAt,
    null, "html", input.createdAt, 2_048);
  const insertNumberedVersion = database.prepare(`
    INSERT INTO versions (
      id, project_id, artifact_id, number, manifest_digest, entry_path, routing_mode, content_token,
      publisher_principal_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'index.html', 'static', ?, 'perf-baseline', ?)
  `);
  for (const [index, versionId] of versionIds.entries()) {
    insertNumberedVersion.run(versionId, input.projectId, id, index + 1, `sha256:heavy-${index}`,
      `ctk_${randomUUID()}`, input.createdAt);
    input.insertEntry.run(versionId, "index.html", 2_048, "text/html; charset=utf-8", "0".repeat(64));
  }
  const insertThread = database.prepare(`
    INSERT INTO comment_threads (
      id, installation_id, project_id, artifact_id, version_id, path, anchor_json, body, state,
      author_principal_id, author_principal_kind, author_display_name, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'open', 'perf-baseline', 'human', 'Baseline', ?, ?, ?)
  `);
  for (let index = 0; index < config.heavyThreads; index += 1) {
    insertThread.run(`thr_${randomUUID()}`, installationId, input.projectId, id,
      versionIds[index % versionIds.length] ?? currentVersionId, `Thread ${index}`, randomUUID(),
      input.createdAt, input.createdAt);
  }
  return {id, projectId: input.projectId, otherProjectId: input.otherProjectId, versionId: currentVersionId};
}

async function measure<A>(
  iterations: number,
  operation: (round: number) => Promise<A>,
  reset?: () => Promise<void>,
): Promise<LatencySummary> {
  const warmUp = Math.min(5, iterations);
  const samples: number[] = [];
  for (let index = 0; index < warmUp + iterations; index += 1) {
    const started = performance.now();
    // Samples are sequential by design: each one times a single operation.
    // eslint-disable-next-line no-await-in-loop
    await operation(index);
    const elapsed = performance.now() - started;
    if (index >= warmUp) samples.push(elapsed);
    // eslint-disable-next-line no-await-in-loop
    await reset?.();
  }
  return summarizeLatencies(samples);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
