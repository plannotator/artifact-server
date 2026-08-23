import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/pi-live/**/*.test.ts"],
    pool: "forks",
    testTimeout: 240_000,
  },
});
