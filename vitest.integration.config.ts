import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/storage/s3-object-storage.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/s3",
      thresholds: {
        branches: 75,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    fileParallelism: false,
    include: [
      "tests/integration/observability.test.ts",
      "tests/integration/s3-object-storage.test.ts",
      "tests/tooling/object-storage-boundary.test.ts",
    ],
    pool: "forks",
    testTimeout: 30_000,
  },
});
