import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import {Clock, Effect, Exit, Redacted, type Tracer} from "effect";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {routePath} from "hono/route";
import { z } from "zod";

import {
  type ApplicationServices,
  type ApplicationRuntime,
  runApplicationEffect,
} from "../application/application-runtime.js";
import { StagedUploadService } from "../application/staged-upload.js";
import { AuthenticationService } from "../application/authentication.js";
import {
  digestIdentitySecret,
  identitySecretsEqual,
  InstallationAccessService,
} from "../application/installation-access.js";
import { InteractiveLoginService } from "../application/interactive-login.js";
import { ProjectManagementService } from "../application/project-management.js";
import {ProjectGitHistoryService} from
  "../application/project-git-history.js";
import {
  AgentDispatchService,
  type ConnectedRegisteredAgent,
} from "../application/agent-dispatch.js";
import {
  ArtifactCommentService,
  type CommentThreadDetails,
  type ReadCommentThreadCommand,
  type UpdateCommentThreadCommand,
} from "../application/artifact-comments.js";
import {
  type ArtifactDetails,
  ArtifactManagementService,
} from "../application/artifact-management.js";
import {
  type MakePublicLinkPrivateResult,
  PublicLinkAdministrationService,
  type PublicLinkInventoryPage,
} from "../application/public-link-administration.js";
import {
  type ArtifactComparison,
  CompareArtifactService,
} from "../application/compare-artifact.js";
import { ContentAccessService } from "../application/content-access.js";
import {
  isLiveContentToken,
  LinkedArtifactService,
  type LinkedPublication,
  liveContentToken,
  type LiveReadGrant,
} from "../application/linked-artifacts.js";
import {
  AuthenticationRequired,
  AuthorizationDenied,
  type ArtifactServerFailure,
  CapabilityUnavailable,
  ContentBootstrapRejected,
  errorCodes,
  InvalidPagination,
  isArtifactServerFailure,
  VersionNotFound,
} from "../core/errors.js";
import type { IssuedApplicationSession } from "../core/installation-identity.js";
import {
  browserAccessModes,
  type BrowserAccess,
} from "../core/browser-access.js";
import {
  membershipRoles,
  principalCapabilities,
  type Principal,
} from "../core/identity.js";
import {
  accessSettings,
  type AgentDispatchPage,
  type AgentDispatchRecord,
  agentDispatchStates,
  type ArtifactActionPage,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactState,
  type ArtifactVersion,
  commentThreadStates,
  type CommentThreadPage,
  type CommentThreadRecord,
  type CommentThreadState,
  dispatchedThreadFilters,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  registeredAgentKinds,
  type RegisteredAgentRecord,
  type SourceBindingRecord,
  type VersionRecord,
} from "../core/model.js";
import type { BlobStore } from "../core/ports.js";
import {
  disabledGitHistoryCapability,
  fixedGitHistoryCapabilityReader,
  type GitHistoryCapabilityReader,
} from "../git-history/git-history-capability.js";
import {
  decideByteRange,
  ifRangeAllowsPartialResponse,
} from "./byte-range.js";
import {permitsSpaEntryFallback} from "./spa-navigation.js";
import {
  maximumCommentPageSize,
  maximumDeclaredFiles,
  maximumUploadPlanRequestBytes,
} from "../core/publishing-limits.js";
import {
  manifestPathFromUrl,
  parseManifestPath,
} from "../manifest/create-manifest.js";
import {createMcpHttpAdapter} from "../mcp/create-mcp-http-adapter.js";
import {
  artifactBrowserUrl,
  artifactReviewUrl,
  contentBootstrapBrowserUrl,
  versionBrowserUrl,
  versionFileBrowserUrl,
} from "./artifact-http-links.js";
import {artifactServerFailureResponse} from "./artifact-http-failure.js";
import {observeHttpRequest} from "../observability/application-observability.js";
import type {
  RuntimeLifecycle,
  RuntimeLifecycleState,
} from "../lifecycle/runtime-readiness.js";

const maximumJsonRequestBytes = 1_500_000;
const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const artifactTagsSchema = z.array(z.string()).default([]);
const projectIdSchema = z.string().trim().min(1).max(200);
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();
const renameProjectSchema = createProjectSchema;
const setProjectGitHistorySchema = z.discriminatedUnion("enabled", [
  z.object({enabled: z.literal(false)}).strict(),
  z.object({
    confirmEstimate: z.literal(true),
    enabled: z.literal(true),
  }).strict(),
]);
const declaredFileSchema = z.object({
  mediaType: z.string().trim().min(1).max(200),
  path: z.string().min(1).max(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const createUploadSchema = z.object({
  entryPath: z.string().min(1).max(1_024),
  files: z.array(declaredFileSchema).min(1).max(maximumDeclaredFiles),
  projectId: projectIdSchema.optional(),
  routingMode: z.enum(["static", "spa"]).default("static"),
}).strict();
const commitUploadSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({
      accessSetting: accessSettingSchema.default(accessSettings.accountRequired),
      kind: z.literal("new_artifact"),
      name: z.string().min(1).max(200),
      tags: artifactTagsSchema,
    }).strict(),
    z.object({
      artifactId: z.string().min(1).max(200),
      expectedCurrentVersionId: z.string().min(1).max(200),
      kind: z.literal("new_version"),
    }).strict(),
  ]),
}).strict();
const contentTokenSchema = z
  .string()
  .min(16)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/u);
const bearerSchema = z
  .string()
  .regex(/^Bearer [A-Za-z0-9._~-]+$/u)
  .transform((value) => value.slice("Bearer ".length));
const contentSessionTokenSchema = z
  .string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);
const contentBootstrapQueryParameter = "__artifact_bootstrap";
const contentSessionCookieName = "__Host-artifact_content";
const loopbackContentSessionCookieName = "artifact_content";
const linkArtifactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  path: z.string().min(1).max(4_096),
  projectId: projectIdSchema.optional(),
}).strict();
const captureArtifactSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
}).strict();
const relinkArtifactSchema = z.object({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  path: z.string().min(1).max(4_096),
}).strict();
const restoreVersionSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
});
const changeAccessSchema = z.object({
  accessSetting: accessSettingSchema,
  expectedCurrentVersionId: z.string().min(1).max(200),
});
const changeTagsSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  tags: artifactTagsSchema,
});
const comparisonQuerySchema = z.object({
  fromVersionId: z.string().min(1).max(200),
  toVersionId: z.string().min(1).max(200),
});
const manifestEntryPathSchema = z.string().min(1).max(1_024);
// The comment service is the single body authority: it measures the trimmed
// body and answers with INVALID_COMMENT, so the wire schema only fixes the type.
const commentBodySchema = z.string();
const commentStateSchema = z.enum([
  commentThreadStates.open,
  commentThreadStates.resolved,
]);
const createCommentThreadSchema = z.object({
  anchor: z.unknown().optional(),
  body: commentBodySchema,
  path: manifestEntryPathSchema.optional(),
}).strict();
const updateCommentThreadSchema = z.object({
  anchor: z.unknown().optional(),
  body: commentBodySchema.optional(),
  state: commentStateSchema.optional(),
}).strict();
const createCommentReplySchema = z.object({
  body: commentBodySchema,
}).strict();
const updateCommentReplySchema = createCommentReplySchema;
const dispatchedThreadFilterSchema = z.enum([
  dispatchedThreadFilters.exclude,
  dispatchedThreadFilters.include,
  dispatchedThreadFilters.only,
]);
const commentPageQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  // The default hides dispatched threads, which is what makes a send
  // consumptive for every existing client without a change on its side.
  dispatched: dispatchedThreadFilterSchema.default(
    dispatchedThreadFilters.exclude,
  ),
  limit: z.coerce.number().int().min(1).max(maximumCommentPageSize).default(50),
  since: z.iso.datetime().optional(),
  state: commentStateSchema.optional(),
  versionId: z.string().min(1).max(200).optional(),
});
// The dispatch service is the single bounds authority: it trims and measures
// agent text, bundle size, and notes, then answers with INVALID_DISPATCH, so
// the wire schemas below only fix the types.
const agentTextSchema = z.string();
const agentIdSchema = z.string().min(1).max(200);
const registerAgentSchema = z.object({
  agentSessionId: agentTextSchema.nullable().optional(),
  connectionKey: agentTextSchema.optional(),
  displayName: agentTextSchema,
  kind: z.enum([registeredAgentKinds.pi]),
  workingDirectory: agentTextSchema,
}).strict();
// The wait is clamped rather than refused: the contract already permits an
// early answer, so an over-eager client gets the server cap, not an error.
const claimDispatchQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).default(0),
});
const createAgentDispatchSchema = z.object({
  agentId: agentIdSchema,
  note: agentTextSchema.nullable().optional(),
  projectId: projectIdSchema.optional(),
  threadIds: z.array(agentTextSchema),
}).strict();
const reportDispatchDeliveredSchema = z.object({
  agentId: agentIdSchema.optional(),
}).strict();
const reportDispatchFailedSchema = z.object({
  agentId: agentIdSchema.optional(),
  reason: agentTextSchema,
}).strict();
const agentDispatchStateSchema = z.enum([
  agentDispatchStates.addressed,
  agentDispatchStates.canceled,
  agentDispatchStates.claimed,
  agentDispatchStates.delivered,
  agentDispatchStates.failed,
  agentDispatchStates.queued,
]);
const agentDispatchPageQuerySchema = z.object({
  agentId: agentIdSchema.optional(),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(maximumCommentPageSize).default(50),
  state: agentDispatchStateSchema.optional(),
});
const versionFileQuerySchema = z.object({
  path: manifestEntryPathSchema,
});
const deleteArtifactSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
});
const pageQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: z.string().max(200).optional(),
});
const publicLinksPageQuerySchema = pageQuerySchema.omit({tag: true});
const makePublicLinkPrivateItemSchema = z.object({
  artifactId: z.string().min(1).max(200),
  expectedCurrentVersionId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(16).max(200),
  projectId: projectIdSchema,
}).strict();
const makePublicLinksPrivateSchema = z.object({
  items: z.array(makePublicLinkPrivateItemSchema).min(1).max(100),
}).strict().superRefine(({items}, context) => {
  const seen = new Set<string>();
  for (const item of items) {
    const identity = `${item.projectId}\0${item.artifactId}`;
    if (seen.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "A public-link bulk request cannot repeat an artifact.",
        path: ["items"],
      });
      return;
    }
    seen.add(identity);
  }
});
const pageCursorSchema = z.object({
  createdAt: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
}).strict();
const pageCursorTokenSchema = z.string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);
const memberRoleSchema = z.enum([
  membershipRoles.administrator,
  membershipRoles.member,
]);
const admitMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  role: memberRoleSchema.default(membershipRoles.member),
});
const principalCapabilitySchema = z.enum([
  principalCapabilities.connectAgents,
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.readArtifacts,
  principalCapabilities.writeComments,
]);
const issueApiKeySchema = z.object({
  capabilities: z.array(principalCapabilitySchema).min(1),
  expiresAt: z.iso.datetime(),
  memberId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
});
const localLoginQuerySchema = z.object({
  token: z.string().min(32).max(200),
});
const interactiveLoginQuerySchema = z.object({
  returnTo: z.string().max(1_024).default("/api/v1/session"),
});
const interactiveCallbackSchema = z.object({
  code: z.string().min(1).max(4_096),
  state: z.string().min(16).max(4_096),
});
const sessionTokenSchema = z.string().min(32).max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);
const csrfTokenSchema = sessionTokenSchema;
const applicationSessionCookie = "artifact_session";
const applicationCsrfCookie = "artifact_csrf";
const loginHandshakeCookie = "artifact_login";
const secureApplicationSessionCookie = "__Host-artifact_session";
const secureApplicationCsrfCookie = "__Host-artifact_csrf";
const secureLoginHandshakeCookie = "__Host-artifact_login";
const loginHandshakeMaxAgeSeconds = 10 * 60;
/** Upper bound on one held claim poll, per the dispatch transport contract. */
const maximumClaimWaitSeconds = 25;
/** Spacing of the bounded re-checks inside one held claim poll. */
const claimRecheckIntervalMilliseconds = 1_000;

interface HttpEnvironment {
  readonly Variables: {
    readonly authenticationMethod: "bearer" | "session";
    readonly principal: Principal;
    readonly requestId: string;
    readonly requestSpan: Tracer.Span;
    readonly sessionCsrfDigest: string | null;
    readonly sessionToken: string | null;
  };
}

export interface HttpAppDependencies {
  readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
  readonly applicationRuntime: ApplicationRuntime;
  readonly blobs: BlobStore;
  /** Browser authentication policy fixed by the deployment entrypoint. */
  readonly browserAccess: BrowserAccess;
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string;
  /** Server-only credential accepted from the co-launched Vite proxy. */
  readonly developmentProxyCredential?: Redacted.Redacted;
  /** Secret-free optional Git state exposed through authenticated discovery. */
  readonly gitHistory?: GitHistoryCapabilityReader;
  /**
   * Advertises the linked-artifact capability (local deployment with
   * `ARTIFACT_SERVER_LINKED_FILES=on`). The enabled application service is
   * the enforcing guard; this flag only shapes discovery and fast gating.
   */
  readonly linkedArtifacts?: boolean;
  readonly mcpOAuthResource?: McpOAuthResourceConfiguration;
  readonly readiness?: ReadinessProbe;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly trustedApplicationOrigin: string | null;
  readonly webAssets?: WebAssetStore;
}

/** RFC 9728 metadata for the separately audience-bound HTTP API resource. */
export interface ApiOAuthResourceConfiguration {
  readonly authorizationServers: readonly [string, ...string[]];
  readonly resource: string;
}

/** WorkOS metadata and exact audience for the hosted MCP protected resource. */
export interface McpOAuthResourceConfiguration {
  readonly authorizationServerMetadata: OAuthMetadata;
  readonly resource: string;
}

/** Machine-readable result of one declared runtime dependency probe. */
export interface ReadinessComponent {
  readonly latencyMilliseconds: number;
  readonly status: "ready" | "unavailable";
}

/** Current readiness of the runtime dependencies required to serve requests. */
export interface ReadinessReport {
  readonly components: {
    readonly configuration: ReadinessComponent;
    readonly database: ReadinessComponent;
    readonly migrations: ReadinessComponent;
    readonly objectStorage: ReadinessComponent;
  };
  readonly status: "ready" | "not_ready";
  readonly lifecycle?: RuntimeLifecycleState;
}

/** Probe external-storage dependencies without changing application state. */
export type ReadinessProbe = () => Promise<ReadinessReport>;

/** Static management-application assets supplied by one deployment boundary. */
export interface WebAssetStore {
  readonly fetch: (
    assetPath: string,
    method: "GET" | "HEAD",
  ) => Promise<Response | null>;
}

export function createHttpApp(
  dependencies: HttpAppDependencies,
): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
  const applicationHostname = dependencies.trustedApplicationOrigin === null
    ? null
    : new URL(dependencies.trustedApplicationOrigin).hostname;
  const mcpAllowedHostnames = applicationHostname === null
    ? ["localhost", "127.0.0.1", "[::1]"]
    : [applicationHostname];
  const gitHistory = dependencies.gitHistory ?? fixedGitHistoryCapabilityReader(
    disabledGitHistoryCapability(),
  );
  const mcp = createMcpHttpAdapter({
    allowedHostnames: mcpAllowedHostnames,
    allowedOriginHostnames: mcpAllowedHostnames,
    applicationOrigin: dependencies.trustedApplicationOrigin,
    applicationRuntime: dependencies.applicationRuntime,
    contentDomain: dependencies.contentDomain,
    gitHistory,
    linkedArtifacts: dependencies.linkedArtifacts === true,
    mode: dependencies.trustedApplicationOrigin === null ? "local" : "remote",
    oauthResource: dependencies.mcpOAuthResource?.resource ?? null,
  });
  const boundedJsonBody = bodyLimit({
    maxSize: maximumJsonRequestBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The JSON request body exceeds the local API limit.",
          },
        },
        413,
      ),
  });
  const boundedUploadPlanBody = bodyLimit({
    maxSize: maximumUploadPlanRequestBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The file-upload plan exceeds the API limit.",
          },
        },
        413,
      ),
  });
  const boundedMcpBody = bodyLimit({
    maxSize: maximumUploadPlanRequestBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: -32_600,
            message: "The MCP request exceeds the request limit.",
          },
          id: null,
          jsonrpc: "2.0" as const,
        },
        413,
      ),
  });

  if (dependencies.mcpOAuthResource !== undefined) {
    const resourceServerUrl = new URL(
      dependencies.mcpOAuthResource.resource,
    );
    const metadataOptions = {
      oauthMetadata:
        dependencies.mcpOAuthResource.authorizationServerMetadata,
      resourceName: "Artifact Server MCP",
      resourceServerUrl,
    };
    const protectedMetadata = {
      ...buildOAuthProtectedResourceMetadata(metadataOptions),
      bearer_methods_supported: ["header"],
    };
    const protectedMetadataPath = new URL(
      getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    ).pathname;
    app.get(
      protectedMetadataPath,
      (context) => context.json(protectedMetadata),
    );
  }

  app.use("*", async (context, next) => {
    if (dependencies.mcpOAuthResource !== undefined) {
      const response = oauthMetadataResponse(
        context.req.raw,
        {
          oauthMetadata:
            dependencies.mcpOAuthResource.authorizationServerMetadata,
          resourceName: "Artifact Server MCP",
          resourceServerUrl: new URL(dependencies.mcpOAuthResource.resource),
        },
      );
      if (response !== undefined) {
        context.res = response;
        return;
      }
    }
    await next();
  });

  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    const method = safeHttpMethod(context.req.method);
    const requestSpan = await dependencies.applicationRuntime.runPromise(
      Effect.makeSpan("http.request", {
        attributes: {"http.request.method": method},
        kind: "server",
      }),
    );
    context.set("requestId", requestId);
    context.set("requestSpan", requestSpan);
    context.header("X-Request-Id", requestId);
    try {
      await next();
    } finally {
      const status = context.res.status;
      const matchedRoute = safeMatchedRoute(context);
      const protocol = matchedRoute === "/mcp" ? "mcp" : "http";
      const durationMilliseconds = performance.now() - startedAt;
      try {
        await runHttpApplicationEffect(
          context,
          dependencies,
          observeHttpRequest({
            completedRequestLogSampleRate:
              dependencies.completedRequestLogSampleRate,
            durationMilliseconds,
            method,
            protocol,
            requestId,
            route: matchedRoute,
            status,
          }),
        );
      } finally {
        requestSpan.attribute("http.route", matchedRoute);
        requestSpan.attribute("http.response.status_code", status);
        requestSpan.attribute("network.protocol.name", protocol);
        requestSpan.attribute("request.id", requestId);
        const endTime = await dependencies.applicationRuntime.runPromise(
          Clock.currentTimeNanos,
        );
        requestSpan.end(endTime, Exit.succeed(status));
      }
    }
  });

  app.use("*", async (context, next) => {
    const requestUrl = new URL(context.req.url);
    const contentToken = tokenFromContentHost(
      requestUrl.hostname,
      dependencies.contentDomain,
    );
    if (contentToken !== null) {
      if (isContentBootstrapRequest(requestUrl)) {
        return exchangeContentBootstrap(
          context,
          requestUrl,
          contentToken,
          dependencies,
        );
      }
      // A live-origin host is artifact-scoped: it streams a linked source's
      // current bytes to authenticated local members and never serves any
      // immutable version route. Everywhere the capability is absent the
      // application service answers the stable capability-unavailable shape.
      if (isLiveContentToken(contentToken)) {
        return serveLiveContent(
          context,
          contentToken,
          context.req.header("cookie"),
          dependencies,
        );
      }
      return serveVersionContent(
        context,
        requestUrl,
        contentToken,
        context.req.header("cookie"),
        dependencies,
      );
    }
    return next();
  });

  app.on(["GET", "HEAD"], "/assets/*", (context) =>
    serveWebAsset(
      context,
      dependencies,
      new URL(context.req.url).pathname,
      "static-asset",
    ));

  app.on(
    ["GET", "HEAD"],
    "/review-frame",
    (context) =>
      serveWebAsset(context, dependencies, "/review-frame.html", "review-frame"),
  );

  app.on(
    ["GET", "HEAD"],
    "/review",
    (context) =>
      serveWebAsset(context, dependencies, "/review.html", "application-shell"),
  );

  app.on(["GET", "HEAD"], "/workbench", (context) => {
    const requestUrl = new URL(context.req.url);
    return context.redirect(`/review${requestUrl.search}`, 308);
  });

  app.on(
    ["GET", "HEAD"],
    [
      "/",
      "/projects",
      "/projects/:projectId/artifacts",
      "/projects/:projectId/artifacts/:artifactId",
      "/projects/:projectId/artifacts/:artifactId/versions/:versionId/review",
      "/administration/members",
      "/administration/api-keys",
      "/administration/public-links",
    ],
    (context) =>
      serveWebAsset(context, dependencies, "/index.html", "application-shell"),
  );

  app.use("/api/*", async (context, next) => {
    const authorization = context.req.header("authorization");
    if (authorization !== undefined) {
      const parsed = bearerSchema.safeParse(authorization);
      if (!parsed.success) {
        throw new AuthenticationRequired({
          message: "A valid Artifact Server API key is required.",
        });
      }
      const principal = await runHttpApplicationEffect(
        context,
        dependencies,
        AuthenticationService.use((authentication) =>
          authentication.authenticateApiBearer(
            Redacted.make(parsed.data, {label: "bearer-credential"}),
          )
        ),
      );
      context.set("authenticationMethod", "bearer");
      context.set("principal", principal);
      context.set("sessionCsrfDigest", null);
      context.set("sessionToken", null);
      return next();
    }

    const cookieNames = applicationCookieNames(dependencies);
    const parsedSession = sessionTokenSchema.safeParse(
      getCookie(context, cookieNames.session),
    );
    if (!parsedSession.success) {
      throw new AuthenticationRequired({
        message: "A valid application session or API key is required.",
      });
    }
    const authenticated = await runHttpApplicationEffect(
      context,
      dependencies,
      AuthenticationService.use((authentication) =>
        authentication.authenticateApplicationSession(
          Redacted.make(parsedSession.data, {label: "application-session"}),
        )
      ),
    );
    context.set("authenticationMethod", "session");
    context.set("principal", authenticated.principal);
    context.set("sessionCsrfDigest", authenticated.csrfDigest);
    context.set("sessionToken", parsedSession.data);
    if (isUnsafeMethod(context.req.method)) {
      requireBrowserMutationSecurity(context, dependencies);
    }
    return next();
  });

  app.all("/mcp", boundedMcpBody, (context) =>
    mcp.fetch(requestWithRequestId(context)));

  app.get("/health", (context) =>
    context.json({status: "ok" as const}),
  );

  app.get("/.well-known/oauth-protected-resource/api", (context) => {
    if (dependencies.apiOAuthResource === undefined) return context.notFound();
    return context.json({
      authorization_servers: dependencies.apiOAuthResource.authorizationServers,
      bearer_methods_supported: ["header"],
      resource: dependencies.apiOAuthResource.resource,
      scopes_supported: ["artifactserver"],
    });
  });

  app.get("/ready", async (context) => {
    const lifecycle = dependencies.runtimeLifecycle?.current() ?? "ready";
    if (lifecycle !== "ready") {
      return context.json({lifecycle, status: "not_ready" as const}, 503);
    }
    if (dependencies.readiness === undefined) {
      return context.json({lifecycle, status: "ready" as const});
    }
    const report = await dependencies.readiness();
    return context.json(
      {...report, lifecycle},
      report.status === "ready" ? 200 : 503,
    );
  });

  app.get("/auth/context", (context) => {
    context.header("Cache-Control", "private, no-store");
    return context.json({
      accessMode: dependencies.browserAccess.mode,
      login: {kind: dependencies.browserAccess.loginKind},
    });
  });

  app.post("/auth/local-owner", async (context) => {
    if (dependencies.browserAccess.mode !== browserAccessModes.localOwner) {
      return context.notFound();
    }
    requireLocalOwnerExchangeBoundary(context, dependencies);
    const declaredBodyLength = context.req.header("content-length");
    if (
      (declaredBodyLength !== undefined && declaredBodyLength !== "0")
      || context.req.header("transfer-encoding") !== undefined
    ) {
      return context.json({
        error: {
          code: errorCodes.invalidInput,
          message: "The local-owner session request must have an empty body.",
        },
      }, 422);
    }
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) => access.loginAsLocalOwner()),
    );
    setApplicationSessionCookies(context, dependencies, issued);
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.body(null, 204);
  });

  app.post("/auth/local", async (context) => {
    if (dependencies.browserAccess.mode !== browserAccessModes.localOwner) {
      return context.notFound();
    }
    const requestUrl = new URL(context.req.url);
    if (!isLoopbackHostname(requestUrl.hostname)) {
      throw new AuthenticationRequired({
        message: "Local browser login is available only on loopback.",
      });
    }
    const authorization = bearerSchema.safeParse(
      context.req.header("authorization"),
    );
    if (!authorization.success) {
      throw new AuthenticationRequired({
        message: "The local browser-login credential is invalid.",
      });
    }
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.issueLocalBrowserLogin(
          Redacted.make(authorization.data, {
            label: "local-browser-bootstrap",
          }),
        )
      ),
    );
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.json({
      expiresAt: issued.expiresAt,
      token: Redacted.value(issued.token),
    }, 201);
  });

  app.get("/auth/local", async (context) => {
    if (dependencies.browserAccess.mode !== browserAccessModes.localOwner) {
      return context.notFound();
    }
    const requestUrl = new URL(context.req.url);
    if (!isLoopbackHostname(requestUrl.hostname)) {
      throw new AuthenticationRequired({
        message: "Local browser login is available only on loopback.",
      });
    }
    const query = localLoginQuerySchema.parse(context.req.query());
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.loginWithLocalBrowserToken(
          Redacted.make(query.token, {label: "local-browser-login"}),
        )
      ),
    );
    setApplicationSessionCookies(context, dependencies, issued);
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.redirect("/", 303);
  });

  app.get("/auth/login", async (context) => {
    const query = interactiveLoginQuerySchema.parse(context.req.query());
    const started = await runHttpApplicationEffect(
      context,
      dependencies,
      InteractiveLoginService.use((login) => login.start(query.returnTo)),
    );
    setLoginHandshakeCookie(context, dependencies, started.handshake);
    context.header("Cache-Control", "private, no-store");
    return context.redirect(started.authorizationUrl, 302);
  });

  app.get("/auth/callback", async (context) => {
    const query = interactiveCallbackSchema.parse(context.req.query());
    const handshake = getCookie(
      context,
      applicationCookieNames(dependencies).handshake,
    ) ?? null;
    const completed = await runHttpApplicationEffect(
      context,
      dependencies,
      InteractiveLoginService.use((login) =>
        login.complete({...query, handshake})
      ),
    );
    clearLoginHandshakeCookie(context, dependencies);
    setApplicationSessionCookies(context, dependencies, completed.issued);
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.redirect(completed.returnTo, 303);
  });

  app.get("/api/v1/session", (context) =>
    context.json({
      authenticationMethod: context.get("authenticationMethod"),
      capabilities: {
        gitHistory: gitHistory.read(),
        linkedArtifacts: dependencies.linkedArtifacts === true,
      },
      principal: context.get("principal"),
    }));

  app.post("/api/v1/session/logout", async (context) => {
    const sessionToken = context.get("sessionToken");
    if (sessionToken !== null) {
      await runHttpApplicationEffect(
        context,
        dependencies,
        InstallationAccessService.use((access) =>
          access.revokeSession(
            Redacted.make(sessionToken, {label: "application-session"}),
          )
        ),
      );
    }
    clearApplicationSessionCookies(context, dependencies);
    return context.body(null, 204);
  });

  app.get("/api/v1/members", async (context) => {
    const members = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.listMembers(context.get("principal"))
      ),
    );
    return context.json({members});
  });

  app.post("/api/v1/members", boundedJsonBody, async (context) => {
    const body = admitMemberSchema.parse(await context.req.json());
    const member = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.admitMember({
          displayName: body.displayName,
          email: body.email,
          principal: context.get("principal"),
          role: body.role,
        })
      ),
    );
    return context.json({member}, 201);
  });

  app.post("/api/v1/members/:memberId/deactivate", async (context) => {
    const member = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.deactivateMember(
          context.get("principal"),
          context.req.param("memberId"),
        )
      ),
    );
    return context.json({member});
  });

  app.get("/api/v1/api-keys", async (context) => {
    const apiKeys = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.listApiKeys(context.get("principal"))
      ),
    );
    return context.json({apiKeys});
  });

  app.post("/api/v1/api-keys", boundedJsonBody, async (context) => {
    const body = issueApiKeySchema.parse(await context.req.json());
    const issueCommand = body.memberId === undefined
      ? {
        capabilities: body.capabilities,
        expiresAt: body.expiresAt,
        name: body.name,
        principal: context.get("principal"),
      }
      : {
        capabilities: body.capabilities,
        expiresAt: body.expiresAt,
        memberId: body.memberId,
        name: body.name,
        principal: context.get("principal"),
      };
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.issueApiKey(issueCommand)
      ),
    );
    return context.json(issued, 201);
  });

  app.post("/api/v1/api-keys/:keyId/revoke", async (context) => {
    const apiKey = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.revokeApiKey(
          context.get("principal"),
          context.req.param("keyId"),
        )
      ),
    );
    return context.json({apiKey});
  });

  app.post("/api/v1/api-keys/:keyId/rotate", async (context) => {
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.rotateApiKey(
          context.get("principal"),
          context.req.param("keyId"),
        )
      ),
    );
    return context.json(issued, 201);
  });

  app.get("/api/v1/administration/public-links", async (context) => {
    const query = publicLinksPageQuerySchema.parse(context.req.query());
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      PublicLinkAdministrationService.use((administration) =>
        administration.listPublicLinks({
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
        })
      ),
    );
    return context.json(publicLinkInventoryPageResponse(
      responseApplicationUrl(context, dependencies),
      page,
    ));
  });

  app.post(
    "/api/v1/administration/public-links/make-private",
    boundedJsonBody,
    async (context) => {
      const body = makePublicLinksPrivateSchema.parse(await context.req.json());
      const results = await runHttpApplicationEffect(
        context,
        dependencies,
        PublicLinkAdministrationService.use((administration) =>
          administration.makePrivate({
            items: body.items,
            principal: context.get("principal"),
          })
        ),
      );
      return context.json(publicLinkMutationResponse(results));
    },
  );

  app.post("/api/v1/agents", boundedJsonBody, async (context) => {
    const body = registerAgentSchema.parse(await context.req.json());
    const agent = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.registerAgent({
          agentSessionId: body.agentSessionId ?? null,
          connectionKey: body.connectionKey ??
            derivedConnectionKey(
              context.get("principal").id,
              body.workingDirectory,
            ),
          displayName: body.displayName,
          kind: body.kind,
          principal: context.get("principal"),
          workingDirectory: body.workingDirectory,
        })
      ),
    );
    return context.json({agent: registeredAgentResponse(agent)});
  });

  app.get("/api/v1/agents", async (context) => {
    const agents = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.listAgents({principal: context.get("principal")})
      ),
    );
    return context.json({items: agents.map(connectedAgentResponse)});
  });

  app.post("/api/v1/agents/:agentId/disconnect", async (context) => {
    await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.disconnectAgent({
          agentId: context.req.param("agentId"),
          principal: context.get("principal"),
        })
      ),
    );
    return context.body(null, 204);
  });

  app.post("/api/v1/agents/:agentId/claims", async (context) => {
    const query = claimDispatchQuerySchema.parse(context.req.query());
    const agentId = context.req.param("agentId");
    const principal = context.get("principal");
    const dispatch = await claimWithinPollDeadline(
      // The poll request is the heartbeat: its first attempt bumps the
      // agent's lastSeenAt, while the bounded re-checks inside the same held
      // request stay pure reads until a dispatch is actually claimable.
      (bumpHeartbeat) =>
        runHttpApplicationEffect(
          context,
          dependencies,
          AgentDispatchService.use((dispatches) =>
            dispatches.claimDispatch({agentId, bumpHeartbeat, principal})
          ),
        ),
      Date.now() + Math.min(query.wait, maximumClaimWaitSeconds) * 1_000,
      context.req.raw.signal,
    );
    return dispatch === null
      ? context.body(null, 204)
      : context.json({dispatch: agentDispatchResponse(dispatch)});
  });

  app.post("/api/v1/agent-dispatches", boundedJsonBody, async (context) => {
    const body = createAgentDispatchSchema.parse(await context.req.json());
    const created = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.createDispatch({
          agentId: body.agentId,
          idempotencyKey: requiredIdempotencyKey(
            context.req.header("idempotency-key"),
          ),
          note: body.note ?? null,
          principal: context.get("principal"),
          projectId: body.projectId ?? requestedProjectId(context),
          threadIds: body.threadIds,
        })
      ),
    );
    return context.json({
      dispatch: agentDispatchResponse(created.dispatch),
      replayed: created.replayed,
    }, 201);
  });

  app.get("/api/v1/agent-dispatches", async (context) => {
    const query = agentDispatchPageQuerySchema.parse(context.req.query());
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.listDispatches({
          agentId: query.agentId ?? null,
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          state: query.state ?? null,
        })
      ),
    );
    return context.json(agentDispatchPageResponse(page));
  });

  app.get("/api/v1/agent-dispatches/:dispatchId", async (context) => {
    const dispatch = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.getDispatch({
          dispatchId: context.req.param("dispatchId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json({dispatch: agentDispatchResponse(dispatch)});
  });

  app.post(
    "/api/v1/agent-dispatches/:dispatchId/delivered",
    boundedJsonBody,
    async (context) => {
      const body = await parseOptionalJsonBody(
        context,
        reportDispatchDeliveredSchema,
      );
      const dispatch = await runHttpApplicationEffect(
        context,
        dependencies,
        AgentDispatchService.use((dispatches) =>
          dispatches.reportDelivered({
            agentId: reportingAgentId(context, body.agentId),
            dispatchId: context.req.param("dispatchId"),
            principal: context.get("principal"),
          })
        ),
      );
      return context.json({dispatch: agentDispatchResponse(dispatch)});
    },
  );

  app.post(
    "/api/v1/agent-dispatches/:dispatchId/failed",
    boundedJsonBody,
    async (context) => {
      const body = reportDispatchFailedSchema.parse(await context.req.json());
      const dispatch = await runHttpApplicationEffect(
        context,
        dependencies,
        AgentDispatchService.use((dispatches) =>
          dispatches.reportFailed({
            agentId: reportingAgentId(context, body.agentId),
            dispatchId: context.req.param("dispatchId"),
            principal: context.get("principal"),
            reason: body.reason,
          })
        ),
      );
      return context.json({dispatch: agentDispatchResponse(dispatch)});
    },
  );

  app.post("/api/v1/agent-dispatches/:dispatchId/cancel", async (context) => {
    const dispatch = await runHttpApplicationEffect(
      context,
      dependencies,
      AgentDispatchService.use((dispatches) =>
        dispatches.cancelDispatch({
          dispatchId: context.req.param("dispatchId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json({dispatch: agentDispatchResponse(dispatch)});
  });

  app.get("/api/v1/projects", async (context) => {
    const projects = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectManagementService.use((management) =>
        management.listProjects(context.get("principal"))
      ),
    );
    return context.json({projects});
  });

  app.post("/api/v1/projects", boundedJsonBody, async (context) => {
    const body = createProjectSchema.parse(await context.req.json());
    const project = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectManagementService.use((management) =>
        management.createProject({
          name: body.name,
          principal: context.get("principal"),
        })
      ),
    );
    return context.json({project}, 201);
  });

  app.get("/api/v1/projects/:projectId", async (context) => {
    const project = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectManagementService.use((management) =>
        management.getProject({
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        })
      ),
    );
    return context.json({project});
  });

  app.patch(
    "/api/v1/projects/:projectId",
    boundedJsonBody,
    async (context) => {
      const body = renameProjectSchema.parse(await context.req.json());
      const project = await runHttpApplicationEffect(
        context,
        dependencies,
        ProjectManagementService.use((management) =>
          management.renameProject({
            name: body.name,
            principal: context.get("principal"),
            projectId: projectIdSchema.parse(context.req.param("projectId")),
          })
        ),
      );
      return context.json({project});
    },
  );

  app.post("/api/v1/projects/:projectId/archive", async (context) => {
    const project = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectManagementService.use((management) =>
        management.archiveProject({
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        })
      ),
    );
    return context.json({project});
  });

  app.post("/api/v1/projects/:projectId/unarchive", async (context) => {
    const project = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectManagementService.use((management) =>
        management.unarchiveProject({
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        })
      ),
    );
    return context.json({project});
  });

  app.get("/api/v1/projects/:projectId/git-history", async (context) => {
    const projectGitHistory = await runHttpApplicationEffect(
      context,
      dependencies,
      ProjectGitHistoryService.use((service) => service.read({
        principal: context.get("principal"),
        projectId: projectIdSchema.parse(context.req.param("projectId")),
      })),
    );
    return context.json({gitHistory: projectGitHistory});
  });

  app.post(
    "/api/v1/projects/:projectId/git-history/estimate",
    async (context) => {
      const estimate = await runHttpApplicationEffect(
        context,
        dependencies,
        ProjectGitHistoryService.use((service) => service.estimate({
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        })),
      );
      return context.json({estimate});
    },
  );

  app.put(
    "/api/v1/projects/:projectId/git-history",
    boundedJsonBody,
    async (context) => {
      const body = setProjectGitHistorySchema.parse(await context.req.json());
      const command = body.enabled
        ? {
          confirmEstimate: true as const,
          enabled: true as const,
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        }
        : {
          enabled: false as const,
          principal: context.get("principal"),
          projectId: projectIdSchema.parse(context.req.param("projectId")),
        };
      const projectGitHistory = await runHttpApplicationEffect(
        context,
        dependencies,
        ProjectGitHistoryService.use((service) => service.set(command)),
      );
      return context.json({gitHistory: projectGitHistory});
    },
  );

  app.post("/api/v1/artifacts", (context) => {
    context.header("Allow", "GET");
    return context.json({
      error: {
        code: errorCodes.methodNotAllowed,
        message: "Publish files through POST /api/v1/uploads and the server-issued upload plan.",
      },
    }, 405);
  });

  app.get("/api/v1/artifacts", async (context) => {
    const query = pageQuerySchema.parse(context.req.query());
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      ArtifactManagementService.use((management) =>
        management.listArtifacts({
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          tag: query.tag ?? null,
        })
      ),
    );
    return context.json(artifactPageResponse(
      responseApplicationUrl(context, dependencies),
      page,
    ));
  });

  app.get("/api/v1/artifacts/:artifactId", async (context) => {
    const read = await runHttpApplicationEffect(
      context,
      dependencies,
      Effect.gen(function*() {
        const management = yield* ArtifactManagementService;
        const details = yield* management.getArtifact({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        });
        // The binding observation is a lazy local-deployment decoration;
        // everywhere else the disabled service answers null and the read
        // shape stays exactly what it is today.
        const linked = yield* LinkedArtifactService;
        const binding = dependencies.linkedArtifacts === true
          ? yield* linked.observeBinding({
            artifactId: details.artifact.id,
            principal: context.get("principal"),
            projectId: details.artifact.projectId,
          })
          : null;
        return {binding, details};
      }),
    );
    const requestUrl = responseApplicationUrl(context, dependencies);
    const response = artifactDetailsResponse(
      requestUrl,
      dependencies.contentDomain,
      read.details,
    );
    if (read.binding === null) return context.json(response);
    const live = liveLink(requestUrl, dependencies, read.details.artifact.id);
    return context.json({
      ...response,
      links: live === null ? response.links : {...response.links, live},
      sourceBinding: sourceBindingResponse(read.binding),
    });
  });

  app.get("/api/v1/artifacts/:artifactId/versions", async (context) => {
    const versions = await runHttpApplicationEffect(
      context,
      dependencies,
      ArtifactManagementService.use((management) =>
        management.listVersions({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    const requestUrl = responseApplicationUrl(context, dependencies);
    return context.json({
      artifactId: context.req.param("artifactId"),
      versions: versions.map((version) => versionResponse(
        requestUrl,
        dependencies.contentDomain,
        version,
      )),
    });
  });

  app.get("/api/v1/artifacts/:artifactId/actions", async (context) => {
    const query = pageQuerySchema.parse(context.req.query());
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      ArtifactManagementService.use((management) =>
        management.listArtifactActions({
          artifactId: context.req.param("artifactId"),
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json(artifactActionPageResponse(page));
  });

  app.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId",
    async (context) => {
      const saved = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json(artifactVersionResponse(
        responseApplicationUrl(context, dependencies),
        dependencies.contentDomain,
        saved,
      ));
    },
  );

  app.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId/file",
    async (context) => {
      const query = versionFileQuerySchema.parse(context.req.query());
      const saved = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return serveVersionFile(
        saved,
        query.path,
        context.req.method,
        context.req.raw.headers,
        dependencies,
      );
    },
  );

  app.on(
    ["GET", "HEAD"],
    "/api/v1/artifacts/:artifactId/versions/:versionId/media",
    async (context) => {
      const query = versionFileQuerySchema.parse(context.req.query());
      const saved = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return serveVersionMedia(
        saved,
        query.path,
        context.req.method,
        context.req.raw.headers,
        context.get("authenticationMethod"),
        dependencies,
      );
    },
  );

  app.get("/api/v1/artifacts/:artifactId/comparisons", async (context) => {
    const query = comparisonQuerySchema.parse(context.req.query());
    const comparison = await runHttpApplicationEffect(
      context,
      dependencies,
      CompareArtifactService.use((comparisons) =>
        comparisons.compareVersions({
          artifactId: context.req.param("artifactId"),
          fromVersionId: query.fromVersionId,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          toVersionId: query.toVersionId,
        })
      ),
    );
    return context.json(comparisonResponse(
      responseApplicationUrl(context, dependencies),
      dependencies.contentDomain,
      comparison,
    ));
  });

  app.get("/api/v1/artifacts/:artifactId/comments", async (context) => {
    const query = commentPageQuerySchema.parse(context.req.query());
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      ArtifactCommentService.use((comments) =>
        comments.listThreads({
          artifactId: context.req.param("artifactId"),
          cursor: decodePageCursor(query.cursor),
          dispatched: query.dispatched,
          limit: query.limit,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          since: query.since ?? null,
          state: query.state ?? null,
          versionId: query.versionId ?? null,
        })
      ),
    );
    return context.json(commentThreadPageResponse(
      responseApplicationUrl(context, dependencies),
      page,
    ));
  });

  app.post(
    "/api/v1/artifacts/:artifactId/versions/:versionId/comments",
    boundedJsonBody,
    async (context) => {
      const body = createCommentThreadSchema.parse(await context.req.json());
      const created = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.createThread({
            anchor: body.anchor ?? null,
            artifactId: context.req.param("artifactId"),
            body: body.body,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            path: body.path ?? null,
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json({
        replayed: created.replayed,
        thread: commentThreadResponse(
          responseApplicationUrl(context, dependencies),
          created.thread,
        ),
      }, 201);
    },
  );

  app.get(
    "/api/v1/artifacts/:artifactId/comments/:threadId",
    async (context) => {
      const details = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.getThread({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            threadId: context.req.param("threadId"),
          })
        ),
      );
      return context.json(commentThreadDetailsResponse(
        responseApplicationUrl(context, dependencies),
        details,
      ));
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/comments/:threadId",
    boundedJsonBody,
    async (context) => {
      const body = updateCommentThreadSchema.parse(await context.req.json());
      const thread = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.updateThread(updateCommentThreadCommand(
            {
              artifactId: context.req.param("artifactId"),
              principal: context.get("principal"),
              projectId: requestedProjectId(context),
              threadId: context.req.param("threadId"),
            },
            body,
          ))
        ),
      );
      return context.json({
        thread: commentThreadResponse(
          responseApplicationUrl(context, dependencies),
          thread,
        ),
      });
    },
  );

  app.delete(
    "/api/v1/artifacts/:artifactId/comments/:threadId",
    async (context) => {
      await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.deleteThread({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            threadId: context.req.param("threadId"),
          })
        ),
      );
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/v1/artifacts/:artifactId/comments/:threadId/replies",
    boundedJsonBody,
    async (context) => {
      const body = createCommentReplySchema.parse(await context.req.json());
      const created = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.createReply({
            artifactId: context.req.param("artifactId"),
            body: body.body,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            threadId: context.req.param("threadId"),
          })
        ),
      );
      return context.json(
        {replayed: created.replayed, reply: created.reply},
        201,
      );
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/comments/:threadId/replies/:replyId",
    boundedJsonBody,
    async (context) => {
      const body = updateCommentReplySchema.parse(await context.req.json());
      const reply = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.updateReply({
            artifactId: context.req.param("artifactId"),
            body: body.body,
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            replyId: context.req.param("replyId"),
            threadId: context.req.param("threadId"),
          })
        ),
      );
      return context.json({reply});
    },
  );

  app.delete(
    "/api/v1/artifacts/:artifactId/comments/:threadId/replies/:replyId",
    async (context) => {
      await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactCommentService.use((comments) =>
          comments.deleteReply({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            replyId: context.req.param("replyId"),
            threadId: context.req.param("threadId"),
          })
        ),
      );
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/v1/artifacts/:artifactId/restore",
    boundedJsonBody,
    async (context) => {
      const body = restoreVersionSchema.parse(await context.req.json());
      const state = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.restoreVersion({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: body.versionId,
          })
        ),
      );
      return context.json(artifactStateResponse(
        responseApplicationUrl(context, dependencies),
        dependencies.contentDomain,
        state,
      ));
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/access",
    boundedJsonBody,
    async (context) => {
      const body = changeAccessSchema.parse(await context.req.json());
      const state = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.changeAccess({
            accessSetting: body.accessSetting,
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
          })
        ),
      );
      return context.json({
        ...artifactStateResponse(
          responseApplicationUrl(context, dependencies),
          dependencies.contentDomain,
          state,
        ),
        warning: body.accessSetting === accessSettings.accountRequired
          ? "New public requests are blocked. Copies already downloaded or cached outside Artifact Server cannot be recalled."
          : null,
      });
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/tags",
    boundedJsonBody,
    async (context) => {
      const body = changeTagsSchema.parse(await context.req.json());
      const state = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.changeTags({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            tags: body.tags,
          })
        ),
      );
      return context.json(artifactStateResponse(
        responseApplicationUrl(context, dependencies),
        dependencies.contentDomain,
        state,
      ));
    },
  );

  app.delete(
    "/api/v1/artifacts/:artifactId",
    boundedJsonBody,
    async (context) => {
      const body = deleteArtifactSchema.parse(await context.req.json());
      const deletion = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.deleteArtifact({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
          })
        ),
      );
      return context.json(deletionResponse(deletion));
    },
  );

  app.post("/api/v1/artifacts/:artifactId/versions", (context) => {
    context.header("Allow", "GET");
    return context.json({
      error: {
        code: errorCodes.methodNotAllowed,
        message: "Publish files through POST /api/v1/uploads and the server-issued upload plan.",
      },
    }, 405);
  });

  app.post("/api/v1/uploads", boundedUploadPlanBody, async (context) => {
    const body = createUploadSchema.parse(await context.req.json());
    const upload = await runHttpApplicationEffect(
      context,
      dependencies,
      StagedUploadService.use((stagedUploads) =>
        stagedUploads.createUpload({
          entryPath: body.entryPath,
          files: body.files,
          principal: context.get("principal"),
          projectId: body.projectId ?? null,
          routingMode: body.routingMode,
        })
      ),
    );
    const requestUrl = responseApplicationUrl(context, dependencies);
    const projectQuery = `?projectId=${encodeURIComponent(upload.projectId)}`;
    return context.json({
      commitUrl: new URL(
        `/api/v1/uploads/${upload.id}/commit${projectQuery}`,
        requestUrl,
      ).toString(),
      expiresAt: upload.expiresAt,
      files: upload.files.map((file) => ({
        method: "PUT" as const,
        path: file.entry.path,
        size: file.entry.size,
        uploadUrl: new URL(
          `/api/v1/uploads/${upload.id}/files/${file.storageToken}${projectQuery}`,
          requestUrl,
        ).toString(),
      })),
      manifestDigest: upload.manifest.digest,
      projectId: upload.projectId,
      uploadId: upload.id,
    }, 201);
  });

  app.put("/api/v1/uploads/:uploadId/files/:storageToken", async (context) => {
    const body = context.req.raw.body ?? emptyByteStream();
    const upload = await runHttpApplicationEffect(
      context,
      dependencies,
      StagedUploadService.use((stagedUploads) =>
        stagedUploads.uploadFile({
          body,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          storageToken: context.req.param("storageToken"),
          uploadId: context.req.param("uploadId"),
        })
      ),
    );
    const file = upload.files.find(
      (candidate) => candidate.storageToken === context.req.param("storageToken"),
    );
    if (file === undefined) {
      throw new Error("A staged file disappeared after it was marked as uploaded.");
    }
    return context.json({
      path: file.entry.path,
      status: "verified" as const,
      uploadId: upload.id,
    });
  });

  app.post(
    "/api/v1/uploads/:uploadId/commit",
    boundedJsonBody,
    async (context) => {
      const body = commitUploadSchema.parse(await context.req.json());
      const result = await runHttpApplicationEffect(
        context,
        dependencies,
        StagedUploadService.use((stagedUploads) =>
          stagedUploads.commitUpload({
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            target: body.target,
            uploadId: context.req.param("uploadId"),
          })
        ),
      );
      return context.json(
        publishResponse(
          responseApplicationUrl(context, dependencies),
          dependencies.contentDomain,
          result,
        ),
        result.replayed ? 200 : 201,
      );
    },
  );

  app.post("/api/v1/artifacts/:artifactId/content-sessions", async (context) => {
    const destinationPath = requestedContentPath(context);
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      ContentAccessService.use((contentAccess) =>
        contentAccess.issueContentBootstrap({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
          target: {kind: "current"},
        })
      ),
    );
    return context.json({
      bootstrapUrl: contentBootstrapBrowserUrl(
        responseApplicationUrl(context, dependencies),
        dependencies.contentDomain,
        issued.contentToken,
        Redacted.value(issued.token),
        destinationPath,
      ),
      expiresAt: issued.expiresAt,
      versionId: issued.versionId,
    }, 201);
  });

  app.post(
    "/api/v1/artifacts/:artifactId/versions/:versionId/content-sessions",
    async (context) => {
      const destinationPath = requestedContentPath(context);
      const issued = await runHttpApplicationEffect(
        context,
        dependencies,
        ContentAccessService.use((contentAccess) =>
          contentAccess.issueContentBootstrap({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            target: {
              kind: "version",
              versionId: context.req.param("versionId"),
            },
          })
        ),
      );
      return context.json({
        bootstrapUrl: contentBootstrapBrowserUrl(
          responseApplicationUrl(context, dependencies),
          dependencies.contentDomain,
          issued.contentToken,
          Redacted.value(issued.token),
          destinationPath,
        ),
        expiresAt: issued.expiresAt,
        versionId: issued.versionId,
      }, 201);
    },
  );

  app.post("/api/v1/artifacts/link", boundedJsonBody, async (context) => {
    requireLinkedRequest(context, dependencies);
    const body = linkArtifactSchema.parse(await context.req.json());
    let linkCommand: Parameters<
      LinkedArtifactService["Service"]["linkArtifact"]
    >[0] = {
      idempotencyKey: requiredIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      path: body.path,
      principal: context.get("principal"),
      projectId: body.projectId ?? requestedProjectId(context),
    };
    if (body.name !== undefined) {
      linkCommand = {...linkCommand, name: body.name};
    }
    const linkedPublication = await runHttpApplicationEffect(
      context,
      dependencies,
      LinkedArtifactService.use((linked) => linked.linkArtifact(linkCommand)),
    );
    return context.json(
      linkedPublicationResponse(context, dependencies, linkedPublication),
      201,
    );
  });

  app.post("/api/v1/artifacts/:artifactId/capture", boundedJsonBody, async (context) => {
    requireLinkedRequest(context, dependencies);
    const body = captureArtifactSchema.parse(await context.req.json());
    const linkedPublication = await runHttpApplicationEffect(
      context,
      dependencies,
      LinkedArtifactService.use((linked) =>
        linked.captureArtifact({
          artifactId: context.req.param("artifactId"),
          expectedCurrentVersionId: body.expectedCurrentVersionId,
          idempotencyKey: requiredIdempotencyKey(
            context.req.header("idempotency-key"),
          ),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json(
      linkedPublicationResponse(context, dependencies, linkedPublication),
      201,
    );
  });

  app.put("/api/v1/artifacts/:artifactId/source", boundedJsonBody, async (context) => {
    requireLinkedRequest(context, dependencies);
    const body = relinkArtifactSchema.parse(await context.req.json());
    const binding = await runHttpApplicationEffect(
      context,
      dependencies,
      LinkedArtifactService.use((linked) =>
        linked.relinkArtifact({
          artifactId: context.req.param("artifactId"),
          expectedSha256: body.expectedSha256,
          idempotencyKey: requiredIdempotencyKey(
            context.req.header("idempotency-key"),
          ),
          path: body.path,
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json({sourceBinding: sourceBindingResponse(binding)});
  });

  app.post("/api/v1/artifacts/:artifactId/live-sessions", async (context) => {
    requireLinkedRequest(context, dependencies);
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      LinkedArtifactService.use((linked) =>
        linked.issueLiveBootstrap({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json({
      bootstrapUrl: contentBootstrapBrowserUrl(
        responseApplicationUrl(context, dependencies),
        dependencies.contentDomain,
        issued.contentToken,
        Redacted.value(issued.token),
      ),
      expiresAt: issued.expiresAt,
    }, 201);
  });

  app.get("/artifacts/:artifactId", async (context) => {
    const current = await runHttpApplicationEffect(
      context,
      dependencies,
      ContentAccessService.use((contentAccess) =>
        contentAccess.resolvePublicArtifact(context.req.param("artifactId"))
      ),
    );
    const versionUrl = versionBrowserUrl(
      responseApplicationUrl(context, dependencies),
      dependencies.contentDomain,
      current.version.contentToken,
    );
    return context.redirect(versionUrl, 302);
  });

  app.notFound((context) =>
    context.json(
      {error: {code: "NOT_FOUND", message: "The requested route does not exist."}},
      404,
    ),
  );

  app.onError(async (error, context) => {
    if (isArtifactServerFailure(error)) {
      const response = httpFailure(error);
      if (response.status >= 500) {
        await logAdapterFailure(
          dependencies.applicationRuntime,
          context.get("requestId"),
          error._tag,
          "request",
        );
      }
      const headers = new Headers();
      if (response.status === 401) {
        headers.set("Cache-Control", "private, no-store");
      }
      if (error._tag === "AuthenticationRequired") {
        headers.set(
          "WWW-Authenticate",
          apiBearerChallenge(context, dependencies),
        );
      }
      return Response.json(
        {error: {code: response.code, message: response.message}},
        {
          headers,
          status: response.status,
        },
      );
    }
    if (error instanceof z.ZodError) {
      return context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The request does not match the API contract.",
          },
        },
        422,
      );
    }
    if (error instanceof SyntaxError) {
      return context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The request body is not valid JSON.",
          },
        },
        400,
      );
    }
    await logAdapterFailure(
      dependencies.applicationRuntime,
      context.get("requestId"),
      "UnhandledError",
      error.name,
    );
    return context.json(
      {error: {code: "INTERNAL_ERROR", message: "The server could not complete the request."}},
      500,
    );
  });

  return app;
}

function apiBearerChallenge(
  context: {readonly req: {readonly path: string}},
  dependencies: HttpAppDependencies,
): string {
  if (
    dependencies.apiOAuthResource === undefined
    || !context.req.path.startsWith("/api/")
  ) return "Bearer";
  const metadata = new URL(
    "/.well-known/oauth-protected-resource/api",
    dependencies.apiOAuthResource.resource,
  );
  return `Bearer resource_metadata="${metadata.toString()}" scope="artifactserver"`;
}

function setApplicationSessionCookies(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
  issued: IssuedApplicationSession,
): void {
  const cookieNames = applicationCookieNames(dependencies);
  const secure = usesSecureApplicationCookies(dependencies);
  const expires = new Date(issued.session.expiresAt);
  setCookie(context, cookieNames.session, issued.token, {
    expires,
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure,
  });
  setCookie(context, cookieNames.csrf, issued.csrfToken, {
    expires,
    httpOnly: false,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

function setLoginHandshakeCookie(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
  handshake: string,
): void {
  setCookie(context, applicationCookieNames(dependencies).handshake, handshake, {
    httpOnly: true,
    maxAge: loginHandshakeMaxAgeSeconds,
    path: "/",
    sameSite: "Lax",
    secure: usesSecureApplicationCookies(dependencies),
  });
}

function clearLoginHandshakeCookie(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  deleteCookie(context, applicationCookieNames(dependencies).handshake, {
    path: "/",
    secure: usesSecureApplicationCookies(dependencies),
  });
}

function clearApplicationSessionCookies(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  const cookieNames = applicationCookieNames(dependencies);
  const secure = usesSecureApplicationCookies(dependencies);
  deleteCookie(context, cookieNames.session, {path: "/", secure});
  deleteCookie(context, cookieNames.csrf, {path: "/", secure});
}

function applicationCookieNames(
  dependencies: HttpAppDependencies,
): {
  readonly csrf: string;
  readonly handshake: string;
  readonly session: string;
} {
  return usesSecureApplicationCookies(dependencies)
    ? {
      csrf: secureApplicationCsrfCookie,
      handshake: secureLoginHandshakeCookie,
      session: secureApplicationSessionCookie,
    }
    : {
      csrf: applicationCsrfCookie,
      handshake: loginHandshakeCookie,
      session: applicationSessionCookie,
    };
}

function usesSecureApplicationCookies(
  dependencies: HttpAppDependencies,
): boolean {
  return dependencies.trustedApplicationOrigin !== null &&
    new URL(dependencies.trustedApplicationOrigin).protocol === "https:";
}

function responseApplicationUrl(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): URL {
  const requestUrl = new URL(context.req.url);
  if (dependencies.trustedApplicationOrigin === null) return requestUrl;
  const trustedUrl = new URL(dependencies.trustedApplicationOrigin);
  const forwardedProtocol = context.req.header("x-forwarded-proto")
    ?.split(",")[0]?.trim();
  const forwardedHost = context.req.header("x-forwarded-host")
    ?.split(",")[0]?.trim() ?? context.req.header("host");
  if (
    `${forwardedProtocol}:` === trustedUrl.protocol &&
    forwardedHost?.toLocaleLowerCase("en-US") ===
      trustedUrl.host.toLocaleLowerCase("en-US")
  ) {
    return trustedUrl;
  }
  return requestUrl;
}

function requireBrowserMutationSecurity(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  const requestUrl = new URL(context.req.url);
  const trustedOrigin = dependencies.trustedApplicationOrigin ?? requestUrl.origin;
  const origin = context.req.header("origin");
  const fetchSite = context.req.header("sec-fetch-site");
  const fetchMode = context.req.header("sec-fetch-mode");
  if (
    origin !== trustedOrigin || fetchSite !== "same-origin" ||
    (fetchMode !== "cors" && fetchMode !== "same-origin" && fetchMode !== "navigate")
  ) {
    throw new AuthorizationDenied({
      message: "Browser mutations must come from the Artifact Server application origin.",
    });
  }

  const names = applicationCookieNames(dependencies);
  const headerToken = csrfTokenSchema.safeParse(context.req.header("x-csrf-token"));
  const cookieToken = csrfTokenSchema.safeParse(getCookie(context, names.csrf));
  const expectedDigest = context.get("sessionCsrfDigest");
  if (
    !headerToken.success || !cookieToken.success || expectedDigest === null ||
    headerToken.data !== cookieToken.data ||
    digestIdentitySecret(headerToken.data) !== expectedDigest
  ) {
    throw new AuthorizationDenied({
      message: "A valid browser CSRF token is required.",
    });
  }
}

function requireLocalOwnerExchangeBoundary(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  const requestUrl = new URL(context.req.url);
  const proxyCredential = context.req.header(
    "x-artifact-server-development-proxy",
  );
  const configuredProxyCredential = dependencies.developmentProxyCredential;
  const validDevelopmentProxy = proxyCredential !== undefined
    && configuredProxyCredential !== undefined
    && identitySecretsEqual(
      proxyCredential,
      Redacted.value(configuredProxyCredential),
    );
  const hasForwardedIdentity = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ].some((name) => context.req.header(name) !== undefined);
  const fetchMode = context.req.header("sec-fetch-mode");
  if (
    !isLoopbackHostname(requestUrl.hostname)
    || context.req.header("origin") !== requestUrl.origin
    || context.req.header("sec-fetch-site") !== "same-origin"
    || (fetchMode !== "cors" && fetchMode !== "same-origin")
    || hasForwardedIdentity
    || (proxyCredential !== undefined && !validDevelopmentProxy)
  ) {
    throw new AuthorizationDenied({
      message: "Local-owner access is available only to the loopback application origin.",
    });
  }
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function requestedProjectId(context: Context<HttpEnvironment>): string | null {
  const projectId = context.req.query("projectId");
  return projectId === undefined ? null : projectIdSchema.parse(projectId);
}

function requestedContentPath(
  context: Context<HttpEnvironment>,
): string | undefined {
  const requested = context.req.query("path");
  return requested === undefined
    ? undefined
    : parseManifestPath(z.string().min(1).max(1_024).parse(requested));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeMatchedRoute(context: Context<HttpEnvironment>): string {
  const matched = routePath(context);
  return matched === "" || matched === "*" || matched === "/*"
    ? "unmatched"
    : matched;
}

function safeHttpMethod(method: string): string {
  switch (method) {
    case "CONNECT":
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
    case "TRACE":
      return method;
    default:
      return "OTHER";
  }
}

function runHttpApplicationEffect<A, E>(
  context: Context<HttpEnvironment>,
  dependencies: Pick<HttpAppDependencies, "applicationRuntime">,
  effect: Effect.Effect<A, E, ApplicationServices>,
): Promise<A> {
  const matchedRoute = safeMatchedRoute(context);
  return runApplicationEffect(
    dependencies.applicationRuntime,
    effect,
    {
      parent: context.get("requestSpan"),
      requestId: context.get("requestId"),
      spanName: `${safeHttpMethod(context.req.method)} ${matchedRoute}`,
    },
  );
}

function requestWithRequestId(context: Context<HttpEnvironment>): Request {
  const headers = new Headers(context.req.raw.headers);
  headers.set("x-artifact-request-id", context.get("requestId"));
  return new Request(context.req.raw, {headers});
}

interface PublishResponse {
  readonly artifact: PublishedVersion["artifact"];
  readonly links: {
    readonly artifact: string;
    readonly review: string;
    readonly version: string;
  };
  readonly replayed: boolean;
  readonly version: PublishedVersion["version"];
}

function httpFailure(failure: ArtifactServerFailure) {
  return artifactServerFailureResponse(failure);
}

function logAdapterFailure(
  runtime: ApplicationRuntime,
  requestId: string,
  failureTag: string,
  operation: string,
): Promise<void> {
  return runApplicationEffect(
    runtime,
    Effect.logError("http.request.failed").pipe(
      Effect.annotateLogs({
        failure_tag: failureTag,
        operation,
        request_id: requestId,
      }),
    ),
    {requestId, spanName: "http.request.failure"},
  );
}

function publishResponse(
  requestUrl: URL,
  contentDomain: string,
  published: PublishedVersion,
): PublishResponse {
  const artifactUrl = artifactBrowserUrl(requestUrl, published.artifact.id);
  const reviewUrl = artifactReviewUrl(
    requestUrl,
    published.artifact.projectId,
    published.artifact.id,
    published.version.id,
  );
  const versionUrl = versionBrowserUrl(
    requestUrl,
    contentDomain,
    published.version.contentToken,
  );
  return {
    artifact: published.artifact,
    links: {
      artifact: artifactUrl,
      review: reviewUrl,
      version: versionUrl,
    },
    replayed: published.replayed,
    version: published.version,
  };
}

/**
 * Fast deployment gate for linked-artifact routes: the capability exists
 * only on a local deployment (loopback application origin) that enabled it.
 * The application service enforces the same boundary; this check just keeps
 * the stable capability-unavailable answer cheap and origin-checked.
 */
function requireLinkedRequest(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  const hostname = new URL(context.req.url).hostname;
  if (dependencies.linkedArtifacts !== true || !isLoopbackHostname(hostname)) {
    throw new CapabilityUnavailable({
      message: "Linked artifacts are not available on this deployment.",
    });
  }
}

function sourceBindingResponse(binding: SourceBindingRecord) {
  return {
    lastVerifiedAt: binding.lastVerifiedAt,
    path: binding.path,
    status: binding.freshness,
  };
}

function liveLink(
  requestUrl: URL,
  dependencies: HttpAppDependencies,
  artifactId: string,
): string | null {
  const token = liveContentToken(artifactId);
  if (token === null) return null;
  return versionBrowserUrl(requestUrl, dependencies.contentDomain, token);
}

function linkedPublicationResponse(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
  linkedPublication: LinkedPublication,
) {
  const requestUrl = responseApplicationUrl(context, dependencies);
  const response = publishResponse(
    requestUrl,
    dependencies.contentDomain,
    linkedPublication.published,
  );
  const live = liveLink(
    requestUrl,
    dependencies,
    linkedPublication.published.artifact.id,
  );
  return {
    ...response,
    links: live === null ? response.links : {...response.links, live},
    sourceBinding: sourceBindingResponse(linkedPublication.binding),
  };
}

function artifactDetailsResponse(
  requestUrl: URL,
  contentDomain: string,
  details: ArtifactDetails,
) {
  return {
    artifact: details.artifact,
    current: artifactVersionResponse(requestUrl, contentDomain, details.current),
    links: {
      artifact: artifactBrowserUrl(requestUrl, details.artifact.id),
      management: new URL(
        `/api/v1/artifacts/${details.artifact.id}`,
        requestUrl,
      ).toString(),
    },
  };
}

function artifactPageResponse(
  requestUrl: URL,
  page: ArtifactPage,
) {
  return {
    artifacts: page.items.map(({versionCount, ...artifact}) => ({
      artifact,
      links: {
        artifact: artifactBrowserUrl(requestUrl, artifact.id),
        management: new URL(
          `/api/v1/artifacts/${artifact.id}`,
          requestUrl,
        ).toString(),
      },
      versionCount,
    })),
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function publicLinkInventoryPageResponse(
  requestUrl: URL,
  page: PublicLinkInventoryPage,
) {
  return {
    nextCursor: encodePageCursor(page.nextCursor),
    publicLinks: page.items.map((item) => ({
      artifact: item.artifact,
      currentVersion: item.currentVersion,
      links: {
        public: artifactBrowserUrl(requestUrl, item.artifact.id),
      },
      project: item.project,
    })),
  };
}

function publicLinkMutationResponse(
  results: readonly MakePublicLinkPrivateResult[],
) {
  const projected = results.map((result) => {
    if (result.status === "made_private") {
      return {
        artifactId: result.item.artifactId,
        currentVersionId: result.state.artifact.currentVersionId,
        projectId: result.item.projectId,
        replayed: result.replayed,
        status: result.status,
      };
    }
    const error = artifactServerFailureResponse(result.failure);
    return {
      artifactId: result.item.artifactId,
      error: {code: error.code, message: error.message},
      expectedCurrentVersionId: result.item.expectedCurrentVersionId,
      projectId: result.item.projectId,
      retry: result.failure._tag === "ArtifactMutationConflict"
        ? "refresh_current_version" as const
        : error.status >= 500
        ? "same_command" as const
        : "not_retryable" as const,
      status: result.status,
    };
  });
  const succeeded = projected.filter((result) =>
    result.status === "made_private"
  ).length;
  return {
    results: projected,
    summary: {
      failed: projected.length - succeeded,
      requested: projected.length,
      succeeded,
    },
    warning: "New public requests are blocked for successful items. Copies already downloaded or cached outside Artifact Server cannot be recalled.",
  };
}

function registeredAgentResponse(agent: RegisteredAgentRecord) {
  return {
    agentSessionId: agent.agentSessionId,
    connectionKey: agent.connectionKey,
    createdAt: agent.createdAt,
    displayName: agent.displayName,
    id: agent.id,
    kind: agent.kind,
    lastSeenAt: agent.lastSeenAt,
    principalId: agent.principalId,
    workingDirectory: agent.workingDirectory,
  };
}

function connectedAgentResponse(entry: ConnectedRegisteredAgent) {
  return {
    ...registeredAgentResponse(entry.agent),
    connected: entry.connected,
  };
}

function agentDispatchPageResponse(page: AgentDispatchPage) {
  return {
    items: page.items.map(agentDispatchResponse),
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function agentDispatchResponse(dispatch: AgentDispatchRecord) {
  return {
    addressedAt: dispatch.addressedAt,
    agentDisplayName: dispatch.agentDisplayName,
    agentId: dispatch.agentId,
    canceledAt: dispatch.canceledAt,
    claimedAt: dispatch.claimedAt,
    createdAt: dispatch.createdAt,
    deliveredAt: dispatch.deliveredAt,
    failedAt: dispatch.failedAt,
    failureReason: dispatch.failureReason,
    id: dispatch.id,
    idempotencyKey: dispatch.idempotencyKey,
    leaseExpiresAt: dispatch.leaseExpiresAt,
    note: dispatch.note,
    projectId: dispatch.projectId,
    sender: dispatch.sender,
    state: dispatch.state,
    threadIds: dispatch.threadIds,
    updatedAt: dispatch.updatedAt,
  };
}

/**
 * A registration without a connection key still needs a stable upsert
 * identity, so the server derives one from the registering principal and the
 * working directory: the same agent process reclaims the same row, and the
 * dispatches already queued for it, after a restart.
 */
function derivedConnectionKey(
  principalId: string,
  workingDirectory: string,
): string {
  return digestIdentitySecret(`${principalId}\u0000${workingDirectory}`);
}

/**
 * A report names the reporting agent so a report from a non-holder can be
 * refused: one principal may run several agents at once. The id travels in
 * the request body, or in the query string for clients that post only a
 * failure reason.
 */
function reportingAgentId(
  context: Context<HttpEnvironment>,
  declaredInBody: string | undefined,
): string {
  return agentIdSchema.parse(declaredInBody ?? context.req.query("agentId"));
}

/** Parse a request body that clients are allowed to omit entirely. */
async function parseOptionalJsonBody<Body>(
  context: Context<HttpEnvironment>,
  schema: z.ZodType<Body>,
): Promise<Body> {
  const raw = await context.req.text();
  return schema.parse(raw.trim() === "" ? {} : JSON.parse(raw));
}

/**
 * Hold one claim poll open until its deadline, re-checking the single-shot
 * service claim on a bounded interval and stopping early when the polling
 * agent goes away. Answering before the deadline is conformant, so the poll
 * never outlives the transport cap. Only the first attempt carries the
 * heartbeat: one held request is one liveness bump, and the re-checks after
 * it write nothing while the mailbox stays empty.
 */
async function claimWithinPollDeadline(
  attemptClaim: (bumpHeartbeat: boolean) => Promise<AgentDispatchRecord | null>,
  deadlineMilliseconds: number,
  signal: AbortSignal,
  bumpHeartbeat = true,
): Promise<AgentDispatchRecord | null> {
  const dispatch = await attemptClaim(bumpHeartbeat);
  if (dispatch !== null) return dispatch;
  const remainingMilliseconds = deadlineMilliseconds - Date.now();
  if (remainingMilliseconds <= 0 || signal.aborted) return null;
  await delayMilliseconds(
    Math.min(remainingMilliseconds, claimRecheckIntervalMilliseconds),
  );
  return claimWithinPollDeadline(
    attemptClaim,
    deadlineMilliseconds,
    signal,
    false,
  );
}

/** Wait out one bounded claim-poll re-check interval. */
function delayMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function commentThreadPageResponse(requestUrl: URL, page: CommentThreadPage) {
  return {
    items: page.items.map((thread) =>
      commentThreadResponse(requestUrl, thread)
    ),
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function commentThreadDetailsResponse(
  requestUrl: URL,
  details: CommentThreadDetails,
) {
  return {
    replies: details.replies,
    thread: commentThreadResponse(requestUrl, details.thread),
  };
}

function commentThreadResponse(requestUrl: URL, thread: CommentThreadRecord) {
  return {
    anchor: thread.anchor,
    artifactId: thread.artifactId,
    author: thread.author,
    body: thread.body,
    createdAt: thread.createdAt,
    id: thread.id,
    links: {
      self: new URL(
        `/api/v1/artifacts/${thread.artifactId}/comments/${thread.id}`,
        requestUrl,
      ).toString(),
      version: new URL(
        `/api/v1/artifacts/${thread.artifactId}/versions/${thread.versionId}`,
        requestUrl,
      ).toString(),
    },
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

interface CommentThreadUpdate {
  anchor?: unknown;
  artifactId: string;
  body?: string;
  principal: Principal;
  projectId: string | null;
  state?: CommentThreadState;
  threadId: string;
}

function updateCommentThreadCommand(
  target: ReadCommentThreadCommand,
  changes: z.infer<typeof updateCommentThreadSchema>,
): UpdateCommentThreadCommand {
  const command: CommentThreadUpdate = {
    artifactId: target.artifactId,
    principal: target.principal,
    projectId: target.projectId,
    threadId: target.threadId,
  };
  if (changes.anchor !== undefined) command.anchor = changes.anchor;
  if (changes.body !== undefined) command.body = changes.body;
  if (changes.state !== undefined) command.state = changes.state;
  return command;
}

function artifactActionPageResponse(page: ArtifactActionPage) {
  return {
    actions: page.items,
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function deletionResponse(deletion: ArtifactDeletion) {
  return {
    artifact: deletion.artifact,
    replayed: deletion.replayed,
    retainedVersionCount: deletion.retainedVersionCount,
  };
}

function decodePageCursor(token: string | undefined): PageCursor | null {
  if (token === undefined) return null;
  const parsedToken = pageCursorTokenSchema.safeParse(token);
  if (!parsedToken.success) return invalidPageCursor();
  try {
    const decoded = JSON.parse(
      Buffer.from(parsedToken.data, "base64url").toString("utf8"),
    );
    const cursor = pageCursorSchema.safeParse(decoded);
    if (cursor.success) return cursor.data;
  } catch {
    return invalidPageCursor();
  }
  return invalidPageCursor();
}

function encodePageCursor(cursor: PageCursor | null): string | null {
  return cursor === null
    ? null
    : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function invalidPageCursor(): never {
  throw new InvalidPagination({
    message: "The page cursor is invalid or no longer supported.",
  });
}

function artifactVersionResponse(
  requestUrl: URL,
  contentDomain: string,
  saved: ArtifactVersion,
) {
  return {
    manifest: {
      digest: saved.manifest.digest,
      entries: saved.manifest.entries,
      entryPath: saved.manifest.entryPath,
      routingMode: saved.manifest.routingMode,
    },
    ...versionResponse(requestUrl, contentDomain, saved.version),
  };
}

function versionResponse(
  requestUrl: URL,
  contentDomain: string,
  version: VersionRecord,
) {
  return {
    links: {
      version: versionBrowserUrl(
        requestUrl,
        contentDomain,
        version.contentToken,
      ),
    },
    version,
  };
}

function artifactStateResponse(
  requestUrl: URL,
  contentDomain: string,
  state: ArtifactState,
) {
  return {
    artifact: state.artifact,
    links: {
      artifact: artifactBrowserUrl(requestUrl, state.artifact.id),
      version: versionBrowserUrl(
        requestUrl,
        contentDomain,
        state.version.contentToken,
      ),
    },
    replayed: state.replayed,
    version: state.version,
  };
}

function comparisonResponse(
  requestUrl: URL,
  contentDomain: string,
  comparison: ArtifactComparison,
) {
  return {
    ...comparison,
    changed: comparison.changed.map((change) => ({
      ...change,
      links: {
        after: versionFileBrowserUrl(
          requestUrl,
          contentDomain,
          comparison.to.contentToken,
          change.after.path,
        ),
        before: versionFileBrowserUrl(
          requestUrl,
          contentDomain,
          comparison.from.contentToken,
          change.before.path,
        ),
      },
    })),
    links: {
      from: versionBrowserUrl(
        requestUrl,
        contentDomain,
        comparison.from.contentToken,
      ),
      to: versionBrowserUrl(
        requestUrl,
        contentDomain,
        comparison.to.contentToken,
      ),
    },
  };
}

/**
 * Serve one live-origin read: the linked source's current bytes for an
 * authorized local member, or the last captured version's bytes when the
 * source is unavailable. Live responses are never cached; the immutable
 * caching story belongs exclusively to version-scoped origins.
 */
async function serveLiveContent(
  context: Context<HttpEnvironment>,
  liveToken: string,
  cookieHeader: string | undefined,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const method = context.req.method;
  if (method !== "GET" && method !== "HEAD") {
    return Response.json(
      {error: {code: errorCodes.methodNotAllowed, message: "Only GET and HEAD are supported."}},
      {status: 405, headers: {Allow: "GET, HEAD"}},
    );
  }
  const grant: LiveReadGrant = await runHttpApplicationEffect(
    context,
    dependencies,
    LinkedArtifactService.use((linked) =>
      linked.authorizeLiveRead({
        liveToken,
        sessionToken: contentSessionToken(cookieHeader),
      })
    ),
  );
  if (grant.kind === "captured") {
    const headers = liveContentHeaders(
      grant.entry.mediaType,
      grant.entry.size,
      grant.freshness,
      grant.entry.disposition,
    );
    if (method === "HEAD") return new Response(null, {headers, status: 200});
    const blob = await dependencies.blobs.open(grant.entry.sha256);
    if (blob.size !== grant.entry.size) {
      await blob.body.cancel();
      assertBlobSize(blob.size, grant.entry.size, grant.entry.sha256);
    }
    return new Response(blob.body, {headers, status: 200});
  }
  const headers = liveContentHeaders(
    grant.mediaType,
    grant.source.size,
    grant.freshness,
    "inline",
  );
  if (method === "HEAD") {
    await grant.source.close();
    return new Response(null, {headers, status: 200});
  }
  return new Response(grant.source.stream(), {headers, status: 200});
}

function liveContentHeaders(
  mediaType: string,
  size: number,
  freshness: string,
  disposition: string,
): Headers {
  return new Headers({
    "Artifact-Source-Freshness": freshness,
    "Cache-Control": "private, no-store",
    "Content-Disposition": disposition,
    "Content-Length": String(size),
    "Content-Type": mediaType,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
}

async function serveVersionContent(
  context: Context<HttpEnvironment>,
  requestUrl: URL,
  contentToken: string,
  cookieHeader: string | undefined,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const method = context.req.method;
  if (method !== "GET" && method !== "HEAD") {
    return Response.json(
      {error: {code: errorCodes.methodNotAllowed, message: "Only GET and HEAD are supported."}},
      {status: 405, headers: {Allow: "GET, HEAD"}},
    );
  }

  const requestedPath = manifestPathFromUrl(requestUrl.pathname);
  if (requestedPath === null) {
    return versionNotFoundResponse();
  }
  const content = await runHttpApplicationEffect(
    context,
    dependencies,
    ContentAccessService.use((contentAccess) =>
      contentAccess.authorizeVersionContent({
        contentToken,
        fallback: permitsSpaEntryFallback(context.req.raw.headers)
          ? "entry"
          : "none",
        path: requestedPath,
        sessionToken: contentSessionToken(cookieHeader),
      })
    ),
  );
  if (content === null) {
    return versionNotFoundResponse();
  }
  const publiclyCacheable = content.accessSetting === accessSettings.publicLink &&
    content.isCurrent;
  const headers = contentHeaders(
    content.entry,
    content.entry.size,
    publiclyCacheable,
  );

  const strongEtag = `"${content.entry.sha256}"`;
  if (etagMatches(context.req.header("if-none-match"), strongEtag)) {
    headers.delete("Content-Length");
    return new Response(null, {headers, status: 304});
  }

  const rangeDecision = ifRangeAllowsPartialResponse(
    context.req.header("if-range"),
    strongEtag,
  )
    ? decideByteRange(context.req.header("range"), content.entry.size)
    : {kind: "full"} as const;
  if (rangeDecision.kind === "unsatisfiable") {
    headers.delete("Content-Length");
    headers.set("Content-Range", `bytes */${content.entry.size}`);
    return new Response(null, {headers, status: 416});
  }

  if (method === "HEAD") {
    const blob = await dependencies.blobs.inspect(content.entry.sha256);
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
    if (rangeDecision.kind === "partial") {
      applyPartialContentHeaders(headers, rangeDecision.range, content.entry.size);
    }
    return new Response(null, {
      headers,
      status: rangeDecision.kind === "partial" ? 206 : 200,
    });
  }

  if (rangeDecision.kind === "partial") {
    const blob = await dependencies.blobs.openRange(
      content.entry.sha256,
      rangeDecision.range,
    );
    if (blob.size !== content.entry.size) {
      await blob.body.cancel();
      assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
    }
    applyPartialContentHeaders(headers, rangeDecision.range, content.entry.size);
    return new Response(blob.body, {headers, status: 206});
  }

  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  return new Response(blob.body, {
    headers,
    status: 200,
  });
}

async function serveVersionFile(
  saved: ArtifactVersion,
  path: string,
  method: string,
  requestHeaders: Headers,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const entry = saved.manifest.entries.find(
    (candidate) => candidate.path === path,
  );
  if (entry === undefined) {
    throw new VersionNotFound({
      message: "The version file does not exist.",
    });
  }
  return serveImmutableVersionEntry(
    entry,
    method,
    requestHeaders,
    versionFileHeaders(entry),
    dependencies,
  );
}

async function serveVersionMedia(
  saved: ArtifactVersion,
  path: string,
  method: string,
  requestHeaders: Headers,
  authenticationMethod: "bearer" | "session",
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const entry = saved.manifest.entries.find(
    (candidate) => candidate.path === path,
  );
  if (entry === undefined) {
    throw new VersionNotFound({
      message: "The version file does not exist.",
    });
  }
  const mediaKind = previewMediaKind(entry.mediaType);
  if (mediaKind === null) {
    return mediaPreviewFailure(
      errorCodes.mediaPreviewTypeUnsupported,
      "This manifest entry is not an image or video preview.",
      415,
    );
  }
  if (!permitsMediaPreviewRequest(
    method,
    requestHeaders,
    authenticationMethod,
    mediaKind,
  )) {
    return mediaPreviewFailure(
      errorCodes.mediaPreviewContextRequired,
      "Media previews require a same-origin application subresource request.",
      403,
    );
  }
  return serveImmutableVersionEntry(
    entry,
    method,
    requestHeaders,
    versionMediaHeaders(entry),
    dependencies,
  );
}

async function serveImmutableVersionEntry(
  entry: ManifestEntry,
  method: string,
  requestHeaders: Headers,
  headers: Headers,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const strongEtag = `"${entry.sha256}"`;
  if (
    etagMatches(requestHeaders.get("if-none-match") ?? undefined, strongEtag)
  ) {
    headers.delete("Content-Length");
    return new Response(null, {headers, status: 304});
  }
  const rangeDecision = ifRangeAllowsPartialResponse(
    requestHeaders.get("if-range") ?? undefined,
    strongEtag,
  )
    ? decideByteRange(requestHeaders.get("range") ?? undefined, entry.size)
    : {kind: "full"} as const;
  if (rangeDecision.kind === "unsatisfiable") {
    headers.delete("Content-Length");
    headers.set("Content-Range", `bytes */${entry.size}`);
    return new Response(null, {headers, status: 416});
  }
  // Hono answers HEAD through the GET handler, so a body stream opened here is
  // discarded without being cancelled and leaks its blob handle.
  if (method === "HEAD") {
    const inspected = await dependencies.blobs.inspect(entry.sha256);
    assertBlobSize(inspected.size, entry.size, entry.sha256);
    if (rangeDecision.kind === "partial") {
      applyPartialContentHeaders(headers, rangeDecision.range, entry.size);
    }
    return new Response(null, {
      headers,
      status: rangeDecision.kind === "partial" ? 206 : 200,
    });
  }
  if (rangeDecision.kind === "partial") {
    const blob = await dependencies.blobs.openRange(
      entry.sha256,
      rangeDecision.range,
    );
    if (blob.size !== entry.size) {
      await blob.body.cancel();
      assertBlobSize(blob.size, entry.size, entry.sha256);
    }
    applyPartialContentHeaders(headers, rangeDecision.range, entry.size);
    return new Response(blob.body, {headers, status: 206});
  }
  const blob = await dependencies.blobs.open(entry.sha256);
  if (blob.size !== entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, entry.size, entry.sha256);
  }
  return new Response(blob.body, {headers, status: 200});
}

function permitsMediaPreviewRequest(
  method: string,
  headers: Headers,
  authenticationMethod: "bearer" | "session",
  mediaKind: "image" | "video",
): boolean {
  if (
    authenticationMethod !== "session" ||
    headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return false;
  }
  const destination = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  if (method === "GET") {
    return destination === mediaKind && mode === "no-cors";
  }
  return method === "HEAD" && destination === "empty" &&
    (mode === "cors" || mode === "same-origin" || mode === "no-cors");
}

function previewMediaKind(mediaType: string): "image" | "video" | null {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (essence?.startsWith("image/") === true) return "image";
  if (essence?.startsWith("video/") === true) return "video";
  return null;
}

function mediaPreviewFailure(
  code: typeof errorCodes.mediaPreviewContextRequired |
    typeof errorCodes.mediaPreviewTypeUnsupported,
  message: string,
  status: 403 | 415,
): Response {
  return Response.json({error: {code, message}}, {status});
}

function versionFileHeaders(entry: ManifestEntry): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    // The route names one immutable version, so the bytes never change for
    // this URL; `private` keeps the authenticated response in browser caches
    // only.
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": "attachment",
    "Content-Length": String(entry.size),
    "Content-Type": "application/octet-stream",
    ETag: `"${entry.sha256}"`,
    "X-Content-Type-Options": "nosniff",
  });
}

function versionMediaHeaders(entry: ManifestEntry): Headers {
  const filename = entry.path.split("/").at(-1) ?? "artifact-media";
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeDispositionFilename(filename)}`,
    "Content-Length": String(entry.size),
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Type": entry.mediaType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: `"${entry.sha256}"`,
    Vary: "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site",
    "X-Content-Type-Options": "nosniff",
  });
}

function encodeDispositionFilename(filename: string): string {
  return encodeURIComponent(filename.toWellFormed()).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`,
  );
}

function etagMatches(value: string | undefined, strongEtag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === strongEtag || tag === `W/${strongEtag}`;
  });
}

function contentHeaders(
  entry: ManifestEntry,
  size: number,
  publiclyCacheable: boolean,
): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": publiclyCacheable
      ? "public, no-cache, must-revalidate"
      : "private, no-store",
    "Content-Disposition": entry.disposition,
    "Content-Length": String(size),
    "Content-Type": entry.mediaType,
    ETag: `"${entry.sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
}

function applyPartialContentHeaders(
  headers: Headers,
  range: {readonly endInclusive: number; readonly length: number; readonly start: number},
  totalSize: number,
): void {
  headers.set("Content-Length", String(range.length));
  headers.set(
    "Content-Range",
    `bytes ${range.start}-${range.endInclusive}/${totalSize}`,
  );
}

function assertBlobSize(actual: number, expected: number, digest: string): void {
  if (actual !== expected) {
    throw new Error(
      `Stored blob ${digest} is ${actual} bytes but its manifest records ${expected}.`,
    );
  }
}

function versionNotFoundResponse(): Response {
  return Response.json(
    {error: {code: errorCodes.versionNotFound, message: "The version file does not exist."}},
    {status: 404},
  );
}

function requiredIdempotencyKey(header: string | undefined): string {
  return z.string().min(16).max(200).parse(header);
}

async function exchangeContentBootstrap(
  context: Context<HttpEnvironment>,
  requestUrl: URL,
  contentToken: string,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  const method = context.req.method;
  if (method !== "GET") {
    return Response.json(
      {error: {code: errorCodes.methodNotAllowed, message: "Only GET is supported."}},
      {status: 405, headers: {Allow: "GET"}},
    );
  }
  const destinationPath = contentBootstrapDestination(requestUrl.pathname);
  if (destinationPath === null) {
    throw new ContentBootstrapRejected({
      message: "The private-content bootstrap destination is invalid.",
    });
  }
  const parsed = contentSessionTokenSchema.safeParse(
    requestUrl.searchParams.get(contentBootstrapQueryParameter),
  );
  if (!parsed.success) {
    throw new ContentBootstrapRejected({
      message: "The private-content bootstrap is invalid or no longer available.",
    });
  }
  const issued = await runHttpApplicationEffect(
    context,
    dependencies,
    ContentAccessService.use((contentAccess) =>
      contentAccess.exchangeContentBootstrap({
        contentToken,
        token: Redacted.make(parsed.data, {label: "content-bootstrap-token"}),
      })
    ),
  );
  return new Response(contentSessionExchangeHtml(destinationPath), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": contentSessionCookie(
        Redacted.value(issued.token),
        issued.expiresAt,
        usesSecureContentCookie(requestUrl),
      ),
    },
    status: 200,
  });
}

function contentSessionExchangeHtml(destinationPath: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${destinationPath}">`,
    "<title>Opening artifact</title>",
    `<p><a href="${destinationPath}">Continue to artifact</a></p>`,
    "</html>",
  ].join("");
}

function contentBootstrapDestination(pathname: string): string | null {
  const manifestPath = manifestPathFromUrl(pathname);
  if (manifestPath === null) return null;
  return manifestPath === ""
    ? "/"
    : `/${manifestPath.split("/").map(encodeURIComponent).join("/")}`;
}

function contentSessionCookie(
  token: string,
  expiresAt: string,
  secure: boolean,
): string {
  const name = secure
    ? contentSessionCookieName
    : loopbackContentSessionCookieName;
  const secureAttribute = secure ? "; Secure" : "";
  return `${name}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly${secureAttribute}; SameSite=Strict`;
}

function usesSecureContentCookie(requestUrl: URL): boolean {
  return !(
    requestUrl.protocol === "http:"
    && (
      requestUrl.hostname === "localhost"
      || requestUrl.hostname.endsWith(".localhost")
    )
  );
}

function contentSessionToken(
  cookieHeader: string | undefined,
): Redacted.Redacted | null {
  if (cookieHeader === undefined) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (
      name !== contentSessionCookieName
      && name !== loopbackContentSessionCookieName
    ) continue;
    const parsed = contentSessionTokenSchema.safeParse(
      pair.slice(separator + 1).trim(),
    );
    return parsed.success
      ? Redacted.make(parsed.data, {label: "content-session-token"})
      : null;
  }
  return null;
}

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function tokenFromContentHost(
  hostname: string,
  contentDomain: string,
): string | null {
  const suffix = `.${contentDomain.toLocaleLowerCase("en-US")}`;
  const normalizedHostname = hostname.toLocaleLowerCase("en-US");
  if (!normalizedHostname.endsWith(suffix)) return null;
  const candidate = normalizedHostname.slice(0, -suffix.length);
  const parsed = contentTokenSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function isContentBootstrapRequest(requestUrl: URL): boolean {
  return requestUrl.searchParams.has(contentBootstrapQueryParameter);
}

/**
 * The review frame is a separate document from the application shell. It holds
 * no credential and issues no request: it renders one artifact version inside
 * an opaque-origin `srcdoc` sandbox, which inherits this policy. So the policy
 * permits what published artifacts need (inline scripts and styles, images,
 * fonts and media from anywhere) while `connect-src 'none'` keeps the sandbox
 * from reaching any network, and `frame-ancestors 'self'` keeps the frame
 * embeddable only by the shell that serves it.
 */
const reviewFrameContentSecurityPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; frame-ancestors 'self'";

type WebAssetKind = "application-shell" | "review-frame" | "static-asset";

async function serveWebAsset(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
  assetPath: string,
  kind: WebAssetKind,
): Promise<Response> {
  if (dependencies.webAssets === undefined) return context.notFound();
  const method = context.req.method === "HEAD" ? "HEAD" : "GET";
  const asset = await dependencies.webAssets.fetch(assetPath, method);
  if (asset === null || !asset.ok) return context.notFound();
  const headers = new Headers({
    "Cache-Control": kind === "static-asset"
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate",
    "Content-Security-Policy": kind === "review-frame"
      ? reviewFrameContentSecurityPolicy
      : "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  copyAssetHeader(asset.headers, headers, "ETag");
  const assetEtag = headers.get("ETag");
  if (
    assetEtag !== null
    && etagMatches(context.req.header("if-none-match"), assetEtag)
  ) {
    return new Response(null, {headers, status: 304});
  }
  copyAssetHeader(asset.headers, headers, "Content-Length");
  copyAssetHeader(asset.headers, headers, "Content-Type");
  return new Response(method === "HEAD" ? null : asset.body, {
    headers,
    status: 200,
  });
}

function copyAssetHeader(
  source: Headers,
  destination: Headers,
  name: string,
): void {
  const value = source.get(name);
  if (value !== null) destination.set(name, value);
}
