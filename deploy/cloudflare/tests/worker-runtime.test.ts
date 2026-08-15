import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-test-api-token-0000000000000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).length(1),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const artifactListSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
});
const versionListSchema = z.object({
  versions: z.array(z.object({
    version: z.object({id: z.string(), number: z.number().int().positive()}),
  })),
});
const actionListSchema = z.object({
  actions: z.array(z.object({action: z.string()})),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-"));
  worker = await startWorker(persistPath);
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare Worker runtime", () => {
  it("publishes through real local D1 and R2 and survives a Worker restart", async () => {
    const health = await worker.fetch(`${origin}/health`);
    const ready = await worker.fetch(`${origin}/ready`);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);

    const unauthorized = await worker.fetch(`${origin}/api/v1/artifacts`);
    expect(unauthorized.status).toBe(401);

    const bytes = new TextEncoder().encode("<h1>Cloudflare runtime</h1>");
    const createUpload = await worker.fetch(`${origin}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
      }),
      headers: authenticatedJsonHeaders(),
      method: "POST",
    });
    expect(createUpload.status).toBe(201);
    const uploadPlan = uploadPlanSchema.parse(await createUpload.json());
    const plannedFile = uploadPlan.files[0];
    if (plannedFile === undefined) throw new Error("The upload plan is empty.");

    const uploaded = await worker.fetch(plannedFile.uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${apiToken}`},
      method: "PUT",
    });
    const uploadedBody = await uploaded.text();
    if (!uploaded.ok) {
      throw new Error(`Cloudflare upload failed with ${uploaded.status}: ${uploadedBody}`);
    }
    expect(uploaded.status).toBe(200);

    const committed = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Cloudflare runtime test",
        tags: ["cloudflare", "qualification"],
      }}),
      headers: {
        ...authenticatedJsonHeaders(),
        "Idempotency-Key": "cloudflare-runtime-publish-1",
      },
      method: "POST",
    });
    expect(committed.status).toBe(201);
    const publication = publicationSchema.parse(await committed.json());

    const rendered = await worker.fetch(publication.links.version);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe("<h1>Cloudflare runtime</h1>");

    const artifact = await worker.fetch(publication.links.artifact, {
      headers: {Authorization: `Bearer ${apiToken}`},
      redirect: "manual",
    });
    expect(artifact.status).toBe(302);
    expect(artifact.headers.get("location")).toContain(`.${contentDomain}/`);

    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = await worker.fetch(`${origin}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(afterRestart.status).toBe(200);
    expect(artifactListSchema.parse(await afterRestart.json()).artifacts)
      .toContainEqual(expect.objectContaining({
        artifact: expect.objectContaining({id: publication.artifact.id}),
      }));

    const competingUploads = await Promise.all([
      stageFile("<h1>Second version A</h1>"),
      stageFile("<h1>Second version B</h1>"),
    ]);
    const competingCommits = await Promise.all(
      competingUploads.map((competingUpload, index) =>
        worker.fetch(competingUpload.commitUrl, {
          body: JSON.stringify({target: {
            artifactId: publication.artifact.id,
            expectedCurrentVersionId: publication.version.id,
            kind: "new_version",
          }}),
          headers: {
            ...authenticatedJsonHeaders(),
            "Idempotency-Key": `cloudflare-runtime-race-${index}`,
          },
          method: "POST",
        })
      ),
    );
    expect(competingCommits.map(({status}) => status).toSorted(
      (left, right) => left - right,
    ))
      .toEqual([201, 409]);

    const versions = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(versions.status).toBe(200);
    expect(versionListSchema.parse(await versions.json()).versions)
      .toHaveLength(2);

    const actions = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/actions`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(actions.status).toBe(200);
    expect(actionListSchema.parse(await actions.json()).actions)
      .toHaveLength(2);
  }, 30_000);
});

async function stageFile(source: string) {
  const bytes = new TextEncoder().encode(source);
  const response = await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: authenticatedJsonHeaders(),
    method: "POST",
  });
  expect(response.status).toBe(201);
  const uploadPlan = uploadPlanSchema.parse(await response.json());
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await worker.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${apiToken}`},
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  return uploadPlan;
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
        "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-runtime-test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}

function authenticatedJsonHeaders() {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}
