import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultLocalBaselineConfig,
  runLocalBaseline,
} from "./local-baseline.js";

const optionsSchema = z.object({
  concurrency: z.coerce.number().int(),
  output: z.string().min(1),
  payloadKib: z.coerce.number().int(),
  publications: z.coerce.number().int(),
  reads: z.coerce.number().int(),
});

const program = new Command()
  .name("local-performance-baseline")
  .description("Run a bounded local Artifact Server smoke and performance baseline.")
  .option(
    "--publications <count>",
    "measured publications (maximum 500)",
    String(defaultLocalBaselineConfig.publications),
  )
  .option(
    "--reads <count>",
    "measured content reads (maximum 5000)",
    String(defaultLocalBaselineConfig.reads),
  )
  .option(
    "--concurrency <count>",
    "concurrent reads (maximum 16)",
    String(defaultLocalBaselineConfig.concurrency),
  )
  .option(
    "--payload-kib <count>",
    "payload size in KiB (maximum 1024; aggregate workload is also bounded)",
    String(defaultLocalBaselineConfig.payloadBytes / 1_024),
  )
  .option(
    "--output <path>",
    "JSON report path",
    "evidence/local-performance-baseline.json",
  );

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const report = await runLocalBaseline({
    ...defaultLocalBaselineConfig,
    concurrency: options.concurrency,
    payloadBytes: options.payloadKib * 1_024,
    publications: options.publications,
    reads: options.reads,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`${formatSummary(report)}\nReport: ${outputPath}\n`);
}

function formatSummary(
  report: Awaited<ReturnType<typeof runLocalBaseline>>,
): string {
  const warningSummary = report.warnings.length === 0
    ? "none"
    : report.warnings.join(" ");
  return [
    "Local Artifact Server baseline complete.",
    `Publish: ${report.publish.operationsPerSecond} ops/s, p95 ${report.publish.latency.p95Milliseconds} ms.`,
    `Read: ${report.read.operationsPerSecond} ops/s, p95 ${report.read.latency.p95Milliseconds} ms.`,
    `Compare: ${report.comparison.operationsPerSecond} ops/s, p95 ${report.comparison.latency.p95Milliseconds} ms.`,
    `Artifact list: ${report.artifactList.operationsPerSecond} ops/s, p95 ${report.artifactList.latency.p95Milliseconds} ms.`,
    `MCP discovery: ${report.mcpDiscovery.operationsPerSecond} ops/s, p95 ${report.mcpDiscovery.latency.p95Milliseconds} ms.`,
    `MCP artifact_list: ${report.mcpArtifactList.operationsPerSecond} ops/s, p95 ${report.mcpArtifactList.latency.p95Milliseconds} ms.`,
    `File client, ${report.configuration.clientDirectoryFiles}-file directory: p95 ${report.fileClient.directory.latency.p95Milliseconds} ms.`,
    `File client, ${formatMib(report.configuration.clientSingleFileBytes)} MiB file: p95 ${report.fileClient.singleFile.latency.p95Milliseconds} ms.`,
    `Restart: ${report.restartMilliseconds} ms.`,
    `Event-loop max delay: ${report.eventLoop.maximumDelayMilliseconds} ms.`,
    `RSS change: ${formatMib(report.memory.rssDeltaBytes)} MiB.`,
    `Investigation warnings: ${warningSummary}`,
  ].join("\n");
}

function formatMib(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
