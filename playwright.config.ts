import {defineConfig} from "@playwright/test";

export default defineConfig({
  expect: {timeout: 10_000},
  fullyParallel: false,
  outputDir: "test-results/browser",
  reporter: [
    ["line"],
    ["json", {outputFile: "test-results/browser/playwright-report.json"}],
  ],
  testDir: "tests/browser",
  timeout: 60_000,
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  workers: 1,
});
