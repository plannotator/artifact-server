import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    fileParallelism: true,
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 15_000,
  },
});
