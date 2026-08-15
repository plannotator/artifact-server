import { describe, expect, it } from "vitest";

import { buildCloudflareDeploymentManifest } from "../src/deployment-manifest.js";
import { validDeploymentInput } from "./fixtures.js";

describe("Cloudflare deployment manifest", () => {
  it("builds deterministic named resources and runtime configuration", () => {
    const first = buildCloudflareDeploymentManifest(
      validDeploymentInput,
    );
    const second = buildCloudflareDeploymentManifest(
      validDeploymentInput,
    );

    expect(first).toEqual(second);
    expect(first.resourceNames).toEqual({
      worker:
        "artifact-server-review-development-review-foundation-worker",
      database:
        "artifact-server-review-development-review-foundation-records",
      bucket:
        "artifact-server-review-development-review-foundation-objects",
    });
    expect(first.runtimeConfiguration).toMatchObject({
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
      ARTIFACT_SERVER_CONTENT_DOMAIN: "artifact-content.example.net",
      ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER: "r2",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: 0.01,
    });
  });

  it("preserves required ownership tags over operator tags", () => {
    const manifest = buildCloudflareDeploymentManifest({
      ...validDeploymentInput,
      resourceTags: {
        application: "wrong",
        owner: "reviewer",
      },
    });

    expect(manifest.workerTags).toContain(
      "application:artifact-server",
    );
    expect(manifest.workerTags).toContain("owner:reviewer");
    expect(manifest.workerTags).not.toContain("application:wrong");
  });

  it("bounds long provider names with a stable suffix", () => {
    const manifest = buildCloudflareDeploymentManifest({
      ...validDeploymentInput,
      installationName: "a".repeat(40),
      stage: "c".repeat(32),
    });

    expect(manifest.resourceNames.worker.length).toBeLessThanOrEqual(63);
    expect(manifest.resourceNames.database.length).toBeLessThanOrEqual(64);
    expect(manifest.resourceNames.bucket.length).toBeLessThanOrEqual(63);
    expect(manifest.resourceNames.worker).toMatch(/-[a-f0-9]{8}$/);
  });

  it("prefixes every probe-stage resource name", () => {
    const manifest = buildCloudflareDeploymentManifest({
      ...validDeploymentInput,
      installationName: "probe-review",
      stage: "probe-review",
    });

    expect(manifest.resourceNames.worker).toMatch(/^probe-/);
    expect(manifest.resourceNames.database).toMatch(/^probe-/);
    expect(manifest.resourceNames.bucket).toMatch(/^probe-/);
  });

  it("keeps workers.dev qualification names within its preview limit", () => {
    const manifest = buildCloudflareDeploymentManifest({
      ...validDeploymentInput,
      installationName: "probe-review",
      stage: "probe-runtime-review",
    });

    expect(manifest.resourceNames.worker.length).toBeLessThanOrEqual(54);
    expect(manifest.resourceNames.worker).toMatch(/-[a-f0-9]{8}$/);
  });
});
