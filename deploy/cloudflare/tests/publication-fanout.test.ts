import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-fanout-test-api-token-00000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
/**
 * One publication of this size crosses three statement chunks in both per-file
 * INSERT paths: `staged_upload_files` binds seven columns a row (fourteen rows
 * a statement) and `manifest_entries` binds six (sixteen rows a statement).
 */
const publishedFileCount = 40;
const rollbackArtifactName = "Chunked rollback";

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).length(publishedFileCount),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const versionDetailSchema = z.object({
  manifest: z.object({
    digest: z.string(),
    entries: z.array(z.object({
      disposition: z.enum(["attachment", "inline"]),
      mediaType: z.string(),
      path: z.string(),
      sha256: z.string(),
      size: z.number().int().nonnegative(),
    })),
    entryPath: z.string(),
  }).loose(),
}).loose();
const countRowSchema = z.object({total: z.number().int().nonnegative()});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-fanout-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 publication fan-out", () => {
  it("round-trips a manifest that spans several statement chunks", async () => {
    const files = declaredFiles();
    const uploadPlan = await stageUpload(files);
    const commitResponse = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Chunked publication",
        tags: [],
      }}),
      headers: mutationHeaders("cloudflare-fanout-publish-1"),
      method: "POST",
    });
    const commitBody = await commitResponse.text();
    if (commitResponse.status !== 201) {
      throw new Error(`Publishing failed with ${commitResponse.status}: ${commitBody}`);
    }
    const publication = publicationSchema.parse(JSON.parse(commitBody));

    const detail = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/versions/${publication.version.id}`,
      {headers: bearerHeaders()},
    );
    expect(detail.status).toBe(200);
    const {manifest} = versionDetailSchema.parse(await detail.json());
    const expected = files
      .map(({mediaType, path, sha256, size}) => ({mediaType, path, sha256, size}))
      .toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    expect(manifest.entries).toHaveLength(publishedFileCount);
    expect(manifest.entries.map(({mediaType, path, sha256, size}) =>
      ({mediaType, path, sha256, size}))).toEqual(expected);
    expect(manifest.entryPath).toBe("index.html");

    // Read back one file from each chunk of both fan-outs, including the rows
    // that sit on a chunk boundary.
    const sampled = await Promise.all(
      [0, 13, 14, 15, 16, publishedFileCount - 1].map(async (index) => {
        const file = files[index];
        if (file === undefined) throw new Error("The declared file set is short.");
        const served = await worker.fetch(
          `${origin}/api/v1/artifacts/${publication.artifact.id}` +
            `/versions/${publication.version.id}/file?path=${encodeURIComponent(file.path)}`,
          {headers: bearerHeaders()},
        );
        expect(served.status).toBe(200);
        return {served: await served.text(), source: file.source};
      }),
    );
    for (const sample of sampled) expect(sample.served).toBe(sample.source);
  }, 180_000);

  it("rolls a failed chunked publication back completely", async () => {
    const files = declaredFiles();
    // Both publications carry the same idempotency key and different content,
    // so the loser reaches its idempotency insert - the statement after every
    // manifest chunk - and the collision there has to discard all of them.
    const racingPlans = [
      await stageUpload(files),
      await stageUpload(declaredFiles("rollback")),
    ];
    const raced = await Promise.all(racingPlans.map((plan) =>
      worker.fetch(plan.commitUrl, {
        body: JSON.stringify({target: {
          accessSetting: "account_required",
          kind: "new_artifact",
          name: rollbackArtifactName,
          tags: [],
        }}),
        headers: mutationHeaders("cloudflare-fanout-rollback-1"),
        method: "POST",
      })
    ));
    const statuses = raced.map(({status}) => status)
      .toSorted((left, right) => left - right);
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(409);

    await worker.stop();
    const database = new DatabaseSync(await findD1DatabaseFile(persistPath));
    try {
      const survivors = countRowSchema.parse(database.prepare(`
        SELECT COUNT(*) AS total FROM artifacts WHERE name = ?
      `).get(rollbackArtifactName));
      expect(survivors.total).toBe(1);
      const orphans = countRowSchema.parse(database.prepare(`
        SELECT COUNT(*) AS total FROM manifest_entries e
        LEFT JOIN versions v ON v.id = e.version_id WHERE v.id IS NULL
      `).get());
      expect(orphans.total).toBe(0);
      const entryCounts = z.array(countRowSchema).parse(database.prepare(`
        SELECT COUNT(*) AS total FROM manifest_entries GROUP BY version_id
      `).all());
      for (const row of entryCounts) expect(row.total).toBe(publishedFileCount);
      const stagedCounts = z.array(countRowSchema).parse(database.prepare(`
        SELECT COUNT(*) AS total FROM staged_upload_files GROUP BY upload_id
      `).all());
      expect(stagedCounts).toHaveLength(3);
      for (const row of stagedCounts) expect(row.total).toBe(publishedFileCount);
      const checks = countRowSchema.parse(database.prepare(
        "SELECT COUNT(*) AS total FROM mutation_checks",
      ).get());
      expect(checks.total).toBe(0);
    } finally {
      database.close();
    }
    worker = await startWorker(persistPath);
  }, 240_000);
});

function declaredFiles(variant = "publish") {
  return Array.from({length: publishedFileCount}, (_unused, index) => {
    const path = index === 0
      ? "index.html"
      : `assets/file-${String(index).padStart(3, "0")}.html`;
    const source = `<h1>Chunked ${variant} file ${index}</h1>`;
    const bytes = new TextEncoder().encode(source);
    return {
      mediaType: "text/html; charset=utf-8",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      source,
    };
  });
}

async function stageUpload(
  files: ReturnType<typeof declaredFiles>,
) {
  const response = await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: files.map(({mediaType, path, sha256, size}) =>
        ({mediaType, path, sha256, size})),
    }),
    headers: jsonHeaders(),
    method: "POST",
  });
  const body = await response.text();
  if (response.status !== 201) {
    throw new Error(`Staging failed with ${response.status}: ${body}`);
  }
  const plan = uploadPlanSchema.parse(JSON.parse(body));
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  const uploaded = await Promise.all(plan.files.map(async (plannedFile) => {
    const source = sourceByPath.get(plannedFile.path);
    if (source === undefined) {
      throw new Error(`The upload plan named an unknown file ${plannedFile.path}.`);
    }
    const put = await worker.fetch(plannedFile.uploadUrl, {
      body: new TextEncoder().encode(source),
      headers: bearerHeaders(),
      method: "PUT",
    });
    return put.status;
  }));
  expect(uploaded.filter((status) => status !== 200)).toEqual([]);
  return plan;
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries.find((entry) =>
    entry.isFile() && entry.name.endsWith(".sqlite") &&
    entry.parentPath.includes("D1")
  );
  if (found === undefined) {
    throw new Error("The Worker did not persist a local D1 database file.");
  }
  return join(found.parentPath, found.name);
}

function bearerHeaders() {
  return {Authorization: `Bearer ${apiToken}`};
}

function jsonHeaders() {
  return {...bearerHeaders(), "Content-Type": "application/json"};
}

function mutationHeaders(idempotencyKey: string) {
  return {...jsonHeaders(), "Idempotency-Key": idempotencyKey};
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
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
      testScheduled: true,
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
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-fanout-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-publication-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
