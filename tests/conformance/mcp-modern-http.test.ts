import {createHash} from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {
  AuthenticationRequired,
  IdentityRepositoryFailure,
} from "../../src/core/errors.js";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const jsonRpcResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({resultType: z.literal("complete")}).loose(),
});
const toolCallResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    resultType: z.literal("complete"),
    structuredContent: z.unknown(),
  }).loose(),
});
const uploadPlanSchema = z.object({
  authorization: z.object({
    credential: z.literal("reuse_the_mcp_bearer_credential"),
    scheme: z.literal("Bearer"),
  }),
  method: z.literal("PUT"),
  path: z.string(),
  size: z.number().int().nonnegative(),
  uploadUrl: z.url(),
});
const createUploadResultSchema = z.object({
  files: z.array(uploadPlanSchema).min(1),
  manifestDigest: z.string(),
  uploadId: z.string(),
});
const publicationResultSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  replayed: z.boolean(),
  version: z.object({id: z.string()}).loose(),
});

describe("modern MCP HTTP", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("MCP-001-B MCP-001-F MCP-002-B MCP-002-F MCP-003-B MCP-003-F MCP-004-B MCP-004-F MCP-005-B MCP-005-F: modern discovery is authenticated, stateless, and exact", async () => {
    expect.hasAssertions();
    const methodResponses = await Promise.all(
      ["GET", "DELETE"].map((method) =>
        fetch(`${server.baseUrl}/mcp`, {method})
      ),
    );
    for (const response of methodResponses) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }

    const missing = await mcpRequest(server, null, "server/discover", {});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).not.toContain(
      "resource_metadata",
    );
    const invalid = await mcpRequest(server, "invalid-token", "server/discover", {});
    expect(invalid.status).toBe(401);
    const hostileOrigin = await mcpRequest(
      server,
      installation.apiToken,
      "server/discover",
      {},
      {Origin: "https://attacker.example"},
    );
    expect(hostileOrigin.status).toBe(403);

    const discovery = await mcpRequest(
      server,
      installation.apiToken,
      "server/discover",
      {},
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.has("mcp-session-id")).toBe(false);
    const discoveryBody = jsonRpcResultSchema.parse(await discovery.json());
    const discoveryResult = z.object({
      cacheScope: z.literal("private"),
      instructions: z.string(),
      supportedVersions: z.array(z.string()),
      ttlMs: z.number().int().nonnegative(),
    }).loose().parse(discoveryBody.result);
    expect(discoveryResult.supportedVersions).toEqual([protocolVersion]);
    expect(discoveryResult.instructions).toContain("artifact_create_upload");
    expect(discoveryResult.instructions).toContain("actual files");
    expect(discoveryBody.result).not.toHaveProperty("capabilities.subscriptions");

    const listed = await mcpRequest(
      server,
      installation.apiToken,
      "tools/list",
      {},
    );
    const listedBody = jsonRpcResultSchema.parse(await listed.json());
    const tools = z.object({
      tools: z.array(z.object({
        annotations: z.object({
          destructiveHint: z.boolean(),
          idempotentHint: z.boolean(),
          openWorldHint: z.boolean(),
          readOnlyHint: z.boolean(),
        }),
        description: z.string(),
        name: z.string(),
      }).loose()),
    }).loose().parse(listedBody.result).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "artifact_capabilities",
      "project_list",
      "project_create",
      "project_rename",
      "project_archive",
      "project_unarchive",
      "artifact_list",
      "artifact_get",
      "artifact_open",
      "artifact_version_list",
      "artifact_diff",
      "artifact_create_upload",
      "artifact_commit_upload",
      "artifact_set_visibility",
      "artifact_set_tags",
      "artifact_change_owner",
      "artifact_restore_version",
      "artifact_delete",
    ]);
    expect(tools.some((tool) => tool.name.includes("inline"))).toBe(false);
    expect(tools.find((tool) => tool.name === "artifact_delete")?.annotations)
      .toMatchObject({destructiveHint: true, readOnlyHint: false});

    const capabilities = z.object({
      deployment: z.object({mode: z.literal("local")}),
      publishing: z.object({
        acceptsInlineContent: z.literal(false),
        localPathTool: z.literal(false),
        maximumDeclaredFiles: z.number().int().positive(),
        maximumUploadPlanRequestBytes: z.number().int().positive(),
        workflow: z.array(z.string()).min(1),
      }),
      sharing: z.object({
        modes: z.tuple([
          z.literal("account_required"),
          z.literal("public_link"),
        ]),
      }),
    }).parse((await callTool(server, installation.apiToken, {
      arguments: {},
      name: "artifact_capabilities",
    })).structuredContent);
    expect(capabilities.publishing.maximumDeclaredFiles).toBe(10_000);

    const templatesResponse = await mcpRequest(
      server,
      installation.apiToken,
      "resources/templates/list",
      {},
    );
    expect(templatesResponse.status).toBe(200);
    const templatesBody = jsonRpcResultSchema.parse(await templatesResponse.json());
    const templates = z.object({
      resourceTemplates: z.array(z.object({
        name: z.string(),
        uriTemplate: z.string(),
      }).loose()),
    }).loose().parse(templatesBody.result).resourceTemplates;
    expect(templates).toContainEqual(expect.objectContaining({
      name: "artifact-version-manifest",
      uriTemplate:
        "artifact://projects/{projectId}/artifacts/{artifactId}/versions/{versionId}/manifest",
    }));

    const mismatchedName = await mcpRequest(
      server,
      installation.apiToken,
      "tools/call",
      {arguments: {}, name: "artifact_capabilities"},
      {"Mcp-Name": "artifact_get"},
    );
    expect(mismatchedName.status).toBe(400);

    const oversized = await fetch(`${server.baseUrl}/mcp`, {
      body: "x".repeat(16 * 1_024 * 1_024 + 1),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(oversized.status).toBe(413);

    const officialClient = new Client(
      {name: "artifact-server-official-client-test", version: "1"},
      {versionNegotiation: {mode: {pin: protocolVersion}}},
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${server.baseUrl}/mcp`),
      {authProvider: {token: async () => installation.apiToken}},
    );
    try {
      await officialClient.connect(transport);
      const officialTools = await officialClient.listTools();
      expect(officialTools.tools.map(({name}) => name)).toEqual(
        tools.map(({name}) => name),
      );
      const officialCapabilities = await officialClient.callTool({
        arguments: {},
        name: "artifact_capabilities",
      });
      expect(officialCapabilities.isError).not.toBe(true);
      expect(officialCapabilities.structuredContent).toMatchObject({
        deployment: {mode: "local"},
        publishing: {acceptsInlineContent: false},
      });
    } finally {
      await officialClient.close();
    }

    const legacy = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 99,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: {name: "legacy-probe", version: "1"},
          protocolVersion: "2025-11-25",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(legacy.status).toBeGreaterThanOrEqual(400);

    const listen = await mcpRequest(
      server,
      installation.apiToken,
      "subscriptions/listen",
      {notifications: {toolsListChanged: true}},
    );
    expect(listen.status).toBe(200);
    expect(listen.headers.get("content-type")).toContain("application/json");
    const listenBody = z.object({
      error: z.object({code: z.literal(-32_603), message: z.string()}),
      id: z.union([z.string(), z.number()]),
      jsonrpc: z.literal("2.0"),
    }).parse(await listen.json());
    expect(listenBody.error.message).toContain("Subscription limit");
  });

  test("MCP-006-B MCP-006-F MCP-007-B MCP-007-F MCP-008-B MCP-008-F: every advertised artifact operation runs over real files and shared policy", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("MCP file publication proof\n");
    const declaredFile = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const uploadResult = await callTool(server, installation.apiToken, {
      arguments: {entryPath: declaredFile.path, files: [declaredFile]},
      name: "artifact_create_upload",
    });
    expect(uploadResult.isError).not.toBe(true);
    const upload = createUploadResultSchema.parse(uploadResult.structuredContent);
    const filePlan = upload.files[0];
    if (filePlan === undefined) throw new Error("The MCP upload plan has no file.");

    const uploaded = await fetch(filePlan.uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: filePlan.method,
    });
    expect(uploaded.status).toBe(200);

    const commitArguments = {
      idempotencyKey: "mcp-file-publication-proof-001",
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "MCP publication proof",
        tags: ["MCP", "Proof"],
      },
      uploadId: upload.uploadId,
    };
    const committed = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: commitArguments,
        name: "artifact_commit_upload",
      })).structuredContent,
    );
    expect(committed.replayed).toBe(false);
    const replay = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: commitArguments,
        name: "artifact_commit_upload",
      })).structuredContent,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(committed.version.id);

    const detailsResult = await callTool(server, installation.apiToken, {
      arguments: {artifactId: committed.artifact.id},
      name: "artifact_get",
    });
    const details = z.object({
      artifact: z.object({
        currentVersionId: z.string(),
        id: z.string(),
        tags: z.array(z.string()),
      }).loose(),
      current: z.object({
        manifest: z.object({
          entries: z.array(z.object({path: z.string(), sha256: z.string()}).loose()),
          entryPath: z.string(),
        }).loose(),
      }).loose(),
    }).parse(detailsResult.structuredContent);
    expect(details.artifact.currentVersionId).toBe(committed.version.id);
    expect(details.artifact.tags).toEqual(["mcp", "proof"]);
    expect(details.current.manifest.entryPath).toBe("proof.txt");
    expect(details.current.manifest.entries).toContainEqual(
      expect.objectContaining({path: "proof.txt", sha256: declaredFile.sha256}),
    );

    const listedResult = await callTool(server, installation.apiToken, {
      arguments: {cursor: null, limit: 10, tag: "mcp"},
      name: "artifact_list",
    });
    const listed = z.object({
      artifacts: z.array(z.object({id: z.string()}).loose()),
    }).parse(listedResult.structuredContent);
    expect(listed.artifacts.map((artifact) => artifact.id)).toEqual([
      committed.artifact.id,
    ]);

    const openedResult = await callTool(server, installation.apiToken, {
      arguments: {artifactId: committed.artifact.id, versionId: null},
      name: "artifact_open",
    });
    const opened = z.object({
      artifactId: z.string(),
      browserUrl: z.url(),
      exactVersion: z.boolean(),
      versionId: z.string(),
    }).parse(openedResult.structuredContent);
    expect(opened.artifactId).toBe(committed.artifact.id);
    expect(opened.versionId).toBe(committed.version.id);
    expect(opened.exactVersion).toBe(false);
    expect(opened.browserUrl).toContain("__artifact_bootstrap=");

    const resourceUri = `artifact://projects/${String(committed.artifact["projectId"])}/artifacts/${committed.artifact.id}/versions/${committed.version.id}/manifest`;
    const resourceResponse = await mcpRequest(
      server,
      installation.apiToken,
      "resources/read",
      {uri: resourceUri},
      {"Mcp-Name": resourceUri},
    );
    expect(resourceResponse.status).toBe(200);
    const resourceBody = jsonRpcResultSchema.parse(await resourceResponse.json());
    const resource = z.object({
      contents: z.array(z.object({
        mimeType: z.literal("application/json"),
        text: z.string(),
        uri: z.literal(resourceUri),
      })).length(1),
    }).loose().parse(resourceBody.result).contents[0];
    if (resource === undefined) throw new Error("The manifest resource was empty.");
    expect(JSON.parse(resource.text)).toMatchObject({
      artifactId: committed.artifact.id,
      versionId: committed.version.id,
    });

    const updatedBytes = new TextEncoder().encode("MCP file publication proof, updated\n");
    const indexBytes = new TextEncoder().encode(
      "<!doctype html><title>MCP complete site</title><script src=assets/data.bin></script>",
    );
    const assetBytes = Buffer.alloc(1_100_000, 0x61);
    assetBytes.write("This complete site includes a large actual asset.\n");
    const updatedDeclaredFiles = [
      declaredMcpFile("assets/data.bin", "application/octet-stream", assetBytes),
      declaredMcpFile("index.html", "text/html", indexBytes),
      declaredMcpFile("proof.txt", "text/plain", updatedBytes),
    ];
    const updatedUploadResult = await callTool(server, installation.apiToken, {
      arguments: {entryPath: "index.html", files: updatedDeclaredFiles},
      name: "artifact_create_upload",
    });
    const updatedUpload = createUploadResultSchema.parse(
      updatedUploadResult.structuredContent,
    );
    await uploadMcpFiles(
      updatedUpload,
      installation.apiToken,
      new Map([
        ["assets/data.bin", assetBytes],
        ["index.html", indexBytes],
        ["proof.txt", updatedBytes],
      ]),
    );
    const updated = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: {
          idempotencyKey: "mcp-file-publication-proof-002",
          target: {
            artifactId: committed.artifact.id,
            expectedCurrentVersionId: committed.version.id,
            kind: "new_version",
          },
          uploadId: updatedUpload.uploadId,
        },
        name: "artifact_commit_upload",
      })).structuredContent,
    );
    expect(updated.version.id).not.toBe(committed.version.id);

    const versions = z.object({
      artifactId: z.string(),
      versions: z.array(z.object({
        contentUrl: z.url(),
        id: z.string(),
        number: z.number().int().positive(),
      }).loose()).length(2),
    }).parse((await callTool(server, installation.apiToken, {
      arguments: {artifactId: committed.artifact.id},
      name: "artifact_version_list",
    })).structuredContent);
    expect(versions.versions.map((version) => version.id)).toEqual([
      updated.version.id,
      committed.version.id,
    ]);

    const difference = z.object({
      added: z.array(z.object({path: z.string()}).loose()),
      changed: z.array(z.object({
        after: z.object({path: z.string()}).loose(),
        detail: z.object({kind: z.string()}).loose(),
      }).loose()),
      from: z.object({id: z.string()}).loose(),
      to: z.object({id: z.string()}).loose(),
    }).parse((await callTool(server, installation.apiToken, {
      arguments: {
        artifactId: committed.artifact.id,
        fromVersionId: committed.version.id,
        toVersionId: updated.version.id,
      },
      name: "artifact_diff",
    })).structuredContent);
    expect(difference.added).toContainEqual(
      expect.objectContaining({path: "assets/data.bin"}),
    );
    expect(difference.changed).toContainEqual(expect.objectContaining({
      after: expect.objectContaining({path: "proof.txt"}),
      detail: expect.objectContaining({kind: "text"}),
    }));

    const tagged = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: {
          artifactId: committed.artifact.id,
          expectedCurrentVersionId: updated.version.id,
          idempotencyKey: "mcp-set-tags-proof-001",
          tags: ["updated", "MCP"],
        },
        name: "artifact_set_tags",
      })).structuredContent,
    );
    expect(tagged.artifact.currentVersionId).toBe(updated.version.id);

    const staleVisibility = await callTool(server, installation.apiToken, {
      arguments: {
        accessSetting: "public_link",
        artifactId: committed.artifact.id,
        expectedCurrentVersionId: committed.version.id,
        idempotencyKey: "mcp-stale-visibility-001",
      },
      name: "artifact_set_visibility",
    });
    expect(staleVisibility.isError).toBe(true);
    expect(staleVisibility.content[0]?.text).toContain("ARTIFACT_MUTATION_CONFLICT");

    const visible = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: {
          accessSetting: "public_link",
          artifactId: committed.artifact.id,
          expectedCurrentVersionId: updated.version.id,
          idempotencyKey: "mcp-set-visibility-proof-001",
        },
        name: "artifact_set_visibility",
      })).structuredContent,
    );
    expect(visible.artifact.currentVersionId).toBe(updated.version.id);

    const restored = publicationResultSchema.parse(
      (await callTool(server, installation.apiToken, {
        arguments: {
          artifactId: committed.artifact.id,
          expectedCurrentVersionId: updated.version.id,
          idempotencyKey: "mcp-restore-version-proof-001",
          versionId: committed.version.id,
        },
        name: "artifact_restore_version",
      })).structuredContent,
    );
    expect(restored.artifact.currentVersionId).toBe(committed.version.id);

    const deleted = z.object({
      artifact: z.object({deletedAt: z.string(), id: z.string()}).loose(),
      replayed: z.boolean(),
      retainedVersionCount: z.number().int().positive(),
    }).parse((await callTool(server, installation.apiToken, {
      arguments: {
        artifactId: committed.artifact.id,
        expectedCurrentVersionId: committed.version.id,
        idempotencyKey: "mcp-delete-artifact-proof-001",
      },
      name: "artifact_delete",
    })).structuredContent);
    expect(deleted.artifact.id).toBe(committed.artifact.id);
    expect(deleted.retainedVersionCount).toBe(2);

    const missingArtifact = await callTool(server, installation.apiToken, {
      arguments: {artifactId: "artifact-that-does-not-exist"},
      name: "artifact_get",
    });
    expect(missingArtifact.isError).toBe(true);
    expect(missingArtifact.content[0]?.text).toContain("ARTIFACT_NOT_FOUND");
  });

  test("MCP manages projects and refuses ambiguous artifact scope", async () => {
    const initial = await callTool(server, installation.apiToken, {
      arguments: {},
      name: "project_list",
    });
    expect(initial.structuredContent).toMatchObject({
      projects: [expect.objectContaining({id: "prj_default", name: "Default"})],
    });

    const created = await callTool(server, installation.apiToken, {
      arguments: {name: "MCP project"},
      name: "project_create",
    });
    const project = z.object({
      project: z.object({id: z.string(), name: z.literal("MCP project")}),
    }).parse(created.structuredContent).project;

    const ambiguous = await callTool(server, installation.apiToken, {
      arguments: {cursor: null, limit: 10, projectId: null, tag: null},
      name: "artifact_list",
    });
    expect(ambiguous).toMatchObject({
      isError: true,
      structuredContent: {
        error: {code: "PROJECT_SELECTION_REQUIRED"},
      },
    });

    const renamed = await callTool(server, installation.apiToken, {
      arguments: {name: "Renamed MCP project", projectId: project.id},
      name: "project_rename",
    });
    expect(renamed.structuredContent).toMatchObject({
      project: {id: project.id, name: "Renamed MCP project"},
    });
    const archived = await callTool(server, installation.apiToken, {
      arguments: {projectId: project.id},
      name: "project_archive",
    });
    expect(archived.structuredContent).toMatchObject({
      project: {archivedAt: expect.any(String), id: project.id},
    });
    const unarchived = await callTool(server, installation.apiToken, {
      arguments: {projectId: project.id},
      name: "project_unarchive",
    });
    expect(unarchived.structuredContent).toMatchObject({
      project: {archivedAt: null, id: project.id},
    });
  });

  test("MCP-009-B MCP-009-F: external credentials use the same installation and capability policy as HTTP", async () => {
    expect.hasAssertions();
    const readToken = "mcp-read-only-external-token";
    const foreignToken = "mcp-foreign-installation-token";
    const externalBearerVerifier: BearerCredentialVerifier = {
      verify: (credential) => {
        const token = Redacted.value(credential);
        if (token !== readToken && token !== foreignToken) {
          return Effect.fail(new AuthenticationRequired({
            message: "The external token is invalid.",
          }));
        }
        return Effect.succeed({
          authorizedByPrincipalId: "external-issuer",
          capabilities: ["artifact:read"],
          id: "external-reader",
          installationId: token === readToken ? "local" : "other-installation",
          kind: "service",
          membershipRole: "member",
        });
      },
    };
    await server.stop();
    server = await startTestServer(installation, {
      externalMcpBearerVerifier: externalBearerVerifier,
    });

    expect((await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Authorization: `Bearer ${readToken}`},
    })).status).toBe(401);

    const readable = await callTool(server, readToken, {
      arguments: {cursor: null, limit: 10, tag: null},
      name: "artifact_list",
    });
    expect(readable.isError).not.toBe(true);

    const forbiddenUpload = await callTool(server, readToken, {
      arguments: {
        entryPath: "proof.txt",
        files: [{
          mediaType: "text/plain",
          path: "proof.txt",
          sha256: "0".repeat(64),
          size: 0,
        }],
      },
      name: "artifact_create_upload",
    });
    expect(forbiddenUpload.isError).toBe(true);
    expect(forbiddenUpload.content[0]?.text).toContain("AUTHORIZATION_DENIED");

    const foreignList = await callTool(server, foreignToken, {
      arguments: {cursor: null, limit: 10, tag: null},
      name: "artifact_list",
    });
    expect(foreignList.isError).toBe(true);
    expect(foreignList.content[0]?.text).toContain("AUTHORIZATION_DENIED");

    await server.stop();
    const unavailableVerifier: BearerCredentialVerifier = {
      verify: () => Effect.fail(new IdentityRepositoryFailure({
        cause: new Error("The identity store is unavailable."),
        operation: "findApiKey",
      })),
    };
    server = await startTestServer(installation, {
      externalMcpBearerVerifier: unavailableVerifier,
    });
    const unavailable = await mcpRequest(
      server,
      readToken,
      "server/discover",
      {},
    );
    expect(unavailable.status).toBe(500);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: "server_error",
    });
  });
});

interface ToolInvocation {
  readonly arguments: McpParameters;
  readonly name: string;
}

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;

function declaredMcpFile(path: string, mediaType: string, bytes: Uint8Array) {
  return {
    mediaType,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function uploadMcpFiles(
  upload: z.infer<typeof createUploadResultSchema>,
  token: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  await Promise.all(upload.files.map(async (plan) => {
    const bytes = files.get(plan.path);
    if (bytes === undefined) {
      throw new Error(`The MCP upload plan requested unexpected path ${plan.path}.`);
    }
    const response = await fetch(plan.uploadUrl, {
      body: Buffer.from(bytes),
      headers: {Authorization: `Bearer ${token}`},
      method: plan.method,
    });
    if (response.status !== 200) {
      throw new Error(`MCP file upload ${plan.path} returned ${response.status}.`);
    }
  }));
}

async function callTool(
  server: RunningTestServer,
  token: string,
  invocation: ToolInvocation,
) {
  const response = await mcpRequest(
    server,
    token,
    "tools/call",
    {arguments: invocation.arguments, name: invocation.name},
    {"Mcp-Name": invocation.name},
  );
  expect(response.status).toBe(200);
  return toolCallResultSchema.parse(await response.json()).result;
}

async function mcpRequest(
  server: RunningTestServer,
  token: string | null,
  method: string,
  parameters: McpParameters,
  additionalHeaders: HeadersInit = {},
): Promise<Response> {
  const headers = new Headers(additionalHeaders);
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Content-Type", "application/json");
  headers.set("MCP-Protocol-Version", protocolVersion);
  headers.set("Mcp-Method", method);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
      },
    }),
    headers,
    method: "POST",
  });
}
