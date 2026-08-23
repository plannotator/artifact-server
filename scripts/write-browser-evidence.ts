import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const rawEvidencePath = "test-results/browser/playwright-report.json";
const evidencePath = "evidence/browser.json";

const resultSchema = z.object({
  duration: z.number().nonnegative(),
  errors: z.array(z.object({message: z.string().optional()}).loose()),
  status: z.string(),
}).loose();
const testSchema = z.object({
  results: z.array(resultSchema),
  status: z.string(),
}).loose();
const specSchema = z.object({
  file: z.string(),
  ok: z.boolean(),
  tests: z.array(testSchema),
  title: z.string(),
}).loose();

interface PlaywrightSuite {
  readonly file: string;
  readonly specs: readonly z.infer<typeof specSchema>[];
  readonly suites: readonly PlaywrightSuite[];
  readonly title: string;
}

const suiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() => z.object({
  file: z.string(),
  specs: z.array(specSchema).default([]),
  suites: z.array(suiteSchema).default([]),
  title: z.string(),
}).loose());

const reportSchema = z.object({
  errors: z.array(z.unknown()),
  stats: z.object({
    duration: z.number().nonnegative(),
    expected: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    startTime: z.iso.datetime(),
    unexpected: z.number().int().nonnegative(),
  }).loose(),
  suites: z.array(suiteSchema),
}).loose();

interface EvidenceAssertion {
  readonly ancestorTitles: readonly string[];
  readonly duration: number;
  readonly failureMessages: readonly string[];
  readonly fullName: string;
  readonly status: "failed" | "passed" | "pending";
  readonly title: string;
}

function collectAssertions(
  suite: PlaywrightSuite,
  ancestors: readonly string[],
  byFile: Map<string, EvidenceAssertion[]>,
): void {
  const nextAncestors = suite.title === suite.file
    ? ancestors
    : [...ancestors, suite.title];
  for (const spec of suite.specs) {
    const results = spec.tests.flatMap((test) => test.results);
    const passed = spec.ok && spec.tests.every((test) => test.status === "expected");
    const pending = spec.tests.every((test) => test.status === "skipped");
    const assertions = byFile.get(spec.file) ?? [];
    assertions.push({
      ancestorTitles: nextAncestors,
      duration: results.reduce((total, result) => total + result.duration, 0),
      failureMessages: results.flatMap((result) =>
        result.errors.flatMap((error) => error.message ?? [])
      ),
      fullName: [...nextAncestors, spec.title].join(" "),
      status: pending ? "pending" : passed ? "passed" : "failed",
      title: spec.title,
    });
    byFile.set(spec.file, assertions);
  }
  for (const child of suite.suites) {
    collectAssertions(child, nextAncestors, byFile);
  }
}

const raw: unknown = JSON.parse(await readFile(rawEvidencePath, "utf8"));
const report = reportSchema.parse(raw);
const assertionsByFile = new Map<string, EvidenceAssertion[]>();
for (const suite of report.suites) {
  collectAssertions(suite, [], assertionsByFile);
}

const testResults = [...assertionsByFile].map(([file, assertionResults]) => ({
  assertionResults,
  endTime: Date.parse(report.stats.startTime) + report.stats.duration,
  message: "",
  name: path.resolve("tests/browser", file),
  startTime: Date.parse(report.stats.startTime),
  status: assertionResults.every((assertion) => assertion.status === "passed")
    ? "passed"
    : "failed",
}));
const passedSuites = testResults.filter((result) => result.status === "passed").length;
const evidence = {
  numFailedTestSuites: testResults.length - passedSuites,
  numFailedTests: report.stats.unexpected,
  numPassedTestSuites: passedSuites,
  numPassedTests: report.stats.expected,
  numPendingTests: report.stats.skipped,
  numPendingTestSuites: 0,
  numTodoTests: 0,
  numTotalTestSuites: testResults.length,
  numTotalTests:
    report.stats.expected + report.stats.unexpected + report.stats.skipped,
  startTime: Date.parse(report.stats.startTime),
  success: report.errors.length === 0 && report.stats.unexpected === 0,
  testResults,
};

await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
