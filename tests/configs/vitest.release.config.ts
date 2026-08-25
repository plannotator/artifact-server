import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/release/local-package.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
  },
});
