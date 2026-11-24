import {execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {lstat, readdir, readFile, readlink} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {z} from "zod";

import type {RunningTestServer, TestInstallation} from "./runtime-harness.js";

/** Shared real-boundary helpers for the linked-folder (LFD) conformance suites. */

export const defaultProject = "prj_default";
const runFile = promisify(execFile);

export const folderLinkSchema = z.object({
  createdAt: z.string(),
  entryCount: z.number().int(),
  folderId: z.string(),
  id: z.string(),
  ignore: z.array(z.string()),
  ignoredCount: z.number().int(),
  inTrash: z.boolean(),
  lastScanCompletedAt: z.string().nullable(),
  lastScanStartedAt: z.string().nullable(),
  overLimitReason: z.enum(["entries", "ignore-file"]).nullable(),
  path: z.string(),
  paused: z.boolean(),
  pendingCount: z.number().int(),
  projectId: z.string(),
  revision: z.number().int(),
  scanActivity: z.enum(["idle", "queued", "scanning"]),
  skippedCount: z.number().int(),
  state: z.enum(["active", "paused", "unavailable", "over-limit"]),
}).strict();
export type FolderLink = z.infer<typeof folderLinkSchema>;
export const folderLinkResultSchema = z.object({folderLink: folderLinkSchema}).strict();

export const inventoryEntrySchema = z.object({
  artifactId: z.string().nullable(),
  freshness: z.enum(["in-sync", "modified", "missing", "unreadable"]).nullable(),
  id: z.string(),
  observedAt: z.string(),
  pending: z.boolean(),
  relativePath: z.string(),
  size: z.number().int().nullable(),
  skipReason: z.string().nullable(),
  state: z.enum(["untracked", "tracked", "skipped"]),
}).strict();
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
const inventoryPageSchema = z.object({
  entries: z.array(inventoryEntrySchema),
  nextCursor: z.string().nullable(),
}).strict();

export const captureResultSchema = z.object({
  artifactId: z.string().nullable(),
  code: z.string().nullable(),
  entryId: z.string(),
  message: z.string().nullable(),
  relativePath: z.string().nullable(),
  status: z.enum(["captured", "unchanged", "refused"]),
  versionId: z.string().nullable(),
}).strict();
export const captureResponseSchema = z.object({results: z.array(captureResultSchema)}).strict();

export const errorSchema = z.object({error: z.object({code: z.string(), message: z.string()}).loose()}).loose();
const toolEnvelope = z.object({
  result: z.object({isError: z.boolean().optional(), structuredContent: z.json()}),
});

type Json = z.infer<ReturnType<typeof z.json>>;

/** One authenticated client for the linked-folder HTTP surface. */
export class LinkedFolderClient {
  readonly server: RunningTestServer;
  readonly token: string;

  constructor(server: RunningTestServer, token: string) {
    this.server = server;
    this.token = token;
  }

  async request(pathname: string, method = "GET", body?: Json, key: string = randomUUID()): Promise<Response> {
    const headers = new Headers({Authorization: `Bearer ${this.token}`, "Idempotency-Key": key});
    const init: RequestInit = {headers, method};
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    return fetch(new URL(pathname, this.server.baseUrl), init);
  }

  async link(directory: string, options: {
    readonly folderId?: string;
    readonly ignore?: readonly string[];
    readonly key?: string;
    readonly name?: string;
  } = {}): Promise<Response> {
    return this.request(`/api/v1/projects/${defaultProject}/folder-links`, "POST", {
      folderId: options.folderId ?? null,
      ignore: [...(options.ignore ?? [])],
      newFolderName: options.name ?? null,
      path: directory,
    }, options.key);
  }

  async linkOk(directory: string, options: Parameters<LinkedFolderClient["link"]>[1] = {}): Promise<FolderLink> {
    const response = await this.link(directory, options);
    if (response.status !== 201) throw new Error(`link answered ${response.status}: ${await response.text()}`);
    return folderLinkResultSchema.parse(await response.json()).folderLink;
  }

  async get(id: string): Promise<FolderLink> {
    const response = await this.request(`/api/v1/folder-links/${id}`);
    if (response.status !== 200) throw new Error(`get answered ${response.status}: ${await response.text()}`);
    return folderLinkResultSchema.parse(await response.json()).folderLink;
  }

  async scan(id: string): Promise<FolderLink> {
    const response = await this.request(`/api/v1/folder-links/${id}/scan`, "POST");
    if (response.status !== 200) throw new Error(`scan answered ${response.status}: ${await response.text()}`);
    return folderLinkResultSchema.parse(await response.json()).folderLink;
  }

  async update(id: string, body: {readonly expectedRevision: number; readonly paused?: boolean; readonly ignore?: readonly string[]}) {
    let payload: Json = {expectedRevision: body.expectedRevision};
    if (body.paused !== undefined) payload = {...payload, paused: body.paused};
    if (body.ignore !== undefined) payload = {...payload, ignore: [...body.ignore]};
    const response = await this.request(`/api/v1/folder-links/${id}`, "PATCH", payload);
    if (response.status !== 200) throw new Error(`update answered ${response.status}: ${await response.text()}`);
    return folderLinkResultSchema.parse(await response.json()).folderLink;
  }

  async inventory(id: string, query = ""): Promise<readonly InventoryEntry[]> {
    const entries: InventoryEntry[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(query);
      params.set("limit", "500");
      if (cursor !== null) params.set("cursor", cursor);
      // Pages must be read in cursor order.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.request(`/api/v1/folder-links/${id}/inventory?${params}`);
      if (response.status !== 200) throw new Error(`inventory answered ${response.status}`);
      // eslint-disable-next-line no-await-in-loop
      const page = inventoryPageSchema.parse(await response.json());
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return entries;
  }

  async capture(id: string, body: {readonly all: true} | {readonly entryIds: readonly string[]}, key: string = randomUUID()) {
    const payload: Json = "all" in body ? {all: true} : {entryIds: [...body.entryIds]};
    return this.request(`/api/v1/folder-links/${id}/capture`, "POST", payload, key);
  }

  async captureOk(id: string, body: Parameters<LinkedFolderClient["capture"]>[1], key?: string) {
    const response = await this.capture(id, body, key);
    if (response.status !== 200) throw new Error(`capture answered ${response.status}: ${await response.text()}`);
    return captureResponseSchema.parse(await response.json()).results;
  }

  async tool(name: string, args: Json) {
    const protocol = "2026-07-28";
    const response = await fetch(`${this.server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: randomUUID(), jsonrpc: "2.0", method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "linked-folder-tests", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocol,
          },
          arguments: args,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocol,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    if (response.status !== 200) throw new Error(`MCP answered ${response.status}`);
    return toolEnvelope.parse(await response.json()).result;
  }

  async cli(tokenFile: string, ...args: readonly string[]): Promise<Json> {
    const {stdout} = await runFile(process.execPath, [
      "--import", "tsx", "src/cli/main.ts", ...args, "--server", this.server.baseUrl, "--token-file", tokenFile,
    ]);
    return z.json().parse(JSON.parse(stdout));
  }
}

/** Poll until a condition holds or the deadline passes. */
export async function waitFor<A>(
  probe: () => Promise<A>,
  accept: (value: A) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<A> {
  const deadline = Date.now() + timeoutMilliseconds;
  let last = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not reached in time; last value: ${JSON.stringify(last)}`);
    }
    // Polling is sequential by design.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
    // eslint-disable-next-line no-await-in-loop
    last = await probe();
  }
  return last;
}

/** Open the installation database directly for observation or fixture faults. */
export function withDatabase<A>(installation: TestInstallation, use: (database: DatabaseSync) => A): A {
  const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"), {timeout: 5_000});
  try {
    return use(database);
  } finally {
    database.close();
  }
}

const countSchema = z.object({count: z.number().int()});

/** Count rows in the history tables observation must never touch. */
export function historyCounts(installation: TestInstallation) {
  return withDatabase(installation, (database) => Object.fromEntries(
    ["artifacts", "versions", "actions", "folders", "folder_actions"].map((table) => [
      table,
      countSchema.parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count,
    ]),
  ));
}

/**
 * Hash a whole directory tree without following symlinks: names, kinds,
 * modes, sizes, modification times, file bytes, and symlink targets.
 */
export async function treeHash(root: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (directory: string, relative: string): Promise<void> => {
    const names = (await readdir(directory)).toSorted();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const child = relative === "" ? name : `${relative}/${name}`;
      // The walk is ordered so the digest is deterministic.
      // eslint-disable-next-line no-await-in-loop
      const stats = await lstat(absolute, {bigint: true});
      digest.update(`${child}\0${stats.mode}\0${stats.size}\0${stats.mtimeNs}\0`);
      if (stats.isSymbolicLink()) {
        // eslint-disable-next-line no-await-in-loop
        digest.update(await readlink(absolute));
      } else if (stats.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await visit(absolute, child);
      } else if (stats.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        digest.update(await readFile(absolute));
      }
    }
  };
  await visit(root, "");
  return digest.digest("hex");
}

/** Expect one coded failure. */
export async function expectFailure(response: Response, status: number, code: string): Promise<string> {
  const raw = await response.text();
  if (response.status !== status) throw new Error(`expected ${status} ${code}, got ${response.status}: ${raw}`);
  const parsed = errorSchema.parse(JSON.parse(raw));
  if (parsed.error.code !== code) throw new Error(`expected ${code}, got ${parsed.error.code}`);
  return raw;
}
