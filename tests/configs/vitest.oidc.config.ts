import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["tests/integration/oidc-keycloak.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
  },
});
