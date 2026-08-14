import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/release/compact-compose.test.ts"],
    testTimeout: 180_000,
  },
});
