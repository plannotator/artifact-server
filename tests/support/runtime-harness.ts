import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {z} from "zod";

import {
  type LocalServerConfig,
  startLocalServer,
} from "../../src/local/start-local-server.js";
import type {
  BearerCredentialVerifier,
  ExternalMcpBearerVerifier,
} from "../../src/application/authentication.js";
import type {InteractiveIdentityProvider} from "../../src/application/interactive-login.js";
import type {NodeGitHistoryConfiguration} from
  "../../src/git-history/node-git-history-configuration.js";
import type {GitHistoryProviderHealthProbe} from
  "../../src/git-history/git-history-provider-health.js";
import type {
  ApiOAuthResourceConfiguration,
  McpOAuthResourceConfiguration,
} from "../../src/http/create-http-app.js";
import type {Clock} from "../../src/core/ports.js";
import {localOwnerBrowserAccess} from "../../src/core/browser-access.js";
import type {BrowserAccess} from "../../src/core/browser-access.js";
import {defaultCompletedRequestLogSampleRate} from
  "../../src/observability/application-observability.js";

const assignedAddressSchema = z.object({port: z.number().int().positive()});

export interface TestInstallation {
  readonly apiToken: string;
  readonly browserBootstrapToken: string;
  readonly dataDirectory: string;
}

export interface RunningTestServer {
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Reserve one free loopback port so a caller can bind it deliberately. */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.parse(server.address());
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}

export async function createTestInstallation(): Promise<TestInstallation> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-test-"),
  );
  return {
    apiToken:
      "as_key_key_00000000-0000-4000-8000-000000000001_testLocalApiTokenWithSufficientEntropy123",
    browserBootstrapToken: "test-local-browser-token-with-sufficient-entropy",
    dataDirectory,
  };
}

export async function removeTestInstallation(
  installation: TestInstallation,
): Promise<void> {
  await rm(installation.dataDirectory, {force: true, recursive: true});
}

export async function startTestServer(
  installation: TestInstallation,
  options: {
    readonly applicationOrigin?: string;
    readonly bootstrapAdministratorEmail?: string;
    readonly browserAccess?: BrowserAccess;
    readonly contentDomain?: string;
    readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
    readonly clock?: Clock;
    readonly completedRequestLogSampleRate?: number;
    readonly developmentProxyCredential?: string;
    readonly externalApiBearerVerifier?: BearerCredentialVerifier;
    readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
    readonly externalMcpOAuthVerifier?: ExternalMcpBearerVerifier;
    readonly gitHistory?: NodeGitHistoryConfiguration;
    readonly gitHistoryHealthProbe?: GitHistoryProviderHealthProbe;
    readonly hostname?: string;
    readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
    readonly linkedFiles?: "off" | "on";
    readonly linkRoots?: readonly string[];
    readonly mcpOAuthResource?: McpOAuthResourceConfiguration;
    readonly observability?: boolean;
    readonly port?: number;
    readonly webAssetsRoot?: string;
  } = {},
): Promise<RunningTestServer> {
  const baseConfig: LocalServerConfig = {
    apiToken: installation.apiToken,
    browserAccess: options.browserAccess ?? localOwnerBrowserAccess,
    bootstrapAdministratorEmail: options.bootstrapAdministratorEmail ??
      "administrator@example.test",
    contentDomain: options.contentDomain ?? "localhost",
    completedRequestLogSampleRate:
      options.completedRequestLogSampleRate ??
        defaultCompletedRequestLogSampleRate,
    dataDirectory: installation.dataDirectory,
    localBootstrapToken: installation.browserBootstrapToken,
    observability: options.observability ?? false,
    port: options.port ?? 0,
  };
  let config: LocalServerConfig = baseConfig;
  if (options.applicationOrigin !== undefined) {
    config = {...config, applicationOrigin: options.applicationOrigin};
  }
  if (options.clock !== undefined) {
    config = {...config, clock: options.clock};
  }
  if (options.apiOAuthResource !== undefined) {
    config = {...config, apiOAuthResource: options.apiOAuthResource};
  }
  if (options.externalApiBearerVerifier !== undefined) {
    config = {
      ...config,
      externalApiBearerVerifier: options.externalApiBearerVerifier,
    };
  }
  if (options.developmentProxyCredential !== undefined) {
    config = {
      ...config,
      developmentProxyCredential: options.developmentProxyCredential,
    };
  }
  if (options.externalMcpBearerVerifier !== undefined) {
    config = {
      ...config,
      externalMcpBearerVerifier: options.externalMcpBearerVerifier,
    };
  }
  if (options.externalMcpOAuthVerifier !== undefined) {
    config = {
      ...config,
      externalMcpOAuthVerifier: options.externalMcpOAuthVerifier,
    };
  }
  if (options.interactiveIdentityProvider !== undefined) {
    config = {
      ...config,
      interactiveIdentityProvider: options.interactiveIdentityProvider,
    };
  }
  if (options.gitHistory !== undefined) {
    config = {...config, gitHistory: options.gitHistory};
  }
  if (options.gitHistoryHealthProbe !== undefined) {
    config = {
      ...config,
      gitHistoryHealthProbe: options.gitHistoryHealthProbe,
    };
  }
  if (options.hostname !== undefined) {
    config = {...config, hostname: options.hostname};
  }
  if (options.linkedFiles !== undefined) {
    config = {...config, linkedFiles: options.linkedFiles};
  }
  if (options.linkRoots !== undefined) {
    config = {...config, linkRoots: options.linkRoots};
  }
  if (options.mcpOAuthResource !== undefined) {
    config = {...config, mcpOAuthResource: options.mcpOAuthResource};
  }
  if (options.webAssetsRoot !== undefined) {
    config = {...config, webAssetsRoot: options.webAssetsRoot};
  }
  const server = await startLocalServer(config);

  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    hostname: server.hostname,
    port: server.port,
    stop: () => server.close(),
  };
}

/** Exchange the stable test-only credential for one browser login token. */
export async function issueLocalBrowserLogin(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<string> {
  const response = await fetch(new URL("/auth/local", server.baseUrl), {
    headers: {
      Authorization: `Bearer ${installation.browserBootstrapToken}`,
    },
    method: "POST",
  });
  if (response.status !== 201) {
    throw new Error(`Local browser login issuance failed with ${response.status}.`);
  }
  return z.object({
    expiresAt: z.iso.datetime(),
    token: z.string().min(32).max(200),
  }).strict().parse(await response.json()).token;
}

export async function fetchVersion(
  server: RunningTestServer,
  versionUrl: string,
  method = "GET",
  headers?: HeadersInit,
): Promise<Response> {
  const target = new URL(versionUrl);
  const requestHeaders = ["Host", `${target.hostname}:${server.port}`];
  for (const [name, value] of new Headers(headers)) {
    requestHeaders.push(name, value);
  }
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        headers: requestHeaders,
        hostname: "127.0.0.1",
        method,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              responseHeaders.append(name, value);
            }
          }
          const bytes = Buffer.concat(chunks);
          const body = new Uint8Array(bytes.byteLength);
          body.set(bytes);
          const status = incoming.statusCode ?? 500;
          resolve(
            new Response(status === 204 || status === 205 || status === 304
              ? null
              : body.buffer, {
              headers: responseHeaders,
              status,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/**
 * Extract the login handshake cookie a browser replays at `/auth/callback`.
 */
export function loginHandshakeCookie(loginResponse: Response): string {
  const cookie = loginResponse.headers.getSetCookie().find((value) =>
    value.startsWith("artifact_login=") ||
    value.startsWith("__Host-artifact_login=")
  );
  if (cookie === undefined) {
    throw new Error("/auth/login did not set a login handshake cookie.");
  }
  return cookie.split(";")[0] ?? "";
}

export function apiHeaders(
  installation: TestInstallation,
  idempotencyKey: string,
): Headers {
  return new Headers({
    Authorization: `Bearer ${installation.apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}
