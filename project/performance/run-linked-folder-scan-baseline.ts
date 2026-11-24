import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultLinkedFolderScanBaselineConfig, runLinkedFolderScanBaseline,
} from "./linked-folder-scan-baseline.js";

const optionsSchema = z.object({
  files: z.coerce.number().int(),
  scans: z.coerce.number().int(),
  output: z.string().min(1),
});

const program = new Command()
  .name("linked-folder-scan-baseline")
  .description("Time full warm scans of a 20,000-file linked folder and request latency while they run (FOV-003).")
  .option("--files <count>", "files in the linked directory (2,000..20,000)", String(defaultLinkedFolderScanBaselineConfig.files))
  .option("--scans <count>", "measured warm scans (1..10)", String(defaultLinkedFolderScanBaselineConfig.warmScans))
  .option("--output <path>", "JSON report path", "project/evidence/linked-folder-scan-baseline.json");

function ratio(during: number, idle: number): string {
  return `${Math.round((during / idle - 1) * 100)}%`;
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const report = await runLinkedFolderScanBaseline({
    ...defaultLinkedFolderScanBaselineConfig, files: options.files, warmScans: options.scans,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write([
    `Linked-folder scan baseline on ${report.inventoryEntries} files.`,
    `first scan (link): ${report.firstScanMilliseconds} ms`,
    `warm full scan: p50 ${report.warmScan.p50Milliseconds} ms, max ${report.warmScan.maximumMilliseconds} ms` +
      ` (budget ${report.budgets.fullScanMilliseconds} ms)`,
    `read p95: idle ${report.idle.read.p95Milliseconds} ms, during scan ${report.duringScan.read.p95Milliseconds} ms` +
      ` (${ratio(report.duringScan.read.p95Milliseconds, report.idle.read.p95Milliseconds)}, budget +10%)`,
    `publish p95: idle ${report.idle.publish.p95Milliseconds} ms, during scan ${report.duringScan.publish.p95Milliseconds} ms` +
      ` (${ratio(report.duringScan.publish.p95Milliseconds, report.idle.publish.p95Milliseconds)}, budget +10%)`,
    `scan transactions: ${report.transactions.writeLockFree}/${report.transactions.samples} samples took the write lock` +
      ` without waiting; ${report.transactions.partialPageCounts.length} partial page counts observed`,
    `Report: ${outputPath}`,
  ].join("\n") + "\n");
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
