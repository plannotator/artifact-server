import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/external-storage/**/*.ts",
        "src/storage/postgres-*.ts",
        "src/storage/s3-object-storage.ts",
      ],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    fileParallelism: true,
    exclude: [
      ...configDefaults.exclude,
      "tests/integration/**",
      "tests/release/**",
    ],
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 15_000,
  },
});
