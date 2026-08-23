import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import type {GitHistoryProviderHealthProbe} from
  "../../src/git-history/git-history-provider-health.js";
import type {NodeGitHistoryConfiguration} from
  "../../src/git-history/node-git-history-configuration.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const settingSchema = z.object({
  enabled: z.boolean(),
  projectId: z.string(),
}).strict();
const estimateSchema = z.object({
  estimatedCopiedBytes: z.number().int().nonnegative(),
  estimatedPointerBytes: z.number().int().nonnegative(),
  notice: z.string(),
  operations: z.number().int().nonnegative(),
  projectId: z.string(),
  repositories: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
}).strict();

describe("simple per-project Git history setting", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  test("GIT-012-B GIT-014-B: one project estimates and toggles naturally idempotently while every other project stays off", async () => {
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
    });
    await waitForAvailable(server, installation.apiToken);

    const otherProjectId = await createProject(server, installation, "Other");
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
    });
    expect(await readSetting(server, installation, otherProjectId)).toEqual({
      enabled: false,
      projectId: otherProjectId,
    });

    const content = "Git history planning bytes";
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content,
      idempotencyKey: "git-history-project-estimate",
      projectId: "prj_default",
    });
    const estimate = await readEstimate(server, installation, "prj_default");
    expect(estimate).toMatchObject({
      estimatedCopiedBytes: Buffer.byteLength(content),
      estimatedPointerBytes: 0,
      operations: 2,
      projectId: "prj_default",
      repositories: 1,
      versions: 1,
    });
    expect(estimate.notice).toContain("not an invoice");
    expect(await callMcp(
      server,
      installation.apiToken,
      "project_git_history_estimate",
      {projectId: "prj_default"},
      z.object({estimate: estimateSchema}).strict(),
    )).toEqual({estimate});

    const missingConfirmation = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(missingConfirmation.status).toBe(422);

    expect(await setSetting(server, installation, "prj_default", true)).toEqual({
      enabled: true,
      projectId: "prj_default",
    });
    expect(await setSetting(server, installation, "prj_default", true)).toEqual({
      enabled: true,
      projectId: "prj_default",
    });
    expect(readStoredSettingCount(installation, "prj_default")).toBe(1);
    expect(await readSetting(server, installation, otherProjectId)).toEqual({
      enabled: false,
      projectId: otherProjectId,
    });

    await server.stop();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
    });
    await waitForAvailable(server, installation.apiToken);
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: true,
      projectId: "prj_default",
    });
    expect(await callMcp(
      server,
      installation.apiToken,
      "project_set_git_history",
      {enabled: false, projectId: "prj_default"},
      z.object({gitHistory: settingSchema}).strict(),
    )).toEqual({
      gitHistory: {enabled: false, projectId: "prj_default"},
    });
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
    });
  });

  test("GIT-012-F: an unconfigured deployment cannot estimate or enable, and the default remains off", async () => {
    server = await startTestServer(installation);
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
    });
    const estimate = await fetch(
      new URL(
        "/api/v1/projects/prj_default/git-history/estimate",
        server.baseUrl,
      ),
      {headers: apiHeaders(installation), method: "POST"},
    );
    expect(estimate.status).toBe(501);
    const enable = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(enable.status).toBe(501);
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
    });
  });
});

const availableHealthProbe: GitHistoryProviderHealthProbe = {
  check: () => Effect.succeed({state: "available"}),
};

function configuredGitHistory(): NodeGitHistoryConfiguration {
  return {
    _tag: "CloudflareArtifactsRest",
    apiToken: Redacted.make("project-setting-test-token"),
    capability: {
      limits: {
        fileCopyBytes: defaultGitHistoryFileCopyBytes,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: null,
        versionCopyBytes: defaultGitHistoryVersionCopyBytes,
      },
      provider: "cloudflare-artifacts",
      providerState: "checking",
    },
    identity: {
      accountId: "project-setting-account",
      namespace: "project-setting-namespace",
      provider: "cloudflare-artifacts",
    },
    issues: [],
  };
}

async function waitForAvailable(
  runningServer: RunningTestServer,
  apiToken: string,
): Promise<void> {
  await expect.poll(async () => {
    const response = await fetch(new URL("/api/v1/session", runningServer.baseUrl), {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    const session = z.object({
      capabilities: z.object({
        gitHistory: z.object({providerState: z.string()}).loose(),
      }).loose(),
    }).loose().parse(await response.json());
    return session.capabilities.gitHistory.providerState;
  }, {timeout: 5_000}).toBe("available");
}

async function createProject(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  name: string,
): Promise<string> {
  const response = await fetch(new URL("/api/v1/projects", runningServer.baseUrl), {
    body: JSON.stringify({name}),
    headers: apiHeaders(installation),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({project: z.object({id: z.string()}).loose()})
    .parse(await response.json()).project.id;
}

async function readSetting(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  projectId: string,
) {
  const response = await fetch(new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
    runningServer.baseUrl,
  ), {headers: apiHeaders(installation)});
  expect(response.status).toBe(200);
  return z.object({gitHistory: settingSchema}).strict()
    .parse(await response.json()).gitHistory;
}

async function readEstimate(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  projectId: string,
) {
  const response = await fetch(new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history/estimate`,
    runningServer.baseUrl,
  ), {headers: apiHeaders(installation), method: "POST"});
  expect(response.status).toBe(200);
  return z.object({estimate: estimateSchema}).strict()
    .parse(await response.json()).estimate;
}

async function setSetting(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  projectId: string,
  enabled: boolean,
) {
  const response = await fetch(new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
    runningServer.baseUrl,
  ), {
    body: JSON.stringify(enabled
      ? {confirmEstimate: true, enabled: true}
      : {enabled: false}),
    headers: apiHeaders(installation),
    method: "PUT",
  });
  expect(response.status).toBe(200);
  return z.object({gitHistory: settingSchema}).strict()
    .parse(await response.json()).gitHistory;
}

function readStoredSettingCount(
  installation: TestInstallation,
  projectId: string,
): number {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
  try {
    return z.object({count: z.number().int().nonnegative()}).parse(
      database.prepare(`
        SELECT COUNT(*) AS count FROM git_history_project_settings
        WHERE project_id = ?
      `).get(projectId),
    ).count;
  } finally {
    database.close();
  }
}

function apiHeaders(installation: TestInstallation): Headers {
  return new Headers({
    Authorization: `Bearer ${installation.apiToken}`,
    "Content-Type": "application/json",
  });
}

async function callMcp<T>(
  runningServer: RunningTestServer,
  apiToken: string,
  name: string,
  arguments_: Readonly<Record<string, boolean | string>>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(new URL("/mcp", runningServer.baseUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "git-history-setting-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: arguments_,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const result = z.object({
    result: z.object({structuredContent: z.unknown()}).loose(),
  }).loose().parse(await response.json());
  return schema.parse(result.result.structuredContent);
}
