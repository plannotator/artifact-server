import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

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
  artifact: z.object({id: z.string(), reviewMode: z.enum(["annotate", "interact"])}),
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
const projectGitHistorySchema = z.object({
  gitHistory: z.object({
    enabled: z.boolean(),
    projectId: z.string(),
    state: z.enum([
      "backfilling",
      "budget-limited",
      "degraded",
      "disabled",
      "ready",
      "waiting",
    ]),
  }).strict(),
}).strict();

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
  it("ART-012: a populated older D1 schema upgrades saved artifacts and retries to annotate", async () => {
    const source = "<h1>Pre-feature D1 artifact</h1>";
    const upload = await stageFile(source);
    const publicationInput = {target: {accessSetting: "public_link", kind: "new_artifact", name: "Older D1 artifact"}};
    const publish = () => worker.fetch(upload.commitUrl, {
      body: JSON.stringify(publicationInput),
      headers: {...authenticatedJsonHeaders(), "Idempotency-Key": "cloudflare-review-mode-upgrade"},
      method: "POST",
    });
    const committed = await publish();
    expect(committed.status).toBe(201);
    const publication = publicationSchema.parse(await committed.json());
    await worker.stop();
    let downgraded = false;
    const files = await readdir(persistPath, {recursive: true});
    for (const filename of files.filter((file) => file.endsWith(".sqlite"))) {
      const database = new DatabaseSync(join(persistPath, filename));
      try {
        const table = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'artifacts'").get();
        if (table === undefined) continue;
        database.exec("ALTER TABLE artifacts DROP COLUMN review_mode; ALTER TABLE idempotency_records DROP COLUMN review_mode; UPDATE artifact_server_schema SET version = 9 WHERE component = 'runtime';");
        for (const tableName of ["idempotency_records", "actions"]) {
          const schema = z.object({sql: z.string()}).parse(database.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
          ).get(tableName));
          const indexes = z.array(z.object({sql: z.string()})).parse(database.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
          ).all(tableName));
          const legacySchema = schema.sql
            .replace(`CREATE TABLE ${tableName}`, `CREATE TABLE ${tableName}_legacy`)
            .replace("'change_review_mode', ", "");
          expect(legacySchema).not.toContain("change_review_mode");
          database.exec(`${legacySchema}; INSERT INTO ${tableName}_legacy SELECT * FROM ${tableName}; DROP TABLE ${tableName}; ALTER TABLE ${tableName}_legacy RENAME TO ${tableName};`);
          for (const index of indexes) database.exec(index.sql);
        }
        downgraded = true;
      } finally {database.close();}
    }
    expect(downgraded).toBe(true);
    worker = await startWorker(persistPath);
    const replay = await publish();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({artifact: {reviewMode: "annotate"}, replayed: true, version: publication.version});
    const content = await worker.fetch(publication.links.version);
    expect(await content.text()).toBe(source);
  }, 30_000);

  it("ART-012: review mode and historical mutation replay survive D1 restart without changing content", async () => {
    const source = "<h1>Immutable review content</h1>";
    const upload = await stageFile(source);
    const committed = await worker.fetch(upload.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "public_link", kind: "new_artifact", name: "Interact review", reviewMode: "interact",
      }}),
      headers: {...authenticatedJsonHeaders(), "Idempotency-Key": "cloudflare-review-mode-publish"},
      method: "POST",
    });
    expect(committed.status).toBe(201);
    const publication = publicationSchema.parse(await committed.json());
    expect(publication.artifact.reviewMode).toBe("interact");
    const changeMode = (reviewMode: "annotate" | "interact", key: string) => worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/review-mode`,
      {
        body: JSON.stringify({expectedCurrentVersionId: publication.version.id, reviewMode}),
        headers: {...authenticatedJsonHeaders(), "Idempotency-Key": key},
        method: "PATCH",
      },
    );
    expect((await changeMode("annotate", "cloudflare-review-mode-first")).status).toBe(200);
    expect((await changeMode("interact", "cloudflare-review-mode-second")).status).toBe(200);
    await worker.stop();
    worker = await startWorker(persistPath);
    const replay = await changeMode("annotate", "cloudflare-review-mode-first");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({artifact: {reviewMode: "annotate"}, replayed: true, version: publication.version});
    const details = await worker.fetch(`${origin}/api/v1/artifacts/${publication.artifact.id}`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({artifact: {reviewMode: "interact"}, current: {version: publication.version}});
    const content = await worker.fetch(publication.links.version);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(source);
    const actions = await worker.fetch(`${origin}/api/v1/artifacts/${publication.artifact.id}/actions`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(actionListSchema.parse(await actions.json()).actions.map(({action}) => action).toSorted())
      .toEqual(["change_review_mode", "change_review_mode", "publish"]);
  }, 30_000);

  it("serves the management application only from its configured origin", async () => {
    const shell = await worker.fetch(`${origin}/review?project=prj_default`);
    const shellHtml = await shell.text();
    if (shell.status !== 200) {
      throw new Error(`Management shell returned ${shell.status}: ${shellHtml}`);
    }
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(shell.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(shell.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(shellHtml).toContain('id="review-root"');

    const scriptPath = /src="(?<path>\/assets\/[^"]+\.js)"/u.exec(shellHtml)
      ?.groups?.["path"];
    if (scriptPath === undefined) {
      throw new Error("The Cloudflare management shell does not reference its script.");
    }
    const script = await worker.fetch(`${origin}${scriptPath}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("cache-control"))
      .toBe("public, max-age=31536000, immutable");

    const missingApi = await worker.fetch(`${origin}/api/v1/not-a-route`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/json");

    const contentHostRoute = await worker.fetch(
      `https://${"a".repeat(40)}.${contentDomain}/projects`,
    );
    expect(contentHostRoute.status).toBe(404);
    expect(contentHostRoute.headers.get("content-type")).toContain(
      "application/json",
    );
  });

  it("publishes through real local D1 and R2 and survives a Worker restart", async () => {
    const health = await worker.fetch(`${origin}/health`);
    const ready = await worker.fetch(`${origin}/ready`);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    const scheduled = await worker.fetch(
      `${origin}/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`,
    );
    expect(scheduled.status).toBe(200);

    const unauthorized = await worker.fetch(`${origin}/api/v1/artifacts`);
    expect(unauthorized.status).toBe(401);

    const historyStatus = await worker.fetch(
      `${origin}/api/v1/projects/prj_default/git-history`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(historyStatus.status).toBe(200);
    expect(projectGitHistorySchema.parse(await historyStatus.json())).toEqual({
      gitHistory: {
        enabled: false,
        projectId: "prj_default",
        state: "disabled",
      },
    });
    const historyEnable = await worker.fetch(
      `${origin}/api/v1/projects/prj_default/git-history`,
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: authenticatedJsonHeaders(),
        method: "PUT",
      },
    );
    expect(historyEnable.status).toBe(501);

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
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
        "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-runtime-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-worker-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
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
