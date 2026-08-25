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
  type GitHistoryLimits,
} from "../../src/git-history/git-history-capability.js";
import {
  applyGitHistoryPurge,
  planGitHistoryPurge,
} from "../../src/git-history/git-history-purge.js";
import {SqliteArtifactRepository} from
  "../../src/storage/sqlite-artifact-repository.js";
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
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {RecordingGitHistoryProvider} from "../support/git-history-provider.js";

const protocolVersion = "2026-07-28";
const settingSchema = z.object({
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
const cloneAccessSchema = z.object({
  defaultBranch: z.literal("main"),
  expiresAt: z.string(),
  remote: z.url(),
  token: z.string(),
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

  test("GIT-008-B GIT-012-B: an explicitly enabled project backfills while every other project stays off", async () => {
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);

    const otherProjectId = await createProject(server, installation, "Other");
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
      state: "disabled",
    });
    expect(await readSetting(server, installation, otherProjectId)).toEqual({
      enabled: false,
      projectId: otherProjectId,
      state: "disabled",
    });

    const content = "Git history planning bytes";
    const published = await publishNew(server, installation, {
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
    expect(provider.createCalls).toBe(0);

    const missingConfirmation = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(missingConfirmation.status).toBe(422);

    const enable = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({
      gitHistory: {enabled: true, projectId: "prj_default"},
    });
    expect(await callMcp(
      server,
      installation.apiToken,
      "project_set_git_history",
      {confirmEstimate: true, enabled: true, projectId: "prj_default"},
      z.object({gitHistory: settingSchema}).strict(),
    )).toMatchObject({
      gitHistory: {enabled: true, projectId: "prj_default"},
    });
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(1);
    expect(provider.createCalls).toBe(1);
    expect(provider.commits.get(published.body.artifact.id)?.has(
      published.body.version.id,
    )).toBe(true);
    expect(await readSetting(server, installation, otherProjectId)).toEqual({
      enabled: false,
      projectId: otherProjectId,
      state: "disabled",
    });
    expect(await callMcp(
      server,
      installation.apiToken,
      "project_set_git_history",
      {enabled: false, projectId: "prj_default"},
      z.object({gitHistory: settingSchema}).strict(),
    )).toEqual({
      gitHistory: {enabled: false, projectId: "prj_default", state: "disabled"},
    });
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
      state: "disabled",
    });

    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "Saved while Git history is disabled",
      idempotencyKey: "git-history-disabled-project-version",
      name: "Disabled history artifact",
      projectId: "prj_default",
    });
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(provider.commitCalls).toBe(1);

    const reenable = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(reenable.status).toBe(200);
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(2);
    expect(provider.createCalls).toBe(2);
  });

  test("foundation: an unconfigured deployment cannot estimate or enable, and the default remains off", async () => {
    server = await startTestServer(installation);
    expect(await readSetting(server, installation, "prj_default")).toEqual({
      enabled: false,
      projectId: "prj_default",
      state: "disabled",
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
      state: "disabled",
    });
  });

  test("GIT-009-F: retrying an already-enabled setting succeeds during a provider outage", async () => {
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    await enableGitHistory(server, installation, "prj_default");
    await server.stop();

    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: degradedHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForProviderState(server, installation.apiToken, "degraded");

    const retry = await fetch(
      new URL("/api/v1/projects/prj_default/git-history", server.baseUrl),
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: apiHeaders(installation),
        method: "PUT",
      },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      gitHistory: {enabled: true, projectId: "prj_default", state: "degraded"},
    });
  });

  test("GIT-002-F GIT-003-F GIT-008-F: a failed mirror resumes after process restart without a duplicate commit", async () => {
    const provider = new RecordingGitHistoryProvider();
    provider.failCommits = 1;
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "Recover this exact version",
      idempotencyKey: "git-history-restart-recovery",
      projectId: "prj_default",
    });
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(1);
    expect(provider.commits.get(published.body.artifact.id)).toBeUndefined();

    await server.stop();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    await expect.poll(() => provider.commitCalls, {timeout: 10_000}).toBe(2);
    expect(provider.commits.get(published.body.artifact.id)?.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(provider.commitCalls).toBe(2);
  });

  test("GIT-005-F GIT-009-B: clone access is authorized and bounded, disablement preserves the repository, and artifact deletion removes it", async () => {
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "Public content does not grant private Git history",
      idempotencyKey: "git-history-clone-access",
      projectId: "prj_default",
    });
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(1);

    const cloneUrl = new URL(
      `/api/v1/projects/prj_default/artifacts/${published.body.artifact.id}/history/clone-token`,
      server.baseUrl,
    );
    const unauthenticated = await fetch(cloneUrl, {
      body: JSON.stringify({ttlSeconds: 60}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    const clone = await fetch(cloneUrl, {
      body: JSON.stringify({ttlSeconds: 60}),
      headers: apiHeaders(installation),
      method: "POST",
    });
    expect(clone.status).toBe(201);
    expect(clone.headers.get("cache-control")).toBe("private, no-store");
    expect(cloneAccessSchema.parse(await clone.json())).toMatchObject({
      defaultBranch: "main",
      remote: `https://git.example.test/${published.body.artifact.id}`,
    });

    await disableGitHistory(server, installation, "prj_default");
    expect(provider.repositories.has(published.body.artifact.id)).toBe(true);
    const disabledClone = await fetch(cloneUrl, {
      body: "{}",
      headers: apiHeaders(installation),
      method: "POST",
    });
    expect(disabledClone.status).toBe(404);
    expect(provider.deleteCalls).toBe(0);

    const deletion = await fetch(
      new URL(`/api/v1/artifacts/${published.body.artifact.id}?project=prj_default`, server.baseUrl),
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: new Headers({
          ...Object.fromEntries(apiHeaders(installation)),
          "Idempotency-Key": "git-history-artifact-delete",
        }),
        method: "DELETE",
      },
    );
    expect(deletion.status).toBe(200);
    await expect.poll(() => provider.deleteCalls, {timeout: 8_000}).toBe(1);
    expect(provider.repositories.has(published.body.artifact.id)).toBe(false);
  });

  test("GIT-004-B GIT-004-F: copy limits produce deterministic files and pointers across retry", async () => {
    const provider = new RecordingGitHistoryProvider();
    provider.failCommits = 1;
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory({
        fileCopyBytes: 5,
        versionCopyBytes: 7,
      }),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    const files = [
      siteFile("a.txt", "aaaa"),
      siteFile("b.txt", "bbbb"),
      siteFile("c.txt", "cccccccc"),
    ];
    const published = await publishSite(
      server,
      installation,
      files,
      "git-history-deterministic-pointers",
    );
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(() => provider.commitCalls, {timeout: 10_000}).toBe(2);

    const attempts = provider.commitRequests.filter((request) =>
      request.metadata.versionId === published.body.version.id
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map(projectCommitPlan)).toEqual([
      {
        files: [{bytes: "aaaa", path: "a.txt"}],
        pointers: [
          {mediaType: "text/plain", path: "b.txt", size: 4},
          {mediaType: "text/plain", path: "c.txt", size: 8},
        ],
      },
      {
        files: [{bytes: "aaaa", path: "a.txt"}],
        pointers: [
          {mediaType: "text/plain", path: "b.txt", size: 4},
          {mediaType: "text/plain", path: "c.txt", size: 8},
        ],
      },
    ]);
    expect(provider.commits.get(published.body.artifact.id)?.size).toBe(1);
  });

  test("GIT-014-B GIT-014-F: a logical budget pauses only Git and resumes after an explicit budget increase", async () => {
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory({storageBudgetBytes: 3}),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    const budgetLimitedServer = server;
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "four",
      idempotencyKey: "git-history-budget-limit",
      projectId: "prj_default",
    });
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(
      () => readSetting(budgetLimitedServer, installation, "prj_default"),
      {timeout: 8_000},
    ).toMatchObject({state: "budget-limited"});
    expect(provider.createCalls).toBe(0);
    expect(provider.commitCalls).toBe(0);

    const primary = await fetch(new URL(
      `/api/v1/artifacts/${published.body.artifact.id}?projectId=prj_default`,
      server.baseUrl,
    ), {headers: apiHeaders(installation)});
    expect(primary.status).toBe(200);
    expect(await primary.json()).toMatchObject({
      artifact: {currentVersionId: published.body.version.id},
    });

    await server.stop();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory({storageBudgetBytes: 10}),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    await disableGitHistory(server, installation, "prj_default");
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(1);
    expect(await readSetting(server, installation, "prj_default")).toMatchObject({
      state: "ready",
    });
  });

  test("GIT-011-B GIT-011-F: purge plans without provider access and resumes after partial deletion", async () => {
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
    await waitForAvailable(server, installation.apiToken);
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "first purge artifact",
      idempotencyKey: "git-history-purge-one",
      name: "Purge one",
      projectId: "prj_default",
    });
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "second purge artifact",
      idempotencyKey: "git-history-purge-two",
      name: "Purge two",
      projectId: "prj_default",
    });
    await enableGitHistory(server, installation, "prj_default");
    await expect.poll(() => provider.commitCalls, {timeout: 8_000}).toBe(2);
    await server.stop();
    server = null;

    const store = new SqliteArtifactRepository(
      `${installation.dataDirectory}/artifact-server.db`,
      "local",
    );
    const identity = configuredGitHistory().identity;
    try {
      expect(await planGitHistoryPurge({
        installationId: "local",
        persistedIdentity: identity,
        store,
      })).toMatchObject({
        alreadyDeletedRepositories: 0,
        enabledProjects: 1,
        repositories: 2,
        repositoriesToDelete: 2,
      });
      expect(provider.deleteCalls).toBe(0);

      await expect(applyGitHistoryPurge({
        configuredIdentity: identity,
        confirmInstallationId: "local",
        installationId: "local",
        persistedIdentity: identity,
        provider,
        store,
      })).rejects.toThrow("Disable Git history");
      expect(provider.deleteCalls).toBe(0);
      await store.storeProjectGitHistorySetting({
        enabled: false,
        limits: configuredGitHistory().capability.limits,
        projectId: "prj_default",
        updatedAt: new Date().toISOString(),
        updatedByPrincipalId: "test-purge-operator",
      });

      await expect(applyGitHistoryPurge({
        configuredIdentity: identity,
        confirmInstallationId: "wrong-installation",
        installationId: "local",
        persistedIdentity: identity,
        provider,
        store,
      })).rejects.toThrow("confirmation");
      expect(provider.deleteCalls).toBe(0);

      provider.failDeleteCalls.add(2);
      await expect(applyGitHistoryPurge({
        configuredIdentity: identity,
        confirmInstallationId: "local",
        installationId: "local",
        pageSize: 1,
        persistedIdentity: identity,
        provider,
        store,
      })).rejects.toThrow("test-provider-delete-failure");
      expect((await store.readGitHistoryPurgePlan()).repositoriesToDelete).toBe(1);

      const resumed = await applyGitHistoryPurge({
        configuredIdentity: identity,
        confirmInstallationId: "local",
        installationId: "local",
        pageSize: 1,
        persistedIdentity: identity,
        provider,
        store,
      });
      expect(resumed).toMatchObject({
        alreadyDeletedRepositories: 2,
        deletedDuringRun: 1,
        repositoriesToDelete: 0,
      });
      expect(provider.repositories.size).toBe(0);
    } finally {
      store.close();
    }
  });
});

const availableHealthProbe: GitHistoryProviderHealthProbe = {
  check: () => Effect.succeed({state: "available"}),
};
const degradedHealthProbe: GitHistoryProviderHealthProbe = {
  check: () => Effect.succeed({reason: "provider_unavailable", state: "degraded"}),
};

function configuredGitHistory(
  limits: Partial<Pick<
    GitHistoryLimits,
    "fileCopyBytes" | "storageBudgetBytes" | "versionCopyBytes"
  >> = {},
): Extract<NodeGitHistoryConfiguration, {readonly _tag: "CloudflareArtifactsRest"}> {
  return {
    _tag: "CloudflareArtifactsRest",
    apiToken: Redacted.make("project-setting-test-token"),
    capability: {
      limits: {
        fileCopyBytes: limits.fileCopyBytes ?? defaultGitHistoryFileCopyBytes,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: limits.storageBudgetBytes ?? null,
        versionCopyBytes: limits.versionCopyBytes ?? defaultGitHistoryVersionCopyBytes,
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

function siteFile(filePath: string, content: string): TestSiteFile {
  return {
    bytes: new TextEncoder().encode(content),
    mediaType: "text/plain",
    path: filePath,
  };
}

async function publishSite(
  runningServer: RunningTestServer,
  currentInstallation: TestInstallation,
  files: readonly TestSiteFile[],
  idempotencyKey: string,
) {
  const upload = await createStagedUpload(
    runningServer,
    currentInstallation,
    files[0]?.path ?? "index.html",
    files,
    "prj_default",
  );
  const responses = await uploadEveryStagedFile(
    currentInstallation,
    upload.body,
    files,
  );
  expect(responses.every((response) => response.ok)).toBe(true);
  return commitStagedUpload(
    currentInstallation,
    upload.body,
    idempotencyKey,
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Deterministic pointer artifact",
    },
  );
}

function projectCommitPlan(request: RecordingGitHistoryProvider["commitRequests"][number]) {
  return {
    files: request.files.map((file) => ({
      bytes: new TextDecoder().decode(file.bytes),
      path: file.path,
    })),
    pointers: request.pointers.map((pointer) => ({
      mediaType: pointer.mediaType,
      path: pointer.path,
      size: pointer.size,
    })),
  };
}

async function waitForAvailable(
  runningServer: RunningTestServer,
  apiToken: string,
): Promise<void> {
  return waitForProviderState(runningServer, apiToken, "available");
}

async function waitForProviderState(
  runningServer: RunningTestServer,
  apiToken: string,
  providerState: string,
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
  }, {timeout: 5_000}).toBe(providerState);
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

async function enableGitHistory(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  projectId: string,
): Promise<void> {
  const response = await fetch(new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
    runningServer.baseUrl,
  ), {
    body: JSON.stringify({confirmEstimate: true, enabled: true}),
    headers: apiHeaders(installation),
    method: "PUT",
  });
  expect(response.status).toBe(200);
}

async function disableGitHistory(
  runningServer: RunningTestServer,
  installation: TestInstallation,
  projectId: string,
): Promise<void> {
  const response = await fetch(new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
    runningServer.baseUrl,
  ), {
    body: JSON.stringify({enabled: false}),
    headers: apiHeaders(installation),
    method: "PUT",
  });
  expect(response.status).toBe(200);
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
