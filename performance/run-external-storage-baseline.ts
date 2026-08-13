import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultExternalStorageBaselineConfig,
  runExternalStorageBaseline,
} from "./external-storage-baseline.js";

const optionsSchema = z.object({
  concurrency: z.coerce.number().int(),
  output: z.string().min(1),
  publications: z.coerce.number().int(),
  reads: z.coerce.number().int(),
});

const program = new Command()
  .name("external-storage-performance-baseline")
  .description("Run a bounded compiled-server baseline against Postgres and S3-compatible storage.")
  .option(
    "--publications <count>",
    "measured concurrent publications (maximum 100)",
    String(defaultExternalStorageBaselineConfig.concurrentPublications),
  )
  .option(
    "--reads <count>",
    "measured cross-process content reads (maximum 1000)",
    String(defaultExternalStorageBaselineConfig.reads),
  )
  .option(
    "--concurrency <count>",
    "publication concurrency (maximum 16; reads use twice this value)",
    String(defaultExternalStorageBaselineConfig.operationConcurrency),
  )
  .option(
    "--output <path>",
    "JSON report path",
    "evidence/external-storage-performance-baseline.json",
  );

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const report = await runExternalStorageBaseline({
    ...defaultExternalStorageBaselineConfig,
    concurrentPublications: options.publications,
    operationConcurrency: options.concurrency,
    reads: options.reads,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatSummary(report)}\nReport: ${outputPath}\n`);
}

function formatSummary(
  report: Awaited<ReturnType<typeof runExternalStorageBaseline>>,
): string {
  const warnings = report.warnings.length === 0
    ? "none"
    : report.warnings.join(" ");
  return [
    "External-storage Artifact Server baseline complete.",
    `Providers ready: ${report.providerReadyMilliseconds} ms (excluded from application latency).`,
    `Server ready: ${report.serverReadyMilliseconds.initialProcesses.join(" / ")} ms; replacement ${report.serverReadyMilliseconds.replacementProcess} ms.`,
    `Concurrent publish: ${report.concurrentPublish.operationsPerSecond} ops/s, p95 ${report.concurrentPublish.latency.p95Milliseconds} ms.`,
    `Cross-process read: ${report.concurrentRead.operationsPerSecond} ops/s, p95 ${report.concurrentRead.latency.p95Milliseconds} ms.`,
    `Artifact list: ${report.artifactList.operationsPerSecond} ops/s, p95 ${report.artifactList.latency.p95Milliseconds} ms.`,
    `File client, ${report.configuration.directoryFiles}-file directory: p95 ${report.fileClient.directory.latency.p95Milliseconds} ms.`,
    `File client, ${formatMib(report.configuration.singleFileBytes)} MiB file: p95 ${report.fileClient.singleFile.latency.p95Milliseconds} ms.`,
    `Investigation warnings: ${warnings}`,
  ].join("\n");
}

function formatMib(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The external-storage baseline failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
