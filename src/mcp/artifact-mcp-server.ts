import {
  McpServer,
  ResourceTemplate,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {type Effect, Redacted} from "effect";
import {z} from "zod";

import {
  type ApplicationServices,
  type ApplicationRuntime,
  runApplicationEffect,
} from "../application/application-runtime.js";
import {ArtifactManagementService} from "../application/artifact-management.js";
import {CompareArtifactService} from "../application/compare-artifact.js";
import {ContentAccessService} from "../application/content-access.js";
import {ProjectManagementService} from "../application/project-management.js";
import {StagedUploadService} from "../application/staged-upload.js";
import {
  accessSettings,
  type ArtifactVersion,
  type ProjectRecord,
  type StagedUpload,
} from "../core/model.js";
import type {Principal} from "../core/identity.js";
import {
  maximumDeclaredFiles,
  maximumUploadPlanRequestBytes,
} from "../core/publishing-limits.js";
import {
  InvalidPagination,
  isArtifactServerFailure,
} from "../core/errors.js";
import {
  artifactBrowserUrl,
  contentBootstrapBrowserUrl,
  versionBrowserUrl,
  versionFileBrowserUrl,
} from "../http/artifact-http-links.js";
import {artifactServerFailureResponse} from "../http/artifact-http-failure.js";

const serverVersion = "0.0.0";
const maximumListedArtifacts = 100;
const maximumTextDiffBytes = 256 * 1_024;
const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const artifactIdSchema = z.string().min(1).max(200);
const projectIdSchema = z.string().min(1).max(200);
const optionalProjectIdSchema = projectIdSchema.nullable().default(null);
const versionIdSchema = z.string().min(1).max(200);
const idempotencyKeySchema = z.string().min(16).max(200);
const expectedVersionSchema = z.string().min(1).max(200);
const tagSchema = z.string().min(1).max(200);
const declaredFileSchema = z.object({
  mediaType: z.string().trim().min(1).max(200),
  path: z.string().min(1).max(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const artifactRecordSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
}).strict();
const versionRecordSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: z.literal("static"),
}).strict();
const projectProjectionSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  name: z.string(),
}).strict();
const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
}).strict();
const manifestProjectionSchema = z.object({
  digest: z.string(),
  entries: z.array(manifestEntrySchema),
  entryPath: z.string(),
  routingMode: z.literal("static"),
}).strict();
const artifactStateSchema = z.object({
  artifact: artifactRecordSchema,
  replayed: z.boolean(),
  version: versionRecordSchema,
}).strict();
const publishedVersionSchema = artifactStateSchema.extend({
  links: z.object({artifact: z.url(), version: z.url()}).strict(),
}).strict();
const manifestResource = new ResourceTemplate(
  "artifact://projects/{projectId}/artifacts/{artifactId}/versions/{versionId}/manifest",
  {list: undefined},
);

/** Runtime and deployment values required by the MCP protocol adapter. */
export interface ArtifactMcpServerDependencies {
  readonly applicationOrigin: string;
  readonly applicationRuntime: ApplicationRuntime;
  readonly contentDomain: string;
  readonly mode: "local" | "remote";
  readonly requestId: string;
}

function runMcpApplicationEffect<A, E>(
  dependencies: ArtifactMcpServerDependencies,
  effect: Effect.Effect<A, E, ApplicationServices>,
): Promise<A> {
  return runApplicationEffect(
    dependencies.applicationRuntime,
    effect,
    {
      requestId: dependencies.requestId,
      spanName: "mcp.operation",
    },
  );
}

/** Values attached to one already authenticated MCP request. */
export interface ArtifactMcpRequestIdentity {
  readonly principal: Principal;
}

/** Build one fresh Artifact Server MCP server for a stateless request or stdio connection. */
export function createArtifactMcpServer(
  dependencies: ArtifactMcpServerDependencies,
  identity: ArtifactMcpRequestIdentity,
  _context: McpRequestContext,
): McpServer {
  const applicationUrl = new URL(dependencies.applicationOrigin);
  const server = new McpServer(
    {name: "artifact-server", version: serverVersion},
    {
      cacheHints: {
        "resources/read": {cacheScope: "private", ttlMs: 0},
        "resources/templates/list": {cacheScope: "private", ttlMs: 60_000},
        "server/discover": {cacheScope: "private", ttlMs: 60_000},
        "tools/list": {cacheScope: "private", ttlMs: 60_000},
      },
      instructions: agentInstructions(dependencies.mode),
    },
  );

  server.registerTool(
    "artifact_capabilities",
    {
      title: "Artifact Server capabilities",
      description:
        "Read this installation's publishing workflow, limits, sharing modes, and optional local capabilities before choosing another tool.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        comparison: z.object({maximumTextFileBytes: z.number()}),
        deployment: z.object({mode: z.enum(["local", "remote"])}),
        publishing: z.object({
          acceptsInlineContent: z.literal(false),
          localPathTool: z.literal(false),
          maximumDeclaredFiles: z.number(),
          maximumUploadPlanRequestBytes: z.number(),
          workflow: z.array(z.string()),
        }),
        projects: z.object({
          omittedProjectRule: z.string(),
          scope: z.literal("project"),
        }),
        sharing: z.object({modes: z.array(accessSettingSchema)}),
      }),
      annotations: readOnlyAnnotations,
    },
    () => successResult(capabilities(dependencies.mode),
      "Artifact Server publishes actual files through an upload plan. It does not accept inline HTML, CSS, JavaScript, or base64 content."),
  );

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description:
        "List this installation's projects. Use a returned project ID in artifact tools when more than one active project exists.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        projects: z.array(projectProjectionSchema),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    () => toolResult(async () => ({
      projects: (await runMcpApplicationEffect(
        dependencies,
        ProjectManagementService.use((projects) =>
          projects.listProjects(identity.principal)
        ),
      )).map(projectProjection),
    })),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create a project",
      description:
        "Create a project in this installation. After a second active project exists, artifact tools require projectId.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
      }).strict(),
      outputSchema: z.object({
        project: projectProjectionSchema,
      }).strict(),
      annotations: additiveWriteAnnotations,
    },
    ({name}) => toolResult(async () => ({
      project: projectProjection(await runMcpApplicationEffect(
        dependencies,
        ProjectManagementService.use((projects) =>
          projects.createProject({name, principal: identity.principal})
        ),
      )),
    })),
  );

  server.registerTool(
    "project_rename",
    {
      title: "Rename a project",
      description:
        "Change a project's display name without changing its stable ID or artifacts.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
        projectId: projectIdSchema,
      }).strict(),
      outputSchema: z.object({
        project: projectProjectionSchema,
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    ({name, projectId}) => toolResult(async () => ({
      project: projectProjection(await runMcpApplicationEffect(
        dependencies,
        ProjectManagementService.use((projects) =>
          projects.renameProject({
            name,
            principal: identity.principal,
            projectId,
          })
        ),
      )),
    })),
  );

  for (const lifecycle of ["archive", "unarchive"] as const) {
    server.registerTool(
      `project_${lifecycle}`,
      {
        title: `${lifecycle === "archive" ? "Archive" : "Unarchive"} a project`,
        description: lifecycle === "archive"
          ? "Stop a project from accepting new artifacts or versions while preserving its readable history."
          : "Allow an archived project to accept new artifacts and versions again.",
        inputSchema: z.object({projectId: projectIdSchema}).strict(),
        outputSchema: z.object({
          project: projectProjectionSchema,
        }).strict(),
        annotations: idempotentWriteAnnotations,
      },
      ({projectId}) => toolResult(async () => ({
        project: projectProjection(await runMcpApplicationEffect(
          dependencies,
          ProjectManagementService.use((projects) =>
            lifecycle === "archive"
              ? projects.archiveProject({
                principal: identity.principal,
                projectId,
              })
              : projects.unarchiveProject({
                principal: identity.principal,
                projectId,
              })
          ),
        )),
      })),
    );
  }

  server.registerTool(
    "artifact_list",
    {
      title: "List artifacts",
      description:
        "Find artifacts visible to the caller. Use tag for exact normalized-tag filtering and nextCursor to continue a large result set.",
      inputSchema: z.object({
        cursor: z.string().max(1_024).nullable().default(null),
        limit: z.number().int().min(1).max(maximumListedArtifacts).default(50),
        projectId: optionalProjectIdSchema,
        tag: tagSchema.nullable().default(null),
      }).strict(),
      outputSchema: z.object({
        artifacts: z.array(z.object({
          accessSetting: accessSettingSchema,
          browserUrl: z.url(),
          createdAt: z.string(),
          currentVersionId: z.string(),
          id: z.string(),
          name: z.string(),
          projectId: z.string(),
          tags: z.array(z.string()),
        })),
        nextCursor: z.string().nullable(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({cursor, limit, projectId, tag}) => toolResult(async () => {
      const page = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.listArtifacts({
            cursor: decodePageCursor(cursor),
            limit,
            principal: identity.principal,
            projectId,
            tag,
          })
        ),
      );
      return {
        artifacts: page.items.map((artifact) => ({
          accessSetting: artifact.accessSetting,
          browserUrl: artifactBrowserUrl(applicationUrl, artifact.id),
          createdAt: artifact.createdAt,
          currentVersionId: artifact.currentVersionId,
          id: artifact.id,
          name: artifact.name,
          projectId: artifact.projectId,
          tags: [...artifact.tags],
        })),
        nextCursor: encodePageCursor(page.nextCursor),
      };
    }),
  );

  server.registerTool(
    "artifact_get",
    {
      title: "Get an artifact",
      description:
        "Get one artifact with its current immutable version, complete canonical manifest, stable browser links, sharing mode, and tags in one call.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: z.object({
        artifact: artifactRecordSchema,
        current: z.object({
          links: z.object({version: z.url()}).strict(),
          manifest: manifestProjectionSchema,
          version: versionRecordSchema,
        }).strict(),
        links: z.object({artifact: z.url()}).strict(),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, projectId}) => toolResult(async () => {
      const details = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getArtifact({
            artifactId,
            principal: identity.principal,
            projectId,
          })
        ),
      );
      return {
        artifact: details.artifact,
        current: versionProjection(
          applicationUrl,
          dependencies.contentDomain,
          details.current,
        ),
        links: {
          artifact: artifactBrowserUrl(applicationUrl, details.artifact.id),
        },
      };
    }),
  );

  server.registerTool(
    "artifact_open",
    {
      title: "Open an artifact",
      description:
        "Return the exact browser URL for an artifact's current or selected immutable version. The MCP client opens the URL on the user's computer; the server never opens a browser remotely.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
        versionId: versionIdSchema.nullable().default(null),
      }).strict(),
      outputSchema: z.object({
        artifactId: z.string(),
        browserUrl: z.url(),
        exactVersion: z.boolean(),
        versionId: z.string(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, projectId, versionId}) => toolResult(async () => {
      const saved = versionId === null
        ? (await runMcpApplicationEffect(
          dependencies,
          ArtifactManagementService.use((management) =>
            management.getArtifact({
              artifactId,
              principal: identity.principal,
              projectId,
            })
          ),
        )).current
        : await runMcpApplicationEffect(
          dependencies,
          ArtifactManagementService.use((management) =>
            management.getVersion({
              artifactId,
              principal: identity.principal,
              projectId,
              versionId,
            })
          ),
        );
      const browserUrl = await authorizedBrowserUrl(
        dependencies,
        identity.principal,
        applicationUrl,
        artifactId,
        saved.version.projectId,
        saved,
        versionId !== null,
      );
      return {
        artifactId,
        browserUrl,
        exactVersion: versionId !== null,
        versionId: saved.version.id,
      };
    }),
  );

  server.registerTool(
    "artifact_version_list",
    {
      title: "List saved versions",
      description:
        "List every immutable saved version of one artifact, newest first. The returned content URLs identify exact versions; use artifact_open when the user needs an authorized browser URL.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: z.object({
        artifactId: z.string(),
        versions: z.array(z.object({
          contentUrl: z.url(),
          createdAt: z.string(),
          entryPath: z.string(),
          id: z.string(),
          manifestDigest: z.string(),
          number: z.number().int().positive(),
          publisherPrincipalId: z.string(),
        }).strict()),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, projectId}) => toolResult(async () => {
      const versions = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.listVersions({
            artifactId,
            principal: identity.principal,
            projectId,
          })
        ),
      );
      return {
        artifactId,
        versions: versions.map((version) => ({
          contentUrl: versionBrowserUrl(
            applicationUrl,
            dependencies.contentDomain,
            version.contentToken,
          ),
          createdAt: version.createdAt,
          entryPath: version.entryPath,
          id: version.id,
          manifestDigest: version.manifestDigest,
          number: version.number,
          publisherPrincipalId: version.publisherPrincipalId,
        })),
      };
    }),
  );

  server.registerTool(
    "artifact_diff",
    {
      title: "Compare saved versions",
      description:
        "Compare any two immutable versions. Returns added, removed, renamed, and changed files plus bounded line details for small text files.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        fromVersionId: versionIdSchema,
        projectId: optionalProjectIdSchema,
        toVersionId: versionIdSchema,
      }).strict(),
      outputSchema: z.object({
        added: z.array(manifestEntrySchema),
        artifact: artifactRecordSchema,
        changed: z.array(z.object({
          after: manifestEntrySchema,
          before: manifestEntrySchema,
          detail: z.discriminatedUnion("kind", [
            z.object({
              afterLineCount: z.number().int().nonnegative(),
              beforeLineCount: z.number().int().nonnegative(),
              change: z.object({
                after: z.array(z.string()),
                afterStartLine: z.number().int().nonnegative(),
                before: z.array(z.string()),
                beforeStartLine: z.number().int().nonnegative(),
              }).strict().nullable(),
              kind: z.literal("text"),
            }).strict(),
            z.object({
              kind: z.literal("binary"),
              reason: z.enum([
                "binary_or_invalid_utf8",
                "text_limit_exceeded",
              ]),
            }).strict(),
          ]),
          links: z.object({after: z.url(), before: z.url()}).strict(),
        }).strict()),
        from: versionRecordSchema,
        links: z.object({from: z.url(), to: z.url()}).strict(),
        removed: z.array(manifestEntrySchema),
        renamed: z.array(z.object({
          from: manifestEntrySchema,
          to: manifestEntrySchema,
        }).strict()),
        to: versionRecordSchema,
        unchangedCount: z.number().int().nonnegative(),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, fromVersionId, projectId, toVersionId}) => toolResult(async () => {
      const comparison = await runMcpApplicationEffect(
        dependencies,
        CompareArtifactService.use((comparisons) =>
          comparisons.compareVersions({
            artifactId,
            fromVersionId,
            principal: identity.principal,
            projectId,
            toVersionId,
          })
        ),
      );
      return {
        added: comparison.added,
        artifact: comparison.artifact,
        changed: comparison.changed.map((change) => ({
          ...change,
          links: {
            after: versionFileBrowserUrl(
              applicationUrl,
              dependencies.contentDomain,
              comparison.to.contentToken,
              change.after.path,
            ),
            before: versionFileBrowserUrl(
              applicationUrl,
              dependencies.contentDomain,
              comparison.from.contentToken,
              change.before.path,
            ),
          },
        })),
        from: comparison.from,
        links: {
          from: versionBrowserUrl(
            applicationUrl,
            dependencies.contentDomain,
            comparison.from.contentToken,
          ),
          to: versionBrowserUrl(
            applicationUrl,
            dependencies.contentDomain,
            comparison.to.contentToken,
          ),
        },
        removed: comparison.removed,
        renamed: comparison.renamed,
        to: comparison.to,
        unchangedCount: comparison.unchangedCount,
      };
    }),
  );

  server.registerTool(
    "artifact_create_upload",
    {
      title: "Begin a file upload",
      description:
        "Begin publishing actual files. Supply relative paths, byte sizes, SHA-256 fingerprints, media types, and the entry file. Upload each file to its returned URL, then call artifact_commit_upload. Do not send file bytes through MCP.",
      inputSchema: z.object({
        entryPath: z.string().min(1).max(1_024),
        files: z.array(declaredFileSchema).min(1).max(maximumDeclaredFiles),
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: z.object({
        commit: z.object({
          mcpTool: z.literal("artifact_commit_upload"),
          uploadId: z.string(),
        }).strict(),
        expiresAt: z.string(),
        files: z.array(z.object({
          authorization: z.object({
            credential: z.literal("reuse_the_mcp_bearer_credential"),
            scheme: z.literal("Bearer"),
          }).strict(),
          method: z.literal("PUT"),
          path: z.string(),
          size: z.number().int().nonnegative(),
          uploadUrl: z.url(),
        }).strict()),
        manifestDigest: z.string(),
        projectId: z.string(),
        uploadId: z.string(),
      }).strict(),
      annotations: additiveWriteAnnotations,
    },
    async ({entryPath, files, projectId}) => toolResult(async () => {
      const upload = await runMcpApplicationEffect(
        dependencies,
        StagedUploadService.use((uploads) =>
          uploads.createUpload({
            entryPath,
            files,
            principal: identity.principal,
            projectId,
          })
        ),
      );
      return uploadPlan(applicationUrl, upload);
    }),
  );

  server.registerTool(
    "artifact_commit_upload",
    {
      title: "Commit an uploaded version",
      description:
        "After every upload-plan URL has received its exact file bytes, commit the upload as a new artifact or an optimistic new version. Retrying the same idempotency key and input returns the original result.",
      inputSchema: z.object({
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
        target: z.discriminatedUnion("kind", [
          z.object({
            accessSetting: accessSettingSchema.default(
              accessSettings.accountRequired,
            ),
            kind: z.literal("new_artifact"),
            name: z.string().min(1).max(200),
            tags: z.array(tagSchema).max(20).default([]),
          }).strict(),
          z.object({
            artifactId: artifactIdSchema,
            expectedCurrentVersionId: expectedVersionSchema,
            kind: z.literal("new_version"),
          }).strict(),
        ]),
        uploadId: z.string().min(1).max(200),
      }).strict(),
      outputSchema: publishedVersionSchema,
      annotations: idempotentWriteAnnotations,
    },
    async ({idempotencyKey, projectId, target, uploadId}) => toolResult(async () => {
      const published = await runMcpApplicationEffect(
        dependencies,
        StagedUploadService.use((uploads) =>
          uploads.commitUpload({
            idempotencyKey,
            principal: identity.principal,
            projectId,
            target,
            uploadId,
          })
        ),
      );
      return publishedVersionProjection(
        applicationUrl,
        dependencies.contentDomain,
        published,
      );
    }),
  );

  server.registerTool(
    "artifact_set_visibility",
    {
      title: "Change artifact visibility",
      description:
        "Change an artifact between account-required and public-link access without changing its saved files. Public copies already downloaded outside Artifact Server cannot be recalled.",
      inputSchema: z.object({
        accessSetting: accessSettingSchema,
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: artifactStateSchema.extend({
        links: z.object({artifact: z.url(), version: z.url()}).strict(),
        warning: z.string().nullable(),
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async (input) => toolResult(async () => {
      const state = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.changeAccess({...input, principal: identity.principal})
        ),
      );
      return {
        artifact: state.artifact,
        links: {
          artifact: artifactBrowserUrl(applicationUrl, state.artifact.id),
          version: versionBrowserUrl(
            applicationUrl,
            dependencies.contentDomain,
            state.version.contentToken,
          ),
        },
        replayed: state.replayed,
        version: state.version,
        warning: input.accessSetting === accessSettings.accountRequired
          ? "New public requests are blocked. Copies already downloaded or cached outside Artifact Server cannot be recalled."
          : null,
      };
    }),
  );

  server.registerTool(
    "artifact_set_tags",
    {
      title: "Replace artifact tags",
      description:
        "Replace an artifact's complete normalized tag set. Tags are exact filters for later discovery; this does not change saved files.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
        tags: z.array(tagSchema).max(20),
      }).strict(),
      outputSchema: artifactStateSchema,
      annotations: idempotentWriteAnnotations,
    },
    async (input) => toolResult(async () => {
      const state = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.changeTags({...input, principal: identity.principal})
        ),
      );
      return {
        artifact: state.artifact,
        replayed: state.replayed,
        version: state.version,
      };
    }),
  );

  server.registerTool(
    "artifact_restore_version",
    {
      title: "Restore a saved version",
      description:
        "Make an existing immutable saved version current again. The saved version is not edited and no file bytes are copied.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
        versionId: versionIdSchema,
      }).strict(),
      outputSchema: artifactStateSchema,
      annotations: idempotentWriteAnnotations,
    },
    async (input) => toolResult(async () => {
      const state = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.restoreVersion({...input, principal: identity.principal})
        ),
      );
      return {
        artifact: state.artifact,
        replayed: state.replayed,
        version: state.version,
      };
    }),
  );

  server.registerTool(
    "artifact_delete",
    {
      title: "Delete an artifact",
      description:
        "Delete one artifact from active listings after an optimistic current-version check. This is destructive; retained immutable version records are reported.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: z.object({
        artifact: artifactRecordSchema.extend({deletedAt: z.string()}).strict(),
        replayed: z.boolean(),
        retainedVersionCount: z.number().int().nonnegative(),
      }).strict(),
      annotations: destructiveWriteAnnotations,
    },
    async (input) => toolResult(async () => {
      const deletion = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.deleteArtifact({...input, principal: identity.principal})
        ),
      );
      return {...deletion};
    }),
  );

  server.registerResource(
    "artifact-version-manifest",
    manifestResource,
    {
      title: "Artifact version manifest",
      description:
        "The canonical relative paths, media types, sizes, fingerprints, and entry file for one immutable version.",
      mimeType: "application/json",
      cacheHint: {cacheScope: "private", ttlMs: 0},
    },
    async (uri, variables) => {
      const artifactId = variableString(variables["artifactId"]);
      const projectId = variableString(variables["projectId"]);
      const versionId = variableString(variables["versionId"]);
      const saved = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId,
            principal: identity.principal,
            projectId,
            versionId,
          })
        ),
      );
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify({
            artifactId,
            projectId,
            manifest: {
              digest: saved.manifest.digest,
              entries: saved.manifest.entries,
              entryPath: saved.manifest.entryPath,
              routingMode: saved.manifest.routingMode,
            },
            versionId,
          }),
          uri: uri.href,
        }],
      };
    },
  );

  return server;
}

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const additiveWriteAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

const idempotentWriteAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

const destructiveWriteAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

function agentInstructions(mode: "local" | "remote"): string {
  return [
    "Artifact Server stores actual files as immutable versions. It does not accept inline HTML, CSS, JavaScript, base64, or invented file contents through MCP.",
    "Start with artifact_capabilities when you do not know this installation's limits.",
    "Artifacts belong to projects. Omit projectId only when the installation has one active project; otherwise call project_list and choose explicitly.",
    "For publishing, inspect the selected file or finished directory on the client, compute each relative path, byte length, media type, and SHA-256 fingerprint, call artifact_create_upload, PUT the exact bytes to every returned uploadUrl using the same bearer credential, then call artifact_commit_upload.",
    "When publishing a new version, first call artifact_get and pass its current version ID as expectedCurrentVersionId. On conflict, inspect the new current version before retrying.",
    "Use a stable application idempotency key when retrying the same mutation. Use a new key only for an intentional new operation.",
    "artifact_get returns the current complete manifest and browser link in one call. artifact_open returns a client-openable URL; a remote server never opens a browser on the server machine.",
    mode === "local"
      ? "This is a local MCP connection, but the MCP protocol still carries metadata rather than file bytes. Use the bundled Artifact Server publishing skill or CLI to upload a local path."
      : "This is a remote MCP connection. The server cannot read paths on the agent's computer; use the returned upload plan or the bundled Artifact Server publishing skill.",
  ].join("\n");
}

function capabilities(mode: "local" | "remote") {
  return {
    comparison: {maximumTextFileBytes: maximumTextDiffBytes},
    deployment: {mode},
    publishing: {
      acceptsInlineContent: false as const,
      localPathTool: false as const,
      maximumDeclaredFiles,
      maximumUploadPlanRequestBytes,
      workflow: [
        "Inspect one actual file or finished directory on the client.",
        "Call artifact_create_upload with portable file metadata.",
        "Upload each exact file to its returned uploadUrl.",
        "Call artifact_commit_upload with an idempotency key and optimistic version when updating.",
        "Inspect the returned immutable version and browser links.",
      ],
    },
    projects: {
      omittedProjectRule:
        "Omission selects the only active project. Multiple active projects require an explicit projectId.",
      scope: "project" as const,
    },
    sharing: {
      modes: [accessSettings.accountRequired, accessSettings.publicLink],
    },
  };
}

function uploadPlan(
  applicationUrl: URL,
  upload: StagedUpload,
) {
  return {
    commit: {
      mcpTool: "artifact_commit_upload",
      uploadId: upload.id,
    },
    expiresAt: upload.expiresAt,
    files: upload.files.map((file) => ({
      authorization: {
        credential: "reuse_the_mcp_bearer_credential" as const,
        scheme: "Bearer" as const,
      },
      method: "PUT" as const,
      path: file.entry.path,
      size: file.entry.size,
      uploadUrl: new URL(
        `/api/v1/uploads/${upload.id}/files/${file.storageToken}?projectId=${encodeURIComponent(upload.projectId)}`,
        applicationUrl,
      ).toString(),
    })),
    manifestDigest: upload.manifest.digest,
    projectId: upload.projectId,
    uploadId: upload.id,
  };
}

function projectProjection(project: ProjectRecord) {
  return {
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    id: project.id,
    name: project.name,
  };
}

function publishedVersionProjection(
  applicationUrl: URL,
  contentDomain: string,
  published: {
    readonly artifact: {readonly id: string};
    readonly replayed: boolean;
    readonly version: {
      readonly contentToken: string;
      readonly id: string;
    };
  },
) {
  return {
    artifact: published.artifact,
    links: {
      artifact: artifactBrowserUrl(applicationUrl, published.artifact.id),
      version: versionBrowserUrl(
        applicationUrl,
        contentDomain,
        published.version.contentToken,
      ),
    },
    replayed: published.replayed,
    version: published.version,
  };
}

function versionProjection(
  applicationUrl: URL,
  contentDomain: string,
  saved: ArtifactVersion,
) {
  return {
    links: {
      version: versionBrowserUrl(
        applicationUrl,
        contentDomain,
        saved.version.contentToken,
      ),
    },
    manifest: {
      digest: saved.manifest.digest,
      entries: saved.manifest.entries,
      entryPath: saved.manifest.entryPath,
      routingMode: saved.manifest.routingMode,
    },
    version: saved.version,
  };
}

async function authorizedBrowserUrl(
  dependencies: ArtifactMcpServerDependencies,
  principal: Principal,
  applicationUrl: URL,
  artifactId: string,
  projectId: string,
  saved: ArtifactVersion,
  exactVersion: boolean,
): Promise<string> {
  const details = await runMcpApplicationEffect(
    dependencies,
    ArtifactManagementService.use((management) =>
      management.getArtifact({artifactId, principal, projectId})
    ),
  );
  if (details.artifact.accessSetting === accessSettings.publicLink) {
    return exactVersion
      ? versionBrowserUrl(
        applicationUrl,
        dependencies.contentDomain,
        saved.version.contentToken,
      )
      : artifactBrowserUrl(applicationUrl, artifactId);
  }
  const issued = await runMcpApplicationEffect(
    dependencies,
    ContentAccessService.use((access) =>
      access.issueContentBootstrap({
        artifactId,
        principal,
        projectId,
        target: exactVersion
          ? {kind: "version", versionId: saved.version.id}
          : {kind: "current"},
      })
    ),
  );
  return contentBootstrapBrowserUrl(
    applicationUrl,
    dependencies.contentDomain,
    issued.contentToken,
    Redacted.value(issued.token),
  );
}

async function toolResult<Value extends object>(operation: () => Promise<Value>) {
  try {
    return successResult(await operation());
  } catch (cause) {
    return failureResult(cause);
  }
}

function successResult<Value extends object>(value: Value, summary?: string) {
  return {
    content: [{
      text: summary ?? JSON.stringify(value),
      type: "text" as const,
    }],
    structuredContent: value,
  };
}

function failureResult(cause: unknown) {
  const failure = errorProjection(cause);
  return {
    content: [{text: `${failure.code}: ${failure.message}`, type: "text" as const}],
    isError: true,
    structuredContent: {error: failure},
  };
}

function errorProjection(cause: unknown) {
  if (cause instanceof Error && isArtifactServerFailure(cause)) {
    switch (cause._tag) {
      case "ArtifactRepositoryFailure":
      case "BlobStorageFailure":
      case "IdentityProviderFailure":
      case "IdentityRepositoryFailure":
      case "StagingStorageFailure":
        return {
          code: "INTERNAL_ERROR",
          message: "The server could not complete the request.",
        };
      default:
        const response = artifactServerFailureResponse(cause);
        return {code: response.code, message: response.message};
    }
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The server could not complete the request.",
  };
}

function encodePageCursor(cursor: {readonly createdAt: string; readonly id: string} | null): string | null {
  return cursor === null
    ? null
    : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePageCursor(token: string | null): {readonly createdAt: string; readonly id: string} | null {
  if (token === null) return null;
  try {
    return z.object({
      createdAt: z.string().min(1).max(100),
      id: z.string().min(1).max(200),
    }).strict().parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
  } catch {
    throw new InvalidPagination({
      message: "The artifact page cursor is invalid.",
    });
  }
}

function variableString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
