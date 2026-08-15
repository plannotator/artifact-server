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
  InstallationAccessService,
} from "../application/installation-access.js";
import { InteractiveLoginService } from "../application/interactive-login.js";
import { ProjectManagementService } from "../application/project-management.js";
import {
  type ArtifactDetails,
  ArtifactManagementService,
} from "../application/artifact-management.js";
import {
  type ArtifactComparison,
  CompareArtifactService,
} from "../application/compare-artifact.js";
import { ContentAccessService } from "../application/content-access.js";
import {
  AuthenticationRequired,
  AuthorizationDenied,
  type ArtifactServerFailure,
  ContentBootstrapRejected,
  errorCodes,
  InvalidPagination,
  isArtifactServerFailure,
} from "../core/errors.js";
import type { IssuedApplicationSession } from "../core/installation-identity.js";
import {
  membershipRoles,
  principalCapabilities,
  type Principal,
} from "../core/identity.js";
import {
  accessSettings,
  type ArtifactActionPage,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactState,
  type ArtifactVersion,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type VersionRecord,
} from "../core/model.js";
import type { BlobStore } from "../core/ports.js";
import {
  maximumDeclaredFiles,
  maximumUploadPlanRequestBytes,
} from "../core/publishing-limits.js";
import { manifestPathFromUrl } from "../manifest/create-manifest.js";
import {createMcpHttpAdapter} from "../mcp/create-mcp-http-adapter.js";
import {
  artifactBrowserUrl,
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
const deleteArtifactSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
});
const pageQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: z.string().max(200).optional(),
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
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageOwnedArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.publishOwnedArtifact,
  principalCapabilities.readArtifacts,
]);
const issueApiKeySchema = z.object({
  capabilities: z.array(principalCapabilitySchema).min(1),
  expiresAt: z.iso.datetime(),
  memberId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
});
const localBootstrapSchema = z.object({
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
const secureApplicationSessionCookie = "__Host-artifact_session";
const secureApplicationCsrfCookie = "__Host-artifact_csrf";

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
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string;
  readonly readiness?: ReadinessProbe;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly trustedApplicationOrigin: string | null;
}

/** RFC 9728 metadata for the separately audience-bound HTTP API resource. */
export interface ApiOAuthResourceConfiguration {
  readonly authorizationServers: readonly [string, ...string[]];
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
  const mcp = createMcpHttpAdapter({
    allowedHostnames: mcpAllowedHostnames,
    allowedOriginHostnames: mcpAllowedHostnames,
    applicationOrigin: dependencies.trustedApplicationOrigin,
    applicationRuntime: dependencies.applicationRuntime,
    contentDomain: dependencies.contentDomain,
    mode: dependencies.trustedApplicationOrigin === null ? "local" : "remote",
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

  app.get("/auth/local", async (context) => {
    const requestUrl = new URL(context.req.url);
    if (!isLoopbackHostname(requestUrl.hostname)) {
      throw new AuthenticationRequired({
        message: "Local browser login is available only on loopback.",
      });
    }
    const query = localBootstrapSchema.parse(context.req.query());
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InstallationAccessService.use((access) =>
        access.loginWithLocalBootstrap(
          Redacted.make(query.token, {label: "local-browser-bootstrap"}),
        )
      ),
    );
    setApplicationSessionCookies(context, dependencies, issued);
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.redirect("/api/v1/session", 303);
  });

  app.get("/auth/login", async (context) => {
    const query = interactiveLoginQuerySchema.parse(context.req.query());
    const authorizationUrl = await runHttpApplicationEffect(
      context,
      dependencies,
      InteractiveLoginService.use((login) => login.start(query.returnTo)),
    );
    context.header("Cache-Control", "private, no-store");
    return context.redirect(authorizationUrl, 302);
  });

  app.get("/auth/callback", async (context) => {
    const query = interactiveCallbackSchema.parse(context.req.query());
    const completed = await runHttpApplicationEffect(
      context,
      dependencies,
      InteractiveLoginService.use((login) => login.complete(query)),
    );
    setApplicationSessionCookies(context, dependencies, completed.issued);
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.redirect(completed.returnTo, 303);
  });

  app.get("/api/v1/session", (context) =>
    context.json({
      authenticationMethod: context.get("authenticationMethod"),
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
      new URL(context.req.url),
      page,
    ));
  });

  app.get("/api/v1/artifacts/:artifactId", async (context) => {
    const details = await runHttpApplicationEffect(
      context,
      dependencies,
      ArtifactManagementService.use((management) =>
        management.getArtifact({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          projectId: requestedProjectId(context),
        })
      ),
    );
    return context.json(artifactDetailsResponse(
      new URL(context.req.url),
      dependencies.contentDomain,
      details,
    ));
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
    const requestUrl = new URL(context.req.url);
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
        new URL(context.req.url),
        dependencies.contentDomain,
        saved,
      ));
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
      new URL(context.req.url),
      dependencies.contentDomain,
      comparison,
    ));
  });

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
        new URL(context.req.url),
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
          new URL(context.req.url),
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
        new URL(context.req.url),
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
        })
      ),
    );
    const requestUrl = new URL(context.req.url);
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
          new URL(context.req.url),
          dependencies.contentDomain,
          result,
        ),
        result.replayed ? 200 : 201,
      );
    },
  );

  app.post("/api/v1/artifacts/:artifactId/content-sessions", async (context) => {
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
        new URL(context.req.url),
        dependencies.contentDomain,
        issued.contentToken,
        Redacted.value(issued.token),
      ),
      expiresAt: issued.expiresAt,
      versionId: issued.versionId,
    }, 201);
  });

  app.post(
    "/api/v1/artifacts/:artifactId/versions/:versionId/content-sessions",
    async (context) => {
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
          new URL(context.req.url),
          dependencies.contentDomain,
          issued.contentToken,
          Redacted.value(issued.token),
        ),
        expiresAt: issued.expiresAt,
        versionId: issued.versionId,
      }, 201);
    },
  );

  app.get("/artifacts/:artifactId", async (context) => {
    const current = await runHttpApplicationEffect(
      context,
      dependencies,
      ContentAccessService.use((contentAccess) =>
        contentAccess.resolvePublicArtifact(context.req.param("artifactId"))
      ),
    );
    const versionUrl = versionBrowserUrl(
      new URL(context.req.url),
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
): {readonly csrf: string; readonly session: string} {
  return usesSecureApplicationCookies(dependencies)
    ? {
      csrf: secureApplicationCsrfCookie,
      session: secureApplicationSessionCookie,
    }
    : {csrf: applicationCsrfCookie, session: applicationSessionCookie};
}

function usesSecureApplicationCookies(
  dependencies: HttpAppDependencies,
): boolean {
  return dependencies.trustedApplicationOrigin !== null &&
    new URL(dependencies.trustedApplicationOrigin).protocol === "https:";
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

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function requestedProjectId(context: Context<HttpEnvironment>): string | null {
  const projectId = context.req.query("projectId");
  return projectId === undefined ? null : projectIdSchema.parse(projectId);
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
  const versionUrl = versionBrowserUrl(
    requestUrl,
    contentDomain,
    published.version.contentToken,
  );
  return {
    artifact: published.artifact,
    links: {
      artifact: artifactUrl,
      version: versionUrl,
    },
    replayed: published.replayed,
    version: published.version,
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
    artifacts: page.items.map((artifact) => ({
      artifact,
      links: {
        artifact: artifactBrowserUrl(requestUrl, artifact.id),
        management: new URL(
          `/api/v1/artifacts/${artifact.id}`,
          requestUrl,
        ).toString(),
      },
    })),
    nextCursor: encodePageCursor(page.nextCursor),
  };
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

  if (method === "HEAD") {
    const blob = await dependencies.blobs.inspect(content.entry.sha256);
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
    return new Response(null, {
      headers: contentHeaders(content.entry, blob.size, publiclyCacheable),
      status: 200,
    });
  }

  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  return new Response(blob.body, {
    headers: contentHeaders(content.entry, blob.size, publiclyCacheable),
    status: 200,
  });
}

function contentHeaders(
  entry: ManifestEntry,
  size: number,
  publiclyCacheable: boolean,
): Headers {
  return new Headers({
    "Cache-Control": publiclyCacheable
      ? "public, max-age=31536000, immutable"
      : "private, no-store",
    "Content-Disposition": entry.disposition,
    "Content-Length": String(size),
    "Content-Type": entry.mediaType,
    ETag: `"${entry.sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
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
  const cleanUrl = new URL(requestUrl);
  cleanUrl.pathname = "/";
  cleanUrl.search = "";
  cleanUrl.hash = "";
  return new Response(null, {
    headers: {
      "Cache-Control": "private, no-store",
      Location: cleanUrl.toString(),
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": contentSessionCookie(
        Redacted.value(issued.token),
        issued.expiresAt,
      ),
    },
    status: 303,
  });
}

function contentSessionCookie(token: string, expiresAt: string): string {
  return `${contentSessionCookieName}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

function contentSessionToken(
  cookieHeader: string | undefined,
): Redacted.Redacted | null {
  if (cookieHeader === undefined) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== contentSessionCookieName) continue;
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
  return requestUrl.pathname === "/" &&
    requestUrl.searchParams.has(contentBootstrapQueryParameter);
}
