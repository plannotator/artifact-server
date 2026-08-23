import {writeFile} from "node:fs/promises";
import {once} from "node:events";
import {createServer, type Server} from "node:http";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  loadNodeGitHistoryConfiguration,
  type NodeGitHistoryConfiguration,
} from "../../src/git-history/node-git-history-configuration.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import {CloudflareArtifactsRestHealthProbe} from
  "../../src/git-history/cloudflare-artifacts-rest-health-probe.js";
import {SqliteGitHistoryProviderIdentityStore} from
  "../../src/storage/sqlite-git-history-provider-identity-store.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const gitHistoryCapabilitySchema = z.object({
  limits: z.object({
    fileCopyBytes: z.number().int().nonnegative(),
    logicalCopiedBytes: z.number().int().nonnegative(),
    logicalReservedBytes: z.number().int().nonnegative(),
    storageBudgetBytes: z.number().int().nonnegative().nullable(),
    versionCopyBytes: z.number().int().nonnegative(),
  }).strict(),
  provider: z.literal("cloudflare-artifacts").nullable(),
  providerState: z.enum([
    "disabled",
    "checking",
    "available",
    "degraded",
    "misconfigured",
    "migration-required",
  ]),
}).strict();
type GitHistoryCapabilityProjection = z.infer<typeof gitHistoryCapabilitySchema>;
const persistedProviderIdentitySchema = z.object({
  account_id: z.string(),
  namespace: z.string(),
  provider: z.literal("cloudflare-artifacts"),
}).strict();
type PersistedProviderIdentity = z.infer<typeof persistedProviderIdentitySchema>;
const assignedAddressSchema = z.object({port: z.number().int().positive()});

describe("optional Git handoff configuration and discovery", () => {
  let installation: TestInstallation;
  let providerServer: Server | null = null;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    if (providerServer !== null) await closeHttpServer(providerServer);
    providerServer = null;
    await removeTestInstallation(installation);
  });

  test("GIT-010 GIT-012 GIT-014 foundation: absent and off configurations expose bounded disabled defaults without reading provider companions", async () => {
    const secret = "must-not-be-read-or-reported";
    const absent = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({}),
    );
    expect(absent).toEqual({
      _tag: "Off",
      capability: {
        limits: {
          fileCopyBytes: defaultGitHistoryFileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: defaultGitHistoryVersionCopyBytes,
        },
        provider: null,
        providerState: "disabled",
      },
      issues: [],
    });

    const explicitOff = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN: secret,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE:
          path.join(installation.dataDirectory, "absent-token"),
        ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES: "invalid",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "off",
      }),
    );

    expect(explicitOff.capability).toEqual(absent.capability);
    expect(explicitOff.issues.map((issue) => ({
      field: issue.field,
      reason: issue.reason,
    }))).toEqual([
      {
        field: "ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES",
        reason: "ignored_value",
      },
      {
        field: "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN",
        reason: "ignored_value",
      },
      {
        field: "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE",
        reason: "ignored_value",
      },
    ]);
    expect(JSON.stringify(explicitOff)).not.toContain(secret);
  });

  test("GIT-010 GIT-012 foundation: complete Node REST configuration is parsed, while hostile or malformed families degrade without exposing secrets", async () => {
    const secret = "cloudflare-artifacts-test-token";
    const tokenPath = path.join(installation.dataDirectory, "artifacts-token");
    await writeFile(tokenPath, `${secret}\n`, {mode: 0o600});
    const configured = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: tokenPath,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-dev",
        ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES: "1024",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
        ARTIFACT_SERVER_GIT_HISTORY_STORAGE_BUDGET_BYTES: "8192",
        ARTIFACT_SERVER_GIT_HISTORY_VERSION_COPY_LIMIT_BYTES: "4096",
      }),
    );
    expect(configured._tag).toBe("CloudflareArtifactsRest");
    expect(configured.capability).toEqual({
      limits: {
        fileCopyBytes: 1024,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: 8192,
        versionCopyBytes: 4096,
      },
      provider: "cloudflare-artifacts",
      providerState: "checking",
    });

    const malformed = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN: secret,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: tokenPath,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-dev",
        ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES: "-1",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }),
    );
    expect(malformed._tag).toBe("Misconfigured");
    expect(malformed.capability.providerState).toBe("misconfigured");
    expect(malformed.issues.map((issue) => issue.reason)).toEqual([
      "invalid_value",
      "direct_secret_forbidden",
    ]);
    expect(JSON.stringify(malformed)).not.toContain(secret);

    const unreadable = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE:
          path.join(installation.dataDirectory, "missing-token"),
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-dev",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }),
    );
    expect(unreadable._tag).toBe("Misconfigured");
    expect(unreadable.issues).toEqual([expect.objectContaining({
      field: "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE",
      reason: "secret_unreadable",
    })]);

    const oversizedTokenPath = path.join(
      installation.dataDirectory,
      "oversized-artifacts-token",
    );
    await writeFile(oversizedTokenPath, "x".repeat(4_097), {mode: 0o600});
    const oversized = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-test",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: oversizedTokenPath,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "artifact-server-dev",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }),
    );
    expect(oversized._tag).toBe("Misconfigured");
    expect(oversized.issues).toEqual([expect.objectContaining({
      field: "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE",
      reason: "invalid_value",
    })]);

    const unknown = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN: secret,
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "request-selected-provider",
      }),
    );
    expect(unknown._tag).toBe("Misconfigured");
    expect(unknown.capability.provider).toBeNull();
    expect(unknown.issues).toEqual([expect.objectContaining({
      field: "ARTIFACT_SERVER_GIT_HISTORY_PROVIDER",
      reason: "unsupported_provider",
    })]);
    expect(JSON.stringify(unknown)).not.toContain(secret);
  });

  test("GIT-010 GIT-013 foundation: a successful read-only check persists identity, reports live parity, and rejects a changed destination before another provider call", async () => {
    const provider = await startCloudflareNamespaceApi();
    providerServer = provider.server;
    const tokenPath = path.join(installation.dataDirectory, "artifacts-token");
    await writeFile(tokenPath, "cloudflare-artifacts-test-token\n", {mode: 0o600});
    const gitHistory = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-private",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: tokenPath,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "namespace-private",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }),
    );
    server = await startTestServer(installation, {
      gitHistory,
      gitHistoryHealthProbe: configuredHealthProbe(gitHistory, provider.origin),
    });

    await expect(readSessionCapability(
      server,
      installation.apiToken,
    )).resolves.toMatchObject({providerState: "checking"});
    provider.release();

    await expect.poll(
      async () => (await readSessionCapability(
        server,
        installation.apiToken,
      )).providerState,
      {timeout: 5_000},
    ).toBe("available");

    const readiness = await fetch(new URL("/ready", server.baseUrl));
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toMatchObject({status: "ready"});

    const sessionResponse = await fetch(
      new URL("/api/v1/session", server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(sessionResponse.status).toBe(200);
    const sessionCapability = z.object({
      capabilities: z.object({gitHistory: gitHistoryCapabilitySchema}).loose(),
    }).loose().parse(await sessionResponse.json()).capabilities.gitHistory;
    const mcpCapability = await callCapabilities(server, installation.apiToken);

    expect(sessionCapability).toEqual({
      ...gitHistory.capability,
      providerState: "available",
    });
    expect(mcpCapability).toEqual(sessionCapability);
    expect(provider.requests()).toBe(1);
    const persisted = readPersistedIdentity(installation);
    expect(persisted).toEqual({
      account_id: "account-private",
      namespace: "namespace-private",
      provider: "cloudflare-artifacts",
    });
    expect(JSON.stringify(persisted)).not.toContain(
      "cloudflare-artifacts-test-token",
    );
    const competingStore = new SqliteGitHistoryProviderIdentityStore(
      path.join(installation.dataDirectory, "artifact-server.db"),
      "another-installation",
    );
    try {
      await expect(Effect.runPromise(competingStore.activate({
        activatedAt: "2026-08-23T00:00:00.000Z",
        identity: {
          accountId: persisted.account_id,
          namespace: persisted.namespace,
          provider: persisted.provider,
        },
      }))).resolves.toEqual({_tag: "LocationClaimed"});
    } finally {
      competingStore.close();
    }
    const discoveryJson = JSON.stringify({mcpCapability, sessionCapability});
    expect(discoveryJson).not.toContain("account-private");
    expect(discoveryJson).not.toContain("namespace-private");
    expect(discoveryJson).not.toContain("cloudflare-artifacts-test-token");

    await server.stop();
    server = null;
    const changed = await Effect.runPromise(
      loadNodeGitHistoryConfiguration({
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "account-private",
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: tokenPath,
        ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: "changed-namespace",
        ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
      }),
    );
    const requestsBeforeRestart = provider.requests();
    server = await startTestServer(installation, {
      gitHistory: changed,
      gitHistoryHealthProbe: configuredHealthProbe(changed, provider.origin),
    });
    await expect.poll(
      async () => (await readSessionCapability(
        server,
        installation.apiToken,
      )).providerState,
      {timeout: 5_000},
    ).toBe("migration-required");
    expect(provider.requests()).toBe(requestsBeforeRestart);
    expect(readPersistedIdentity(installation)).toEqual(persisted);
  });
});

function configuredHealthProbe(
  configuration: NodeGitHistoryConfiguration,
  apiOrigin: URL,
): CloudflareArtifactsRestHealthProbe {
  if (configuration._tag !== "CloudflareArtifactsRest") {
    throw new Error("The test requires a complete Cloudflare REST configuration.");
  }
  return new CloudflareArtifactsRestHealthProbe({
    apiOrigin,
    apiToken: configuration.apiToken,
    identity: configuration.identity,
  });
}

async function readSessionCapability(
  runningServer: RunningTestServer | null,
  apiToken: string,
): Promise<GitHistoryCapabilityProjection> {
  if (runningServer === null) throw new Error("The test server is not running.");
  const response = await fetch(
    new URL("/api/v1/session", runningServer.baseUrl),
    {headers: {Authorization: `Bearer ${apiToken}`}},
  );
  return z.object({
    capabilities: z.object({gitHistory: gitHistoryCapabilitySchema}).loose(),
  }).loose().parse(await response.json()).capabilities.gitHistory;
}

function readPersistedIdentity(
  installation: TestInstallation,
): PersistedProviderIdentity {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
  try {
    return persistedProviderIdentitySchema.parse(database.prepare(`
      SELECT provider, account_id, namespace
      FROM git_history_provider_identity
      WHERE installation_id = 'local'
    `).get());
  } finally {
    database.close();
  }
}

async function startCloudflareNamespaceApi(): Promise<{
  readonly origin: URL;
  readonly release: () => void;
  readonly requests: () => number;
  readonly server: Server;
}> {
  let requests = 0;
  let released = false;
  const pendingResponses: Array<() => void> = [];
  const server = createServer((request, response) => {
    requests += 1;
    const respond = (): void => {
      if (
        request.method !== "GET" ||
        request.url !==
          "/client/v4/accounts/account-private/artifacts/namespaces/namespace-private"
      ) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({success: false}));
        return;
      }
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({errors: [], result: {}, success: true}));
    };
    if (released) respond();
    else pendingResponses.push(respond);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = assignedAddressSchema.parse(server.address());
  return {
    origin: new URL(`http://127.0.0.1:${address.port}`),
    release: () => {
      released = true;
      for (const respond of pendingResponses.splice(0)) respond();
    },
    requests: () => requests,
    server,
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function callCapabilities(
  server: RunningTestServer,
  apiToken: string,
): Promise<GitHistoryCapabilityProjection> {
  const response = await fetch(new URL("/mcp", server.baseUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {
            name: "git-history-discovery-test",
            version: "1",
          },
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: {},
        name: "artifact_capabilities",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "artifact_capabilities",
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const result = z.object({
    result: z.object({
      structuredContent: z.object({
        gitHistory: z.unknown(),
      }).loose(),
    }).loose(),
  }).loose().parse(await response.json());
  return gitHistoryCapabilitySchema.parse(
    result.result.structuredContent.gitHistory,
  );
}
