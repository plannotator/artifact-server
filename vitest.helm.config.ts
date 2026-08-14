import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 600_000,
    include: ["tests/release/helm-chart.test.ts"],
    testTimeout: 900_000,
  },
});
