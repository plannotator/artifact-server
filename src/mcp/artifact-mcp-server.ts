import {createHash} from "node:crypto";

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
import {
  ArtifactCommentService,
  type CommentAnchorInput,
  type ReadCommentThreadCommand,
  type UpdateCommentThreadCommand,
} from "../application/artifact-comments.js";
import {ArtifactManagementService} from "../application/artifact-management.js";
import {CompareArtifactService} from "../application/compare-artifact.js";
import {ContentAccessService} from "../application/content-access.js";
import {
  LinkedArtifactService,
  liveContentToken,
  type LinkArtifactCommand,
  type LinkedPublication,
} from "../application/linked-artifacts.js";
import {ProjectManagementService} from "../application/project-management.js";
import {ProjectGitHistoryService} from
  "../application/project-git-history.js";
import {StagedUploadService} from "../application/staged-upload.js";
import {
  accessSettings,
  commentThreadStates,
  dispatchedThreadFilters,
  type ArtifactVersion,
  type CommentThreadRecord,
  type ProjectRecord,
  type SourceBindingRecord,
  type StagedUpload,
} from "../core/model.js";
import {principalKinds, type Principal} from "../core/identity.js";
import {
  gitHistoryProviders,
  gitHistoryProviderStates,
  type GitHistoryCapability,
} from "../git-history/git-history-capability.js";
import {
  maximumCommentAnchorBytes,
  maximumCommentBodyCharacters,
  maximumCommentPageSize,
  maximumDeclaredFiles,
  maximumDispatchBundleSize,
  maximumDispatchNoteCharacters,
  maximumUploadPlanRequestBytes,
} from "../core/publishing-limits.js";
import {
  InvalidComment,
  InvalidPagination,
  isArtifactServerFailure,
  PublishConflict,
  SourceDrifted,
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
  routingMode: z.enum(["static", "spa"]),
}).strict();
const projectProjectionSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  name: z.string(),
}).strict();
const projectGitHistorySettingSchema = z.object({
  enabled: z.boolean(),
  projectId: z.string(),
}).strict();
const projectGitHistoryEstimateSchema = z.object({
  estimatedCopiedBytes: z.number().int().nonnegative(),
  estimatedPointerBytes: z.number().int().nonnegative(),
  notice: z.string(),
  operations: z.number().int().nonnegative(),
  projectId: z.string(),
  repositories: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
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
  routingMode: z.enum(["static", "spa"]),
}).strict();
const artifactStateSchema = z.object({
  artifact: artifactRecordSchema,
  replayed: z.boolean(),
  version: versionRecordSchema,
}).strict();
const publishedVersionSchema = artifactStateSchema.extend({
  links: z.object({artifact: z.url(), version: z.url()}).strict(),
}).strict();
const linkPathSchema = z.string().min(1).max(4_096);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceBindingSchema = z.object({
  lastVerifiedAt: z.string(),
  path: z.string(),
  status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
}).strict();
const linkedPublicationSchema = artifactStateSchema.extend({
  links: z.object({
    artifact: z.url(),
    live: z.url().nullable(),
    version: z.url(),
  }).strict(),
  sourceBinding: sourceBindingSchema,
}).strict();
const commentThreadIdSchema = z.string().min(1).max(200);
const commentReplyIdSchema = z.string().min(1).max(200);
// The comment service is the single body authority: it measures the trimmed
// body and answers with INVALID_COMMENT, so the wire schema only fixes the type.
const commentBodySchema = z.string();
const commentPathSchema = z.string().min(1).max(1_024);
const commentStateSchema = z.enum([
  commentThreadStates.open,
  commentThreadStates.resolved,
]);
const dispatchedThreadFilterSchema = z.enum([
  dispatchedThreadFilters.exclude,
  dispatchedThreadFilters.include,
  dispatchedThreadFilters.only,
]);
const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum([principalKinds.human, principalKinds.service]),
}).strict();
const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: commentStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
}).strict();
const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
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
  /** Secret-free optional Git state exposed by capability discovery. */
  readonly gitHistory: GitHistoryCapability;
  /** Advertises the local linked-artifact capability in discovery. */
  readonly linkedArtifacts?: boolean;
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
        agentDispatch: z.object({
          bundleThreadRule: z.string(),
          maximumBundleThreads: z.number(),
          maximumNoteCharacters: z.number(),
        }),
        comments: z.object({
          anchorRule: z.string(),
          maximumAnchorBytes: z.number(),
          maximumBodyCharacters: z.number(),
        }),
        comparison: z.object({maximumTextFileBytes: z.number()}),
        deployment: z.object({mode: z.enum(["local", "remote"])}),
        gitHistory: z.object({
          limits: z.object({
            fileCopyBytes: z.number().int().nonnegative(),
            logicalCopiedBytes: z.number().int().nonnegative(),
            logicalReservedBytes: z.number().int().nonnegative(),
            storageBudgetBytes: z.number().int().nonnegative().nullable(),
            versionCopyBytes: z.number().int().nonnegative(),
          }).strict(),
          provider: z.enum(gitHistoryProviders).nullable(),
          providerState: z.enum(gitHistoryProviderStates),
        }).strict(),
        publishing: z.object({
          acceptsInlineContent: z.literal(false),
          localPathTool: z.literal(false),
          maximumDeclaredFiles: z.number(),
          maximumUploadPlanRequestBytes: z.number(),
          workflow: z.array(z.string()),
        }),
        linkedArtifacts: z.object({available: z.boolean()}),
        projects: z.object({
          omittedProjectRule: z.string(),
          scope: z.literal("project"),
        }),
        sharing: z.object({modes: z.array(accessSettingSchema)}),
      }),
      annotations: readOnlyAnnotations,
    },
    () => successResult(
      capabilities(
        dependencies.mode,
        dependencies.linkedArtifacts === true,
        dependencies.gitHistory,
      ),
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
    "project_git_history_status",
    {
      title: "Read project Git history status",
      description: "Read the off-by-default Git history setting for one project.",
      inputSchema: z.object({projectId: projectIdSchema}).strict(),
      outputSchema: z.object({
        gitHistory: projectGitHistorySettingSchema,
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    ({projectId}) => toolResult(async () => ({
      gitHistory: await runMcpApplicationEffect(
        dependencies,
        ProjectGitHistoryService.use((service) => service.read({
          principal: identity.principal,
          projectId,
        })),
      ),
    })),
  );

  server.registerTool(
    "project_git_history_estimate",
    {
      title: "Estimate project Git history",
      description:
        "Estimate current repositories, versions, and copied bytes before enabling one project.",
      inputSchema: z.object({projectId: projectIdSchema}).strict(),
      outputSchema: z.object({estimate: projectGitHistoryEstimateSchema}).strict(),
      annotations: readOnlyAnnotations,
    },
    ({projectId}) => toolResult(async () => ({
      estimate: await runMcpApplicationEffect(
        dependencies,
        ProjectGitHistoryService.use((service) => service.estimate({
          principal: identity.principal,
          projectId,
        })),
      ),
    })),
  );

  server.registerTool(
    "project_set_git_history",
    {
      title: "Set project Git history",
      description:
        "Enable or disable Git history for one project. Enablement requires estimate confirmation.",
      inputSchema: z.discriminatedUnion("enabled", [
        z.object({enabled: z.literal(false), projectId: projectIdSchema}).strict(),
        z.object({
          confirmEstimate: z.literal(true),
          enabled: z.literal(true),
          projectId: projectIdSchema,
        }).strict(),
      ]),
      outputSchema: z.object({
        gitHistory: projectGitHistorySettingSchema,
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    (input) => toolResult(async () => {
      const command = input.enabled
        ? {
          confirmEstimate: true as const,
          enabled: true as const,
          principal: identity.principal,
          projectId: input.projectId,
        }
        : {
          enabled: false as const,
          principal: identity.principal,
          projectId: input.projectId,
        };
      return {
        gitHistory: await runMcpApplicationEffect(
          dependencies,
          ProjectGitHistoryService.use((service) => service.set(command)),
        ),
      };
    }),
  );

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
        routingMode: z.enum(["static", "spa"]).default("static"),
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
    async ({entryPath, files, projectId, routingMode}) => toolResult(async () => {
      const upload = await runMcpApplicationEffect(
        dependencies,
        StagedUploadService.use((uploads) =>
          uploads.createUpload({
            entryPath,
            files,
            principal: identity.principal,
            projectId,
            routingMode,
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

  server.registerTool(
    "artifact_link",
    {
      title: "Link a file on this machine",
      description:
        "Link one file that already exists on this server's machine as an artifact, capturing its current bytes as the first immutable version. Available only on a local installation with linked files enabled; check artifact_capabilities first. Pass the absolute path only: MCP never carries file bytes, and the server reads the file itself. Omitting idempotencyKey derives a stable key from these arguments, so an identical retry replays instead of linking the file twice.",
      inputSchema: z.object({
        idempotencyKey: idempotencyKeySchema.nullable().default(null),
        name: z.string().min(1).max(200).nullable().default(null),
        path: linkPathSchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: linkedPublicationSchema,
      annotations: idempotentWriteAnnotations,
    },
    async ({idempotencyKey, name, path, projectId}) => linkedToolResult(async () => {
      const command: LinkArtifactCommand = {
        idempotencyKey: idempotencyKey ?? derivedIdempotencyKey([
          "link",
          projectId ?? "",
          path,
          name ?? "",
        ]),
        path,
        principal: identity.principal,
        projectId,
      };
      return linkedPublicationProjection(
        applicationUrl,
        dependencies.contentDomain,
        await runMcpApplicationEffect(
          dependencies,
          LinkedArtifactService.use((linked) =>
            linked.linkArtifact(name === null ? command : {...command, name})
          ),
        ),
      );
    }),
  );

  server.registerTool(
    "artifact_capture",
    {
      title: "Capture a linked file's current bytes",
      description:
        "Save the current bytes of a linked artifact's source file as a new immutable version. Read the artifact first and pass its current version ID as expectedCurrentVersionId; capturing an unchanged source returns the current version unchanged. Omitting idempotencyKey derives a stable key from these arguments, so an identical retry replays instead of saving a second version.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema.nullable().default(null),
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: linkedPublicationSchema,
      annotations: idempotentWriteAnnotations,
    },
    async ({artifactId, expectedCurrentVersionId, idempotencyKey, projectId}) =>
      linkedToolResult(async () =>
        linkedPublicationProjection(
          applicationUrl,
          dependencies.contentDomain,
          await runMcpApplicationEffect(
            dependencies,
            LinkedArtifactService.use((linked) =>
              linked.captureArtifact({
                artifactId,
                expectedCurrentVersionId,
                idempotencyKey: idempotencyKey ?? derivedIdempotencyKey([
                  "capture",
                  artifactId,
                  expectedCurrentVersionId,
                ]),
                principal: identity.principal,
                projectId,
              })
            ),
          ),
        )
      ),
  );

  server.registerTool(
    "artifact_relink",
    {
      title: "Point a linked artifact at a moved file",
      description:
        "Re-point one linked artifact at the same file in its new location on this server's machine. The move is accepted only when the file at the new path hashes to expectedSha256, normally the current version's entry file SHA-256. Versions, comments, and the artifact ID are untouched.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedSha256: sha256Schema,
        path: linkPathSchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: z.object({
        artifactId: z.string(),
        sourceBinding: sourceBindingSchema,
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({artifactId, expectedSha256, path, projectId}) =>
      linkedToolResult(async () => ({
        artifactId,
        sourceBinding: sourceBindingProjection(
          await runMcpApplicationEffect(
            dependencies,
            LinkedArtifactService.use((linked) =>
              linked.relinkArtifact({
                artifactId,
                expectedSha256,
                idempotencyKey: derivedIdempotencyKey([
                  "relink",
                  artifactId,
                  expectedSha256,
                  path,
                ]),
                path,
                principal: identity.principal,
                projectId,
              })
            ),
          ),
        ),
      })),
  );

  server.registerTool(
    "comment_list",
    {
      title: "List comment threads",
      description:
        "List one artifact's comment threads across its saved versions, newest activity first. Filter by exact version or state, pass since to poll for new, edited, and resolved threads, continue a large result set with nextCursor, and pass dispatched to include or show only threads an agent dispatch currently holds (default excludes them, since a sent bundle disappears from ordinary listings until it is addressed, fails, or is canceled).",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        cursor: z.string().max(1_024).nullable().default(null),
        dispatched: dispatchedThreadFilterSchema.nullable().default(null),
        limit: z.number().int().min(1).max(maximumCommentPageSize).default(50),
        projectId: optionalProjectIdSchema,
        since: z.iso.datetime().nullable().default(null),
        state: commentStateSchema.nullable().default(null),
        versionId: versionIdSchema.nullable().default(null),
      }).strict(),
      outputSchema: z.object({
        items: z.array(commentThreadSchema),
        nextCursor: z.string().nullable(),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async (
      {artifactId, cursor, dispatched, limit, projectId, since, state, versionId},
    ) =>
      toolResult(async () => {
        const page = await runMcpApplicationEffect(
          dependencies,
          ArtifactCommentService.use((comments) =>
            comments.listThreads({
              artifactId,
              cursor: decodePageCursor(cursor),
              dispatched: dispatched ?? dispatchedThreadFilters.exclude,
              limit,
              principal: identity.principal,
              projectId,
              since,
              state,
              versionId,
            })
          ),
        );
        return {
          items: page.items.map(commentThreadProjection),
          nextCursor: encodePageCursor(page.nextCursor),
        };
      }),
  );

  server.registerTool(
    "comment_get",
    {
      title: "Get a comment thread",
      description:
        "Read one comment thread with every reply, in the order the replies were written.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
        threadId: commentThreadIdSchema,
      }).strict(),
      outputSchema: z.object({
        replies: z.array(commentReplySchema),
        thread: commentThreadSchema,
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, projectId, threadId}) => toolResult(async () => {
      const details = await runMcpApplicationEffect(
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.getThread({
            artifactId,
            principal: identity.principal,
            projectId,
            threadId,
          })
        ),
      );
      return {
        replies: [...details.replies],
        thread: commentThreadProjection(details.thread),
      };
    }),
  );

  server.registerTool(
    "comment_create",
    {
      title: "Open a comment thread",
      description:
        "Open one comment thread on one exact saved version, optionally on one manifest path inside it. The anchor is opaque client JSON; the server checks only its size and, when present, that a top-level point has x and y between 0 and 1.",
      inputSchema: z.object({
        anchor: z.unknown().nullable().default(null),
        artifactId: artifactIdSchema,
        body: commentBodySchema,
        idempotencyKey: idempotencyKeySchema,
        path: commentPathSchema.nullable().default(null),
        projectId: optionalProjectIdSchema,
        versionId: versionIdSchema,
      }).strict(),
      outputSchema: z.object({
        replayed: z.boolean(),
        thread: commentThreadSchema,
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({
      anchor,
      artifactId,
      body,
      idempotencyKey,
      path,
      projectId,
      versionId,
    }) => toolResult(async () => {
      const creation = await runMcpApplicationEffect(
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.createThread({
            anchor,
            artifactId,
            body,
            idempotencyKey,
            path,
            principal: identity.principal,
            projectId,
            versionId,
          })
        ),
      );
      return {
        replayed: creation.replayed,
        thread: commentThreadProjection(creation.thread),
      };
    }),
  );

  server.registerTool(
    "comment_reply",
    {
      title: "Reply to a comment thread",
      description:
        "Add one reply to an open comment thread. A resolved thread rejects replies until it is reopened; replies carry no anchor and cannot be replied to.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        body: commentBodySchema,
        idempotencyKey: idempotencyKeySchema,
        projectId: optionalProjectIdSchema,
        threadId: commentThreadIdSchema,
      }).strict(),
      outputSchema: z.object({
        replayed: z.boolean(),
        reply: commentReplySchema,
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({artifactId, body, idempotencyKey, projectId, threadId}) =>
      toolResult(async () => {
        const creation = await runMcpApplicationEffect(
          dependencies,
          ArtifactCommentService.use((comments) =>
            comments.createReply({
              artifactId,
              body,
              idempotencyKey,
              principal: identity.principal,
              projectId,
              threadId,
            })
          ),
        );
        return {replayed: creation.replayed, reply: creation.reply};
      }),
  );

  server.registerTool(
    "comment_resolve",
    {
      title: "Resolve or reopen a comment thread",
      description:
        "Close one comment thread as resolved, or reopen it by passing resolved false. Resolving records who resolved it and when.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
        resolved: z.boolean(),
        threadId: commentThreadIdSchema,
      }).strict(),
      outputSchema: z.object({thread: commentThreadSchema}).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({artifactId, projectId, resolved, threadId}) => toolResult(async () => ({
      thread: commentThreadProjection(await runMcpApplicationEffect(
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.updateThread({
            artifactId,
            principal: identity.principal,
            projectId,
            state: resolved
              ? commentThreadStates.resolved
              : commentThreadStates.open,
            threadId,
          })
        ),
      )),
    })),
  );

  server.registerTool(
    "comment_update",
    {
      title: "Edit a comment",
      description:
        "Change the words of one comment thread, or of one of its replies when replyId is given. Only the author may edit. An anchor belongs to a thread, so omit replyId when moving one.",
      inputSchema: z.object({
        anchor: z.unknown().optional(),
        artifactId: artifactIdSchema,
        body: commentBodySchema.optional(),
        projectId: optionalProjectIdSchema,
        replyId: commentReplyIdSchema.nullable().default(null),
        threadId: commentThreadIdSchema,
      }).strict(),
      outputSchema: z.object({
        reply: commentReplySchema.nullable(),
        thread: commentThreadSchema.nullable(),
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({anchor, artifactId, body, projectId, replyId, threadId}) =>
      toolResult(async () => {
        const target: ReadCommentThreadCommand = {
          artifactId,
          principal: identity.principal,
          projectId,
          threadId,
        };
        if (replyId !== null) {
          if (anchor !== undefined) {
            throw new InvalidComment({
              message:
                "A reply carries no anchor. Omit replyId to move a comment thread's anchor.",
            });
          }
          if (body === undefined) {
            throw new InvalidComment({
              message: "A reply edit must carry the replacement body.",
            });
          }
          const reply = await runMcpApplicationEffect(
            dependencies,
            ArtifactCommentService.use((comments) =>
              comments.updateReply({...target, body, replyId})
            ),
          );
          return {reply, thread: null};
        }
        const thread = await runMcpApplicationEffect(
          dependencies,
          ArtifactCommentService.use((comments) =>
            comments.updateThread(commentThreadEdit(
              target,
              anchor === undefined ? null : {anchor},
              body ?? null,
            ))
          ),
        );
        return {reply: null, thread: commentThreadProjection(thread)};
      }),
  );

  server.registerTool(
    "comment_delete",
    {
      title: "Delete a comment",
      description:
        "Delete one comment thread with every reply it carries, or delete one reply when replyId is given. The author, a human administrator, or a principal with artifact:manage:any may delete.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
        replyId: commentReplyIdSchema.nullable().default(null),
        threadId: commentThreadIdSchema,
      }).strict(),
      outputSchema: z.object({deleted: z.literal(true)}).strict(),
      annotations: destructiveWriteAnnotations,
    },
    async ({artifactId, projectId, replyId, threadId}) => toolResult(async () => {
      const target: ReadCommentThreadCommand = {
        artifactId,
        principal: identity.principal,
        projectId,
        threadId,
      };
      await runMcpApplicationEffect(
        dependencies,
        ArtifactCommentService.use((comments) =>
          replyId === null
            ? comments.deleteThread(target)
            : comments.deleteReply({...target, replyId})
        ),
      );
      return {deleted: true as const};
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
    "Reviewers leave comment threads on an artifact version. Use comment_list and comment_get to read them, comment_create, comment_reply, and comment_update to write, comment_resolve to close or reopen a thread, and comment_delete to remove one you own; deleting a thread also deletes its replies.",
    "comment_list hides threads an agent dispatch currently holds unless you pass dispatched: \"include\" or \"only\"; comment_get still reads a dispatched thread directly by id.",
    "artifact_get returns the current complete manifest and browser link in one call. artifact_open returns a client-openable URL; a remote server never opens a browser on the server machine.",
    mode === "local"
      ? "This is a local MCP connection, but the MCP protocol still carries metadata rather than file bytes. Use the bundled Artifact Server publishing skill or CLI to upload a local path."
      : "This is a remote MCP connection. The server cannot read paths on the agent's computer; use the returned upload plan or the bundled Artifact Server publishing skill.",
  ].join("\n");
}

function capabilities(
  mode: "local" | "remote",
  linkedArtifacts: boolean,
  gitHistory: GitHistoryCapability,
) {
  return {
    gitHistory,
    linkedArtifacts: {available: linkedArtifacts},
    agentDispatch: {
      bundleThreadRule:
        "1..100 open, undispatched comment threads from one project per bundle",
      maximumBundleThreads: maximumDispatchBundleSize,
      maximumNoteCharacters: maximumDispatchNoteCharacters,
    },
    comments: {
      anchorRule: "opaque; top-level point.x and point.y must be 0..1",
      maximumAnchorBytes: maximumCommentAnchorBytes,
      maximumBodyCharacters: maximumCommentBodyCharacters,
    },
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

function sourceBindingProjection(binding: SourceBindingRecord) {
  return {
    lastVerifiedAt: binding.lastVerifiedAt,
    path: binding.path,
    status: binding.freshness,
  };
}

function linkedPublicationProjection(
  applicationUrl: URL,
  contentDomain: string,
  linked: LinkedPublication,
) {
  const published = publishedVersionProjection(
    applicationUrl,
    contentDomain,
    linked.published,
  );
  const liveToken = liveContentToken(linked.published.artifact.id);
  return {
    ...published,
    links: {
      ...published.links,
      live: liveToken === null
        ? null
        : versionBrowserUrl(applicationUrl, contentDomain, liveToken),
    },
    sourceBinding: sourceBindingProjection(linked.binding),
  };
}

/**
 * Derive one stable idempotency key from the operation's own inputs so an
 * agent that retries the identical call replays instead of linking twice.
 */
function derivedIdempotencyKey(parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex");
  return `mcp-${digest.slice(0, 48)}`;
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

function commentThreadProjection(thread: CommentThreadRecord) {
  return {
    anchor: thread.anchor ?? null,
    artifactId: thread.artifactId,
    author: thread.author,
    body: thread.body,
    createdAt: thread.createdAt,
    id: thread.id,
    path: thread.path,
    projectId: thread.projectId,
    replyCount: thread.replyCount,
    resolvedAt: thread.resolvedAt,
    resolvedBy: thread.resolvedBy,
    state: thread.state,
    updatedAt: thread.updatedAt,
    versionId: thread.versionId,
  };
}

function commentThreadEdit(
  target: ReadCommentThreadCommand,
  anchor: CommentAnchorInput | null,
  body: string | null,
): UpdateCommentThreadCommand {
  if (anchor === null) {
    return body === null ? target : {...target, body};
  }
  return body === null
    ? {...target, anchor: anchor.anchor}
    : {...target, anchor: anchor.anchor, body};
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

/**
 * Run one linked-source tool. Its retryable failures are restated as the
 * action the agent should take next: a capture conflict already names the
 * artifact's current version, and a drift abort saved nothing at all.
 */
async function linkedToolResult<Value extends object>(
  operation: () => Promise<Value>,
) {
  try {
    return successResult(await operation());
  } catch (cause) {
    if (cause instanceof Error && isArtifactServerFailure(cause)) {
      if (cause._tag === "PublishConflict") {
        return failureResult(new PublishConflict({
          message:
            `${cause.message} Read the artifact's current version ID and retry artifact_capture with it as expectedCurrentVersionId.`,
        }));
      }
      if (cause._tag === "SourceDrifted") {
        return failureResult(new SourceDrifted({
          message:
            `${cause.message} The source changed mid-read, so no version was saved; retry the same call.`,
        }));
      }
    }
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
