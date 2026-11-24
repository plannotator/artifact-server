import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  expectFailure, historyCounts, type InventoryEntry, LinkedFolderClient, waitFor, withDatabase,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const bindingSchema = z.object({sourceBinding: z.object({status: z.string()}).loose()}).loose();

function byPath(entries: readonly InventoryEntry[]): ReadonlyMap<string, InventoryEntry> {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

/** Refuse every artifact, version, folder, and action write except binding freshness. */
const refuseHistoryWrites = `
  CREATE TRIGGER lfd_refuse_artifact_insert BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_artifact_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_artifact_update BEFORE UPDATE OF
    id, project_id, name, search_name, access_setting, current_version_id, created_at, deleted_at,
    source_path, source_fingerprint, folder_id, file_kind, current_version_created_at, current_size
  ON artifacts BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_version_insert BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_version_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_version_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_folder_insert BEFORE INSERT ON folders BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_folder_update BEFORE UPDATE ON folders BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_folder_delete BEFORE DELETE ON folders BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_action_insert BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_action_update BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_action_delete BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
  CREATE TRIGGER lfd_refuse_folder_action_insert BEFORE INSERT ON folder_actions BEGIN SELECT RAISE(ABORT, 'history write refused'); END;
`;

describe("observation keeps the inventory matched to disk and never writes history", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-002-root-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-002-B: watch hints and scans track added, modified, and removed files with freshness, and a restart catches up on changes made while stopped", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "on"});
    let client = new LinkedFolderClient(server, installation.apiToken);
    await mkdir(path.join(sourceRoot, "docs"));
    await writeFile(path.join(sourceRoot, "tracked.md"), "# tracked v1\n");
    await writeFile(path.join(sourceRoot, "docs", "drop.md"), "# soon removed\n");
    const link = await client.linkOk(sourceRoot, {name: "Outputs"});
    const initial = byPath(await client.inventory(link.id));
    const trackedEntry = initial.get("tracked.md");
    expect(trackedEntry).toMatchObject({pending: true, state: "untracked"});
    expect(initial.get("docs/drop.md")).toMatchObject({state: "untracked"});
    const [captured] = await client.captureOk(link.id, {entryIds: [trackedEntry?.id ?? ""]});
    const artifactId = captured?.artifactId ?? "";
    expect(captured).toMatchObject({status: "captured"});
    const afterCapture = historyCounts(installation);

    // The watcher only hints; the inventory follows within the hint budget without an explicit scan.
    await waitFor(() => client.get(link.id), (current) => current.scanActivity === "idle" && current.lastScanCompletedAt !== null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(path.join(sourceRoot, "added.md"), "# added while watching\n");
    await writeFile(path.join(sourceRoot, "tracked.md"), "# tracked v2 with more bytes\n");
    await rm(path.join(sourceRoot, "docs", "drop.md"));
    const hinted = await waitFor(async () => byPath(await client.inventory(link.id)), (entries) =>
      entries.get("added.md")?.state === "untracked"
      && entries.get("tracked.md")?.freshness === "modified"
      && !entries.has("docs/drop.md"), 8_000);
    expect(hinted.get("tracked.md")).toMatchObject({artifactId, pending: true, state: "tracked"});
    expect(hinted.get("added.md")).toMatchObject({pending: true});
    expect(historyCounts(installation)).toEqual(afterCapture);

    // Changes made while the server is stopped are reconciled at startup, with watching off.
    await server.stop();
    server = null;
    await rm(path.join(sourceRoot, "tracked.md"));
    await writeFile(path.join(sourceRoot, "added.md"), "# added, then edited while stopped\n");
    await writeFile(path.join(sourceRoot, "docs", "while-stopped.md"), "# new while stopped\n");
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    client = new LinkedFolderClient(server, installation.apiToken);
    const restarted = await waitFor(async () => byPath(await client.inventory(link.id)), (entries) =>
      entries.has("docs/while-stopped.md") && !entries.has("tracked.md"));
    expect(restarted.get("added.md")?.size).toBe(Buffer.byteLength("# added, then edited while stopped\n"));
    expect((await client.get(link.id)).state).toBe("active");
    const binding = bindingSchema.parse(await (await client.request(`/api/v1/artifacts/${artifactId}`)).json());
    expect(binding.sourceBinding.status).toBe("missing");

    // With watching off, a new file appears only after an explicit or periodic scan.
    await writeFile(path.join(sourceRoot, "explicit.md"), "# explicit scan\n");
    await client.scan(link.id);
    expect(byPath(await client.inventory(link.id)).get("explicit.md")).toMatchObject({state: "untracked"});
    expect(historyCounts(installation)).toEqual(afterCapture);
  }, 60_000);

  test("LFD-002-F: with every history write refused, scans and hints still complete, and periodic reconciliation repairs a dropped hint", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "on"});
    let client = new LinkedFolderClient(server, installation.apiToken);
    await writeFile(path.join(sourceRoot, "bound.md"), "# bound\n");
    const link = await client.linkOk(sourceRoot, {name: "Guarded"});
    const [bound] = await client.inventory(link.id);
    await client.captureOk(link.id, {entryIds: [bound?.id ?? ""]});
    withDatabase(installation, (database) => database.exec(refuseHistoryWrites));
    const guarded = historyCounts(installation);

    // Allow the indexer to attach the watcher on its tick after the first scan.
    await waitFor(() => client.get(link.id), (current) => current.scanActivity === "idle" && current.lastScanCompletedAt !== null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(path.join(sourceRoot, "hinted.md"), "# hinted\n");
    await writeFile(path.join(sourceRoot, "bound.md"), "# bound, changed on disk\n");
    const hinted = await waitFor(async () => byPath(await client.inventory(link.id)), (entries) =>
      entries.get("hinted.md")?.state === "untracked" && entries.get("bound.md")?.freshness === "modified", 8_000);
    expect(hinted.get("bound.md")?.pending).toBe(true);
    await writeFile(path.join(sourceRoot, "scanned.md"), "# scanned\n");
    const scanned = await client.scan(link.id);
    expect(scanned.state).toBe("active");
    expect(byPath(await client.inventory(link.id)).has("scanned.md")).toBe(true);
    expect(historyCounts(installation)).toEqual(guarded);

    // Abort after both inserts so the check distinguishes a rolled-back page
    // from a scan that failed before writing anything.
    withDatabase(installation, (database) => database.exec(`
      CREATE TRIGGER lfd_interrupt_scan_page AFTER INSERT ON folder_inventory
      WHEN NEW.disk_path IN ('retry-a.md', 'retry-b.md') AND (
        SELECT COUNT(*) FROM folder_inventory WHERE folder_link_id = NEW.folder_link_id
          AND disk_path IN ('retry-a.md', 'retry-b.md')
      ) = 2
      BEGIN SELECT RAISE(ABORT, 'interrupted inventory page'); END;
    `));
    await Promise.all([
      writeFile(path.join(sourceRoot, "retry-a.md"), "# retry a\n"),
      writeFile(path.join(sourceRoot, "retry-b.md"), "# retry b\n"),
    ]);
    await expectFailure(await client.request(`/api/v1/folder-links/${link.id}/scan`, "POST"), 500, "INTERNAL_ERROR");
    const interrupted = byPath(await client.inventory(link.id));
    expect(interrupted.has("retry-a.md")).toBe(false);
    expect(interrupted.has("retry-b.md")).toBe(false);
    expect(interrupted.has("scanned.md")).toBe(true);

    // Every hint is dropped (watching off); only the periodic backstop observes the change.
    await server.stop();
    withDatabase(installation, (database) => database.exec("DROP TRIGGER lfd_interrupt_scan_page;"));
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderReconcileIntervalMilliseconds: 500, linkedFolderWatch: "off",
    });
    client = new LinkedFolderClient(server, installation.apiToken);
    await waitFor(() => client.get(link.id), (current) => current.state === "active");
    const recovered = byPath(await client.inventory(link.id));
    expect(recovered.get("retry-a.md")?.state).toBe("untracked");
    expect(recovered.get("retry-b.md")?.state).toBe("untracked");
    await writeFile(path.join(sourceRoot, "dropped-hint.md"), "# never hinted\n");
    await rm(path.join(sourceRoot, "hinted.md"));
    const repaired = await waitFor(async () => byPath(await client.inventory(link.id)), (entries) =>
      entries.has("dropped-hint.md") && !entries.has("hinted.md"), 8_000);
    expect(repaired.get("dropped-hint.md")).toMatchObject({pending: true, state: "untracked"});
    expect(historyCounts(installation)).toEqual(guarded);
  }, 60_000);
});
