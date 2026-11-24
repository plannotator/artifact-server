import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultFileOverviewBaselineConfig, fileOverviewBudgets, runFileOverviewBaseline,
} from "./file-overview-baseline.js";

const optionsSchema = z.object({
  artifacts: z.coerce.number().int(),
  iterations: z.coerce.number().int(),
  output: z.string().min(1),
});

const program = new Command()
  .name("file-overview-baseline")
  .description("Time the Files page storage paths on the section 13 data set (FOV-003).")
  .option("--artifacts <count>", "seeded artifacts (1,000..200,000)", String(defaultFileOverviewBaselineConfig.artifacts))
  .option("--iterations <count>", "measured iterations per read (5..200)", String(defaultFileOverviewBaselineConfig.iterations))
  .option("--output <path>", "JSON report path", "project/evidence/file-overview-baseline.json");

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const report = await runFileOverviewBaseline({
    ...defaultFileOverviewBaselineConfig, artifacts: options.artifacts, iterations: options.iterations,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = Object.entries(report.operations).map(([name, summary]) => {
    const budget = Object.entries(fileOverviewBudgets).find(([key]) => key === name)?.[1];
    return `${name}: p50 ${summary.p50Milliseconds} ms, p95 ${summary.p95Milliseconds} ms` +
      (budget === undefined ? "" : ` (budget ${budget} ms)`);
  });
  process.stdout.write([
    `File overview baseline on ${report.configuration.artifacts} artifacts (seeded in ${report.seedMilliseconds} ms).`,
    ...lines,
    `Report: ${outputPath}`,
  ].join("\n") + "\n");
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
