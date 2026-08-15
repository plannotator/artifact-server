import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 15_000,
  },
});
