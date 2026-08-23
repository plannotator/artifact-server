import {
  createMcpHandler,
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {z} from "zod";

import {
  type ApplicationRuntime,
  runApplicationEffect,
} from "../application/application-runtime.js";
import {AuthenticationService} from "../application/authentication.js";
import {
  isArtifactServerFailure,
} from "../core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../core/identity.js";
import type {GitHistoryCapabilityReader} from
  "../git-history/git-history-capability.js";
import {
  createArtifactMcpServer,
  type ArtifactMcpServerDependencies,
} from "./artifact-mcp-server.js";

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(z.enum([
    principalCapabilities.connectAgents,
    principalCapabilities.createArtifact,
    principalCapabilities.issueContentSession,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.manageProjects,
    principalCapabilities.publishAnyArtifact,
    principalCapabilities.readArtifacts,
    principalCapabilities.writeComments,
  ])),
  displayName: z.string().min(1),
  id: z.string().min(1),
  installationId: z.string().min(1),
  kind: z.enum([principalKinds.human, principalKinds.service]),
  membershipRole: z.enum([
    membershipRoles.administrator,
    membershipRoles.member,
  ]),
}).strict();

/** Configuration for the stateless modern MCP boundary and its 2025-era bridge. */
export interface McpHttpAdapterDependencies {
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames: readonly string[];
  readonly applicationOrigin: string | null;
  readonly applicationRuntime: ApplicationRuntime;
  readonly contentDomain: string;
  readonly gitHistory: GitHistoryCapabilityReader;
  readonly linkedArtifacts?: boolean;
  readonly mode: ArtifactMcpServerDependencies["mode"];
  readonly oauthResource: string | null;
}

/** Stateless MCP HTTP adapter mounted by every Artifact Server deployment. */
export interface McpHttpAdapter {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/** Construct one authenticated MCP adapter over shared application services. */
export function createMcpHttpAdapter(
  dependencies: McpHttpAdapterDependencies,
): McpHttpAdapter {
  const handler = createMcpHandler(
    (context) => {
      const principal = principalSchema.parse(
        context.authInfo?.extra?.["artifactServerPrincipal"],
      );
      const serverDependencies: ArtifactMcpServerDependencies = {
        applicationOrigin: dependencies.applicationOrigin
          ?? requestOrigin(context.requestInfo),
        applicationRuntime: dependencies.applicationRuntime,
        contentDomain: dependencies.contentDomain,
        gitHistory: dependencies.gitHistory.read(),
        linkedArtifacts: dependencies.linkedArtifacts === true,
        mode: dependencies.mode,
        requestId: requestIdFrom(context.requestInfo),
      };
      return createArtifactMcpServer(
        serverDependencies,
        {principal},
        context,
      );
    },
    {
      legacy: "stateless",
      maxSubscriptions: 0,
      responseMode: "auto",
    },
  );
  return {
    close: handler.close,
    fetch: async (request) => {
      if (request.method !== "POST") return methodNotAllowed();
      const edgeRejection = validateRequestEdge(request, dependencies);
      if (edgeRejection !== undefined) return edgeRejection;
      const requestId = requestIdFrom(request);
      let bearerOptions: Parameters<typeof requireBearerAuth>[0] = {
        verifier: {
          verifyAccessToken: (token) =>
            authenticateToken(dependencies, token, requestId),
        },
      };
      if (dependencies.oauthResource !== null) {
        bearerOptions = {
          ...bearerOptions,
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
            new URL(dependencies.oauthResource),
          ),
        };
      }
      const authenticate = requireBearerAuth(bearerOptions);
      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      return handler.fetch(request, {authInfo: auth});
    },
  };
}

async function authenticateToken(
  dependencies: McpHttpAdapterDependencies,
  token: string,
  requestId: string,
): Promise<AuthInfo> {
  try {
    const authenticated = await runApplicationEffect(
      dependencies.applicationRuntime,
      AuthenticationService.use((authentication) =>
        authentication.authenticateMcpBearer(
          Redacted.make(token, {label: "mcp-bearer-credential"}),
        )
      ),
      {requestId, spanName: "mcp.authenticate"},
    );
    return {
      clientId: authenticated.clientId,
      expiresAt: authenticated.expiresAt,
      extra: {artifactServerPrincipal: authenticated.principal},
      scopes: [...authenticated.scopes],
      token,
    };
  } catch (cause) {
    if (
      cause instanceof Error
      && isArtifactServerFailure(cause)
      && cause._tag === "AuthorizationDenied"
    ) {
      throw new OAuthError(
        OAuthErrorCode.InsufficientScope,
        "The bearer credential does not grant Artifact Server MCP access.",
      );
    }
    if (
      cause instanceof Error
      && isArtifactServerFailure(cause)
      && (
        cause._tag === "IdentityRepositoryFailure" ||
        cause._tag === "IdentityProviderFailure"
      )
    ) {
      await runApplicationEffect(
        dependencies.applicationRuntime,
        Effect.logError("mcp.authentication.failed").pipe(
          Effect.annotateLogs({
            failure_reason: cause._tag === "IdentityRepositoryFailure"
              ? `identity_repository_${cause.operation}`
              : cause.message,
            failure_tag: cause._tag,
            request_id: requestId,
          }),
        ),
        {requestId, spanName: "mcp.authentication.failure"},
      );
      throw new OAuthError(
        OAuthErrorCode.ServerError,
        "Artifact Server could not verify the bearer credential.",
      );
    }
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "The Artifact Server bearer credential is invalid or no longer active.",
    );
  }
}

function validateRequestEdge(
  request: Request,
  dependencies: McpHttpAdapterDependencies,
): Response | undefined {
  const host = validateHostHeader(
    request.headers.get("host"),
    [...dependencies.allowedHostnames],
  );
  if (!host.ok) return rejectedEdge(host.message);
  const origin = validateOriginHeader(
    request.headers.get("origin"),
    [...dependencies.allowedOriginHostnames],
  );
  return origin.ok ? undefined : rejectedEdge(origin.message);
}

function rejectedEdge(message: string): Response {
  return Response.json(
    {
      error: {code: -32_600, message},
      id: null,
      jsonrpc: "2.0",
    },
    {status: 403},
  );
}

function methodNotAllowed(): Response {
  return Response.json(
    {
      error: {code: -32_600, message: "Artifact Server MCP accepts POST only."},
      id: null,
      jsonrpc: "2.0",
    },
    {headers: {Allow: "POST"}, status: 405},
  );
}

function requestOrigin(request: Request | undefined): string {
  if (request === undefined) {
    throw new Error("An HTTP MCP server requires the original request URL.");
  }
  return new URL(request.url).origin;
}

function requestIdFrom(request: Request | undefined): string {
  return request?.headers.get("x-artifact-request-id") ?? crypto.randomUUID();
}
