import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const uploadPlanSchema = z.object({
  expiresAt: z.string(),
  files: z.array(z.object({uploadUrl: z.url()})).length(1),
  uploadId: z.string(),
});

await main();

async function main(): Promise<void> {
  const serverOrigin = requiredUrl("ARTIFACT_SERVER_URL");
  const apiToken = requiredEnvironment("ARTIFACT_SERVER_API_TOKEN");
  const target = z.enum(["aws", "cloudflare", "gcp"]).parse(
    requiredEnvironment("CLOUD_QUALIFICATION_TARGET"),
  );
  const evidencePath = path.resolve(requiredEnvironment(
    "CLOUD_QUALIFICATION_EVIDENCE_PATH",
  ));
  const bytes = new TextEncoder().encode(`abandoned ${target} Phase 11 upload`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const planned = await fetch(new URL("/api/v1/uploads", serverOrigin), {
    body: JSON.stringify({
      entryPath: "abandoned.txt",
      files: [{
        mediaType: "text/plain; charset=utf-8",
        path: "abandoned.txt",
        sha256: digest,
        size: bytes.byteLength,
      }],
      routingMode: "static",
    }),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  assert(planned.status === 201, `Upload plan returned HTTP ${planned.status}.`);
  const plan = uploadPlanSchema.parse(await planned.json());
  const file = plan.files[0];
  if (file === undefined) throw new Error("Upload plan returned no file.");
  const uploaded = await fetch(file.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${apiToken}`},
    method: "PUT",
  });
  assert(uploaded.status === 200, `Staged upload returned HTTP ${uploaded.status}.`);
  await uploaded.arrayBuffer();

  const evidence = {
    createdAt: new Date().toISOString(),
    expiresAt: plan.expiresAt,
    schemaVersion: 1,
    target,
    uploadId: plan.uploadId,
  };
  await mkdir(path.dirname(evidencePath), {recursive: true});
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({evidencePath, target, uploadId: plan.uploadId}));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name: string): URL {
  const value = new URL(requiredEnvironment(name));
  if (value.protocol !== "https:") throw new Error(`${name} must use HTTPS.`);
  return value;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
