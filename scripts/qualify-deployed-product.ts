import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {z} from "zod";

const executeFile = promisify(execFile);
const protocolVersion = "2026-07-28";
const concurrencyLevels = [1, 10, 25, 50, 100] as const;
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const comparisonSchema = z.object({
  added: z.array(z.unknown()),
  changed: z.array(z.unknown()),
  from: z.object({id: z.string()}),
  removed: z.array(z.unknown()),
  to: z.object({id: z.string()}),
});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})}).loose()),
});
const mcpResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    resultType: z.literal("complete"),
    supportedVersions: z.array(z.string()),
  }).loose(),
});
const targetSchema = z.enum(["aws", "cloudflare", "gcp"]);

interface PerformanceResult {
  readonly concurrentUsers: number;
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly requests: number;
  readonly wallMilliseconds: number;
}

await main();

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const serverOrigin = requiredUrl("ARTIFACT_SERVER_URL");
  const apiToken = requiredEnvironment("ARTIFACT_SERVER_API_TOKEN");
  const target = targetSchema.parse(requiredEnvironment("CLOUD_QUALIFICATION_TARGET"));
  const evidencePath = path.resolve(requiredEnvironment(
    "CLOUD_QUALIFICATION_EVIDENCE_PATH",
  ));
  const fixtureRoot = path.resolve("tests/fixtures/cloud-qualification");
  const artifactName = `cloud-qualification-${target}-${Date.now()}`;

  await assertStatus(new URL("/health", serverOrigin), 200);
  const readiness = await fetch(new URL("/ready", serverOrigin));
  assert(readiness.status === 200, `Readiness returned HTTP ${readiness.status}.`);
  const readinessBody = z.object({
    components: z.object({
      configuration: z.object({status: z.literal("ready")}),
      database: z.object({status: z.literal("ready")}),
      migrations: z.object({status: z.literal("ready")}),
      objectStorage: z.object({status: z.literal("ready")}),
    }),
    lifecycle: z.literal("ready"),
    status: z.literal("ready"),
  }).parse(await readiness.json());

  const first = await publish({
    apiToken,
    cliArguments: [
      path.join(fixtureRoot, "v1"),
      "--server", serverOrigin.origin,
      "--name", artifactName,
      "--public",
      "--tag", "cloud-qualification",
      "--tag", target,
    ],
  });
  const firstBody = await fetchText(first.links.version);
  assert(firstBody.includes("version one"), "Version one returned the wrong bytes.");
  const second = await publish({
    apiToken,
    cliArguments: [
      path.join(fixtureRoot, "v2"),
      "--server", serverOrigin.origin,
      "--artifact", first.artifact.id,
      "--expected-version", first.version.id,
    ],
  });
  assert(first.version.number === 1, "The first publication was not version one.");
  assert(second.version.number === 2, "The second publication was not version two.");
  assert(first.artifact.id === second.artifact.id, "The artifact identity changed.");

  const secondBody = await fetchText(second.links.version);
  assert(secondBody.includes("version two"), "Version two returned the wrong bytes.");
  assert(first.links.version !== second.links.version, "Version URLs are not immutable.");
  await assertStatus(new URL(first.links.version), 401);

  const comparisonUrl = new URL(
    `/api/v1/artifacts/${first.artifact.id}/comparisons`,
    serverOrigin,
  );
  comparisonUrl.searchParams.set("projectId", "prj_default");
  comparisonUrl.searchParams.set("fromVersionId", first.version.id);
  comparisonUrl.searchParams.set("toVersionId", second.version.id);
  const comparison = await authenticatedJson(
    comparisonUrl,
    apiToken,
    comparisonSchema,
  );
  assert(comparison.from.id === first.version.id, "Comparison started at the wrong version.");
  assert(comparison.to.id === second.version.id, "Comparison ended at the wrong version.");
  assert(
    comparison.changed.length > 0 || comparison.added.length > 0 ||
      comparison.removed.length > 0,
    "Comparison reported no changes.",
  );

  const artifactListUrl = new URL("/api/v1/artifacts", serverOrigin);
  artifactListUrl.searchParams.set("projectId", "prj_default");
  artifactListUrl.searchParams.set("tag", "cloud-qualification");
  const artifactPage = await authenticatedJson(
    artifactListUrl,
    apiToken,
    artifactPageSchema,
  );
  assert(
    artifactPage.artifacts.some(({artifact}) => artifact.id === first.artifact.id),
    "The qualification artifact was absent from its tag query.",
  );

  const mcp = await qualifyMcp(serverOrigin, apiToken);
  const performance = await measureConcurrencyLevels(second.links.version);

  const evidence = {
    applicationOrigin: serverOrigin.origin,
    artifact: {
      id: first.artifact.id,
      versionIds: [first.version.id, second.version.id],
      versionOrigins: [
        new URL(first.links.version).origin,
        new URL(second.links.version).origin,
      ],
    },
    completedAt: new Date().toISOString(),
    mcp,
    performance,
    readiness: readinessBody,
    schemaVersion: 1,
    startedAt,
    target,
  };
  await mkdir(path.dirname(evidencePath), {recursive: true});
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    artifactId: first.artifact.id,
    evidencePath,
    target,
    versions: [first.version.id, second.version.id],
  }));
}

async function publish(input: {
  readonly apiToken: string;
  readonly cliArguments: readonly string[];
}): Promise<z.infer<typeof publicationSchema>> {
  const result = await executeFile(
    process.execPath,
    ["dist/cli/main.js", "publish", ...input.cliArguments],
    {
      cwd: process.cwd(),
      env: {...process.env, ARTIFACT_SERVER_API_TOKEN: input.apiToken},
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return publicationSchema.parse(JSON.parse(result.stdout));
}

async function qualifyMcp(
  serverOrigin: URL,
  apiToken: string,
): Promise<{readonly discoveryStatus: number; readonly unauthenticatedStatus: number}> {
  const unauthenticated = await mcpRequest(serverOrigin, null);
  assert(unauthenticated.status === 401, "Unauthenticated MCP did not return 401.");
  const methodResponses = await Promise.all(
    (["GET", "DELETE"] as const).map(async (method) => ({
      method,
      response: await fetch(new URL("/mcp", serverOrigin), {method}),
    })),
  );
  for (const {method, response} of methodResponses) {
    assert(response.status === 405, `MCP ${method} did not return 405.`);
  }
  const discovery = await mcpRequest(serverOrigin, apiToken);
  assert(discovery.status === 200, `MCP discovery returned HTTP ${discovery.status}.`);
  const body = mcpResultSchema.parse(await discovery.json());
  assert(
    body.result.supportedVersions.includes(protocolVersion),
    "MCP discovery omitted the current protocol version.",
  );
  return {
    discoveryStatus: discovery.status,
    unauthenticatedStatus: unauthenticated.status,
  };
}

function mcpRequest(serverOrigin: URL, apiToken: string | null): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Method": "server/discover",
  });
  if (apiToken !== null) headers.set("Authorization", `Bearer ${apiToken}`);
  return fetch(new URL("/mcp", serverOrigin), {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method: "server/discover",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "cloud-qualification", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
      },
    }),
    headers,
    method: "POST",
  });
}

async function measureReads(
  url: string,
  concurrentUsers: number,
): Promise<PerformanceResult> {
  const started = performance.now();
  const measurements = await Promise.all(Array.from(
    {length: concurrentUsers},
    async () => {
      const requestStarted = performance.now();
      const body = await fetchText(url);
      assert(body.includes("version two"), "A performance read returned the wrong bytes.");
      return performance.now() - requestStarted;
    },
  ));
  const ordered = measurements.toSorted((left, right) => left - right);
  return {
    concurrentUsers,
    maximumMilliseconds: round(ordered.at(-1) ?? 0),
    medianMilliseconds: round(ordered[Math.floor(ordered.length / 2)] ?? 0),
    requests: measurements.length,
    wallMilliseconds: round(performance.now() - started),
  };
}

async function measureConcurrencyLevels(url: string): Promise<PerformanceResult[]> {
  const results: PerformanceResult[] = [];
  const visit = async (index: number): Promise<PerformanceResult[]> => {
    const concurrentUsers = concurrencyLevels[index];
    if (concurrentUsers === undefined) return results;
    results.push(await measureReads(url, concurrentUsers));
    return visit(index + 1);
  };
  return visit(0);
}

async function authenticatedJson<Schema extends z.ZodType>(
  url: URL,
  apiToken: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${apiToken}`},
  });
  assert(response.status === 200, `${url.pathname} returned HTTP ${response.status}.`);
  return schema.parse(await response.json());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  assert(response.status === 200, `${new URL(url).pathname} returned HTTP ${response.status}.`);
  return response.text();
}

async function assertStatus(url: URL, expectedStatus: number): Promise<void> {
  const response = await fetch(url);
  assert(response.status === expectedStatus, `${url.pathname} returned HTTP ${response.status}.`);
  await response.body?.cancel();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredUrl(name: string): URL {
  const url = new URL(requiredEnvironment(name));
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  return url;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
