import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/release/external-storage-compose.test.ts"],
    testTimeout: 240_000,
  },
});
