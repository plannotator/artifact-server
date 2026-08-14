import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/aws-s3-object-storage.probe.test.ts"],
    testTimeout: 60_000,
  },
});
