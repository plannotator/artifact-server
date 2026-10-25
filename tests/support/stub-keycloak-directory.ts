import {randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type Server} from "node:http";

import {z} from "zod";

const realmName = "artifact";
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const tokenFormSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  grant_type: z.literal("client_credentials"),
});

/** One user as Keycloak's brief representation reports it. */
export interface StubKeycloakUser {
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly enabled: boolean;
  readonly firstName?: string;
  readonly id: string;
  readonly lastName?: string;
  readonly username: string;
}

/** One admin request the stub answered, for pagination assertions. */
export interface StubKeycloakAdminRequest {
  readonly path: string;
  readonly query: Readonly<Partial<Record<"briefRepresentation" | "exact" | "first" | "max" | "search", string>>>;
}

/** A real HTTP boundary that speaks the Keycloak token and admin REST API. */
export interface RunningStubKeycloak {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Group name to its complete, ordered membership. */
  readonly groups: Map<string, StubKeycloakUser[]>;
  readonly issuer: string;
  adminRequests(): readonly StubKeycloakAdminRequest[];
  /** Answer the members page starting at `first` with this status instead. */
  failMembersPage(first: number | null, status?: number): void;
  setTokenStatus(status: number): void;
  stop(): Promise<void>;
  tokenRequests(): number;
}

/** Start one Keycloak realm boundary on loopback. */
export async function startStubKeycloak(): Promise<RunningStubKeycloak> {
  const clientId = "artifact-server-directory";
  const clientSecret = `directory-secret-${randomUUID()}`;
  const groups = new Map<string, StubKeycloakUser[]>();
  const groupIds = new Map<string, string>();
  const adminRequests: StubKeycloakAdminRequest[] = [];
  const issuedTokens = new Set<string>();
  let failingPage: {readonly first: number; readonly status: number} | null = null;
  let tokenRequestCount = 0;
  let tokenStatus = 200;
  let issuer = "";
  const realmPath = `/realms/${realmName}`;
  const adminPath = `/admin/realms/${realmName}`;

  const groupId = (name: string): string => {
    const existing = groupIds.get(name);
    if (existing !== undefined) return existing;
    const created = randomUUID();
    groupIds.set(name, created);
    return created;
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub.invalid");
    const json = (status: number, body: string) => {
      response.writeHead(status, {"Content-Type": "application/json"});
      response.end(body);
    };
    if (url.pathname === `${realmPath}/.well-known/openid-configuration`) {
      json(200, JSON.stringify({
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        code_challenge_methods_supported: ["S256"],
        issuer,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        response_types_supported: ["code"],
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
      }));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === `${realmPath}/protocol/openid-connect/token`
    ) {
      const answerToken = async () => {
        const body = await readBody(request);
        tokenRequestCount += 1;
        const form = tokenFormSchema.safeParse(
          Object.fromEntries(new URLSearchParams(body)),
        );
        if (
          !form.success || form.data.client_id !== clientId ||
          form.data.client_secret !== clientSecret
        ) {
          json(401, JSON.stringify({error: "unauthorized_client"}));
          return;
        }
        if (tokenStatus !== 200) {
          json(tokenStatus, JSON.stringify({error: "server_error"}));
          return;
        }
        const token = `stub-admin-token-${randomUUID()}`;
        issuedTokens.add(token);
        json(200, JSON.stringify({access_token: token, token_type: "Bearer"}));
      };
      answerToken().catch(() => json(500, JSON.stringify({error: "server_error"})));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith(`${adminPath}/`)) {
      const authorization = request.headers.authorization ?? "";
      if (!issuedTokens.has(authorization.replace(/^Bearer /u, ""))) {
        json(401, JSON.stringify({error: "HTTP 401 Unauthorized"}));
        return;
      }
      const query = {
        briefRepresentation: url.searchParams.get("briefRepresentation") ?? undefined,
        exact: url.searchParams.get("exact") ?? undefined,
        first: url.searchParams.get("first") ?? undefined,
        max: url.searchParams.get("max") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
      };
      const path = url.pathname.slice(adminPath.length);
      adminRequests.push({path, query: withoutUndefined(query)});
      if (path === "/groups") {
        // Keycloak's exact search still returns matching groups with their
        // subgroups; a near-miss name never comes back.
        const search = query.search ?? "";
        json(200, JSON.stringify([...groups.keys()]
          .filter((name) =>
            query.exact === "true" ? name === search : name.includes(search)
          )
          .map((name) => ({id: groupId(name), name, path: `/${name}`, subGroups: []}))));
        return;
      }
      const members = /^\/groups\/([^/]+)\/members$/u.exec(path);
      const name = [...groupIds.entries()]
        .find(([, id]) => id === members?.[1])?.[0];
      const users = name === undefined ? undefined : groups.get(name);
      if (users === undefined) {
        json(404, JSON.stringify({error: "Could not find group by id"}));
        return;
      }
      const first = Number(query.first ?? "0");
      const max = Number(query.max ?? "100");
      if (failingPage !== null && failingPage.first === first) {
        json(failingPage.status, JSON.stringify({error: "server_error"}));
        return;
      }
      json(200, JSON.stringify(users.slice(first, first + max)));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  issuer = `http://127.0.0.1:${
    assignedAddressSchema.parse(server.address()).port
  }${realmPath}`;
  return {
    adminRequests: () => adminRequests,
    clientId,
    clientSecret,
    failMembersPage: (first, status = 500) => {
      failingPage = first === null ? null : {first, status};
    },
    groups,
    issuer,
    setTokenStatus: (status) => {
      tokenStatus = status;
    },
    stop: () => closeServer(server),
    tokenRequests: () => tokenRequestCount,
  };
}

/** A directory user with a verified email that sync admits. */
export function keycloakUser(
  username: string,
  overrides: Partial<StubKeycloakUser> = {},
): StubKeycloakUser {
  return {
    email: `${username}@example.test`,
    emailVerified: true,
    enabled: true,
    id: `user-${username}`,
    username,
    ...overrides,
  };
}

function withoutUndefined(
  query: Readonly<Record<keyof StubKeycloakAdminRequest["query"], string | undefined>>,
): StubKeycloakAdminRequest["query"] {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
