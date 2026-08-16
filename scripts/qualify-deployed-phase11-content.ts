import {execFile} from "node:child_process";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {request} from "node:https";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {z} from "zod";

const executeFile = promisify(execFile);
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  links: z.object({version: z.url()}),
  version: z.object({id: z.string(), routingMode: z.enum(["spa", "static"])}),
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
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "artifact-server-phase11-"));

  try {
    const staticDirectory = path.join(fixtureRoot, "static");
    const spaDirectory = path.join(fixtureRoot, "spa");
    const mediaPath = path.join(fixtureRoot, "clip.mp4");
    const mediaBytes = new Uint8Array([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    await Promise.all([
      mkdir(path.join(staticDirectory, "assets"), {recursive: true}),
      mkdir(path.join(spaDirectory, "assets"), {recursive: true}),
    ]);
    await Promise.all([
      writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Static qualification</title>"),
      writeFile(path.join(staticDirectory, "assets", "app.js"), "globalThis.staticExact = true;"),
      writeFile(path.join(spaDirectory, "index.html"), "<!doctype html><title>SPA qualification</title>"),
      writeFile(path.join(spaDirectory, "assets", "app.js"), "globalThis.spaExact = true;"),
      writeFile(mediaPath, mediaBytes),
    ]);

    const staticPublication = await publish({
      apiToken,
      inputPath: staticDirectory,
      name: `phase11-static-${target}-${Date.now()}`,
      routingMode: "static",
      serverOrigin,
    });
    const spaPublication = await publish({
      apiToken,
      inputPath: spaDirectory,
      name: `phase11-spa-${target}-${Date.now()}`,
      routingMode: "spa",
      serverOrigin,
    });
    const mediaPublication = await publish({
      apiToken,
      inputPath: mediaPath,
      name: `phase11-media-${target}-${Date.now()}`,
      routingMode: "static",
      serverOrigin,
    });

    const routing = await qualifyRouting(staticPublication, spaPublication);
    const ranges = await qualifyRanges(mediaPublication, mediaBytes);
    const evidence = {
      artifacts: {
        media: identity(mediaPublication),
        spa: identity(spaPublication),
        static: identity(staticPublication),
      },
      completedAt: new Date().toISOString(),
      ranges,
      routing,
      schemaVersion: 1,
      target,
    };
    await mkdir(path.dirname(evidencePath), {recursive: true});
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({evidencePath, target}));
  } finally {
    await rm(fixtureRoot, {force: true, recursive: true});
  }
}

async function qualifyRouting(
  staticPublication: Publication,
  spaPublication: Publication,
): Promise<Record<string, number>> {
  assert(staticPublication.version.routingMode === "static", "Static routing was not saved.");
  assert(spaPublication.version.routingMode === "spa", "SPA routing was not saved.");

  const staticMissing = await rawGet(versionUrl(staticPublication, "/missing/page"),
    documentHeaders());
  const spaNavigation = await rawGet(versionUrl(spaPublication, "/settings/profile"),
    documentHeaders());
  const spaExactAsset = await rawGet(versionUrl(spaPublication, "/assets/app.js"), {});
  const spaMissingAsset = await rawGet(
    versionUrl(spaPublication, "/assets/missing.js"),
    {Accept: "text/javascript", "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "cors"},
  );

  assert(staticMissing.status === 404, `Static missing path returned ${staticMissing.status}.`);
  assert(spaNavigation.status === 200, `SPA navigation returned ${spaNavigation.status}.`);
  assert(spaNavigation.body.includes("SPA qualification"), "SPA fallback returned wrong bytes.");
  assert(spaExactAsset.status === 200, `SPA exact asset returned ${spaExactAsset.status}.`);
  assert(spaExactAsset.body.includes("spaExact"), "SPA exact asset returned wrong bytes.");
  assert(spaMissingAsset.status === 404, `SPA missing asset returned ${spaMissingAsset.status}.`);

  return {
    spaExactAsset: spaExactAsset.status,
    spaMissingAsset: spaMissingAsset.status,
    spaNavigation: spaNavigation.status,
    staticMissing: staticMissing.status,
  };
}

async function qualifyRanges(
  publication: Publication,
  mediaBytes: Uint8Array,
): Promise<Record<string, number | string>> {
  const full = await fetch(publication.links.version);
  assert(full.status === 200, `Full media request returned ${full.status}.`);
  const etag = requiredHeader(full, "etag");
  assertBytes(new Uint8Array(await full.arrayBuffer()), mediaBytes, "full media");

  const partial = await fetch(publication.links.version, {headers: {Range: "bytes=4-9"}});
  assert(partial.status === 206, `Media range returned ${partial.status}.`);
  assert(requiredHeader(partial, "content-range") === "bytes 4-9/16", "Media range was wrong.");
  assert(requiredHeader(partial, "content-length") === "6", "Media range length was wrong.");
  assertBytes(new Uint8Array(await partial.arrayBuffer()), mediaBytes.slice(4, 10), "media range");

  const head = await fetch(publication.links.version, {
    headers: {Range: "bytes=10-"},
    method: "HEAD",
  });
  assert(head.status === 206, `Ranged HEAD returned ${head.status}.`);
  assert(requiredHeader(head, "content-length") === "6", "Ranged HEAD length was wrong.");
  assert((await head.arrayBuffer()).byteLength === 0, "Ranged HEAD returned a body.");

  const notModified = await fetch(publication.links.version, {
    headers: {"If-None-Match": etag, Range: "bytes=0-1"},
  });
  assert(notModified.status === 304, `Conditional range returned ${notModified.status}.`);

  const invalid = await fetch(publication.links.version, {
    headers: {Range: "bytes=0-1,4-5"},
  });
  assert(invalid.status === 416, `Multiple range returned ${invalid.status}.`);
  assert(requiredHeader(invalid, "content-range") === "bytes */16", "Invalid range size was wrong.");
  await invalid.arrayBuffer();

  return {
    etag,
    full: full.status,
    head: head.status,
    invalid: invalid.status,
    notModified: notModified.status,
    partial: partial.status,
  };
}

interface PublishInput {
  readonly apiToken: string;
  readonly inputPath: string;
  readonly name: string;
  readonly routingMode: "spa" | "static";
  readonly serverOrigin: URL;
}

type Publication = z.infer<typeof publicationSchema>;

interface PublicationIdentity {
  readonly artifactId: string;
  readonly versionId: string;
  readonly versionOrigin: string;
}

async function publish(input: PublishInput): Promise<Publication> {
  const result = await executeFile(process.execPath, [
    "dist/cli/main.js",
    "publish",
    input.inputPath,
    "--server",
    input.serverOrigin.origin,
    "--name",
    input.name,
    "--public",
    "--routing",
    input.routingMode,
    "--tag",
    "phase11-qualification",
  ], {
    cwd: process.cwd(),
    env: {...process.env, ARTIFACT_SERVER_API_TOKEN: input.apiToken},
    maxBuffer: 2 * 1024 * 1024,
  });
  return publicationSchema.parse(JSON.parse(result.stdout));
}

function identity(publication: Publication): PublicationIdentity {
  return {
    artifactId: publication.artifact.id,
    versionId: publication.version.id,
    versionOrigin: new URL(publication.links.version).origin,
  };
}

function versionUrl(publication: Publication, pathname: string): URL {
  return new URL(pathname, publication.links.version);
}

function documentHeaders() {
  return {
    Accept: "text/html",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
  };
}

interface RawHttpResponse {
  readonly body: string;
  readonly status: number;
}

function rawGet(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {headers, method: "GET"}, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        status: response.statusCode ?? 0,
      }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
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

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`HTTP ${response.status} omitted ${name}.`);
  return value;
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  assert(actual.byteLength === expected.byteLength, `${label} returned the wrong length.`);
  assert(actual.every((value, index) => value === expected[index]), `${label} returned wrong bytes.`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
