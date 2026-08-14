import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultServerCapacityConfig,
  runServerCapacityBaseline,
  type ServerCapacityReport,
} from "./server-capacity-baseline.js";

const optionsSchema = z.object({
  output: z.string().min(1),
});

const program = new Command()
  .name("server-capacity-baseline")
  .description("Measure one compiled Artifact Server process at 1/10/25/50/100 concurrency.")
  .option(
    "--output <path>",
    "JSON report path",
    "evidence/local-capacity-baseline.json",
  );

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const report = await runServerCapacityBaseline(defaultServerCapacityConfig);
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatSummary(report)}\nReport: ${outputPath}\n`);
}

function formatSummary(report: ServerCapacityReport): string {
  const rows = report.levels.flatMap((level) => [
    `${level.concurrentUsers} browse users: ${level.browse.journeysPerSecond} journeys/s, p95 ${level.browse.journeyLatency.p95Milliseconds} ms, peak RSS ${formatMib(level.browse.memory.peak.rss)} MiB.`,
    `${level.concurrentUsers} publish users: ${level.publish.journeysPerSecond} journeys/s, p95 ${level.publish.journeyLatency.p95Milliseconds} ms, peak RSS ${formatMib(level.publish.memory.peak.rss)} MiB.`,
  ]);
  return [
    "Artifact Server capacity baseline complete.",
    ...rows,
    `Final retained heap change: ${formatMib(report.summary.finalRetainedHeapDeltaBytes)} MiB.`,
    `Maximum server RSS: ${formatMib(report.summary.maximumPeakRssBytes)} MiB.`,
    `Investigation warnings: ${report.warnings.length === 0 ? "none" : report.warnings.join(" ")}`,
  ].join("\n");
}

function formatMib(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The server capacity baseline failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
