import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/release/oci-image.test.ts"],
    pool: "forks",
    testTimeout: 180_000,
  },
});
