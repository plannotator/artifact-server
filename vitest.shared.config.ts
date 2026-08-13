import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/shared/**/*.ts", "src/storage/postgres-*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/shared-runtime",
    },
    fileParallelism: false,
    include: ["tests/integration/shared-runtime.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
  },
});
