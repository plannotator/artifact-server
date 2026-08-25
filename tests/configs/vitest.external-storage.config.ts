import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/external-storage/**/*.ts", "src/storage/postgres-*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/external-storage-runtime",
    },
    fileParallelism: false,
    include: ["tests/integration/external-storage-runtime.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
  },
});
