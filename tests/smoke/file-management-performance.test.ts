import {beforeAll, describe, expect, test} from "vitest";

import {
  defaultFileOverviewBaselineConfig, type FileOverviewBaselineReport, runFileOverviewBaseline,
} from "../../project/performance/file-overview-baseline.js";
import {
  defaultLinkedFolderScanBaselineConfig, type LinkedFolderScanBaselineReport, runLinkedFolderScanBaseline,
} from "../../project/performance/linked-folder-scan-baseline.js";

/**
 * File-management performance on the file-management spec's section 13 data
 * sets. The assertions are the spec's own budgets, never numbers tightened
 * from one machine, so a CI run catches gross regressions only.
 */
describe("file management performance (section 13)", {timeout: 240_000}, () => {
  let overview: FileOverviewBaselineReport;
  let scans: LinkedFolderScanBaselineReport;
  const measureLatency = process.env["ARTIFACT_SERVER_CHECK_LINKED_SCAN_LATENCY"] === "1";

  beforeAll(async () => {
    overview = await runFileOverviewBaseline({...defaultFileOverviewBaselineConfig, iterations: 20});
    scans = await runLinkedFolderScanBaseline({
      ...defaultLinkedFolderScanBaselineConfig,
      warmScans: measureLatency ? defaultLinkedFolderScanBaselineConfig.warmScans : 3,
    });
  }, 240_000);

  test("FOV-003-B: the 100,000-artifact and 20,000-file data sets meet every section 13 p95 budget", () => {
    expect(overview.configuration).toMatchObject({artifacts: 100_000, projects: 20, folders: 2_000, folderArtifacts: 10_000});
    expect(overview.configuration).toMatchObject({heavyVersions: 200, heavyThreads: 500});
    expect(overview.withinBudget).toEqual({
      listFilesDefault: true,
      listFilesFiltered: true,
      listFolderChildren: true,
      folderRename: true,
      crossProjectMove: true,
      folderTrash: true,
      batchOfHundredMoves: true,
    });
    expect(scans.inventoryEntries).toBe(20_000);
    expect(scans.warmScan.samples).toBe(scans.configuration.warmScans);
    expect(scans.warmScan.maximumMilliseconds).toBeLessThanOrEqual(scans.budgets.fullScanMilliseconds);
  });

  test("FOV-003-F: linked-folder scans release the write lock after each page and stay within the request latency budget", () => {
    expect(scans.transactions.writeLockFree).toBe(scans.transactions.samples);
    expect(scans.duringScan.read.samples).toBeGreaterThan(0);
    expect(scans.duringScan.publish.samples).toBeGreaterThan(0);

    // Relative p95 comparisons require a controlled run. Parallel suites and
    // shared CI runners use only the transaction and gross scan checks.
    expect(scans.withinBudget).toMatchObject(measureLatency ? {
      onePagePerTransaction: true, readDuringScan: true, publishDuringScan: true,
    } : {onePagePerTransaction: true});
  });
});
