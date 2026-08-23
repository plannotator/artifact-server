import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Redacted} from "effect";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {privateTeamBrowserAccess, browserLoginKinds} from
  "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {
  loginHandshakeCookie,
  reserveLoopbackPort,
  startTestServer,
} from "../support/runtime-harness.js";

const realmName = "artifact-server";
const oidcClientId = "artifact-server-integration";
const oidcClientSecret = "keycloak-integration-only-client-secret";
const oidcScopes = "openid email profile";
const admittedEmail = "admitted@example.test";
const admittedPassword = "admitted-keycloak-integration-only";
const strangerEmail = "stranger@example.test";
const strangerPassword = "stranger-keycloak-integration-only";
const loginFormPattern =
  /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/u;

const adminTokenSchema = z.object({access_token: z.string().min(1)});
const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const memberListSchema = z.object({
  members: z.array(z.object({
    displayName: z.string(),
    email: z.string(),
    id: z.string(),
    role: z.string(),
    status: z.string(),
  })),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const externalIdentityRowSchema = z.object({
  email: z.string(),
  member_id: z.string(),
  provider: z.string(),
  subject: z.string(),
});
const loginAttemptRowSchema = z.object({
  consumed_at: z.string().nullable(),
  nonce: z.string().nullable(),
  provider: z.string(),
});
const countRowSchema = z.object({total: z.number().int().nonnegative()});

interface KeycloakEnvironment {
  readonly adminPassword: string;
  readonly adminUser: string;
  readonly baseUrl: string;
}

interface KeycloakCredentials {
  readonly password: string;
  readonly username: string;
}

interface ProvisionedRealm {
  readonly admittedSubject: string;
  readonly issuer: string;
  readonly strangerSubject: string;
}

interface KeycloakRealmRepresentation {
  readonly enabled: boolean;
  readonly realm: string;
}

interface KeycloakClientRepresentation {
  readonly attributes: {readonly "pkce.code.challenge.method": string};
  readonly clientId: string;
  readonly directAccessGrantsEnabled: boolean;
  readonly enabled: boolean;
  readonly protocol: string;
  readonly publicClient: boolean;
  readonly redirectUris: readonly string[];
  readonly secret: string;
  readonly serviceAccountsEnabled: boolean;
  readonly standardFlowEnabled: boolean;
  readonly webOrigins: readonly string[];
}

interface KeycloakUserRepresentation {
  readonly credentials: readonly {
    readonly temporary: boolean;
    readonly type: string;
    readonly value: string;
  }[];
  readonly email: string;
  readonly emailVerified: boolean;
  readonly enabled: boolean;
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
}

type KeycloakRepresentation =
  | KeycloakClientRepresentation
  | KeycloakRealmRepresentation
  | KeycloakUserRepresentation;

interface RunningApplication {
  readonly baseUrl: string;
  readonly dataDirectory: string;
  stop(): Promise<void>;
}

describe.sequential("Keycloak generic OIDC browser login", () => {
  let keycloak: KeycloakEnvironment;
  let realm: ProvisionedRealm;
  let application: RunningApplication;

  beforeAll(async () => {
    keycloak = readKeycloakEnvironment();
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    realm = await provisionKeycloakRealm(keycloak, applicationOrigin);
    application = await startApplicationProcess(realm.issuer, applicationOrigin, port);
  });

  afterAll(async () => {
    if (application !== undefined) {
      await application.stop();
      await rm(application.dataDirectory, {force: true, recursive: true});
    }
  });

  test("an admitted person signs in through the real Keycloak login page", async () => {
    const login = await fetch(`${application.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const authorizationUrl = redirectTarget(login, "/auth/login");
    expect(authorizationUrl.origin).toBe(keycloak.baseUrl);
    expect(authorizationUrl.pathname)
      .toBe(`/realms/${realmName}/protocol/openid-connect/auth`);
    const query = authorizationUrl.searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(oidcClientId);
    expect(query.get("redirect_uri"))
      .toBe(`${application.baseUrl}/auth/callback`);
    expect(query.get("scope")).toBe(oidcScopes);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).not.toBeNull();
    expect(query.get("nonce")).not.toBeNull();

    const attempts = loginAttempts(application.dataDirectory);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.provider).toBe("oidc");
    expect(attempts[0]?.nonce).toBe(query.get("nonce"));
    expect(attempts[0]?.consumed_at).toBeNull();

    const callbackUrl = await signInAtKeycloak(authorizationUrl, {
      password: admittedPassword,
      username: admittedEmail,
    });
    expect(callbackUrl.origin).toBe(application.baseUrl);
    expect(callbackUrl.pathname).toBe("/auth/callback");
    expect(callbackUrl.searchParams.get("state")).toBe(query.get("state"));

    const completed = await fetch(callbackUrl, {
      headers: {Cookie: loginHandshakeCookie(login)},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    const applicationCookies = applicationCookieHeader(
      completed.headers.getSetCookie(),
    );

    const session = await fetch(`${application.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookies},
    });
    expect(session.status).toBe(200);
    const principal = sessionResponseSchema.parse(await session.json()).principal;

    const members = await fetch(`${application.baseUrl}/api/v1/members`, {
      headers: {Cookie: applicationCookies},
    });
    expect(members.status).toBe(200);
    expect(memberListSchema.parse(await members.json()).members).toEqual([{
      displayName: "Ada Lovelace",
      email: admittedEmail,
      id: principal.id,
      role: "administrator",
      status: "active",
    }]);
    expect(externalIdentities(application.dataDirectory)).toEqual([{
      email: admittedEmail,
      member_id: principal.id,
      provider: `oidc:${realm.issuer}`,
      subject: realm.admittedSubject,
    }]);
    const consumed = loginAttempts(application.dataDirectory);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.consumed_at).not.toBeNull();
  });

  test("a Keycloak identity that was never admitted is refused", async () => {
    const login = await fetch(`${application.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const authorizationUrl = redirectTarget(login, "/auth/login");

    const callbackUrl = await signInAtKeycloak(authorizationUrl, {
      password: strangerPassword,
      username: strangerEmail,
    });
    const refused = await fetch(callbackUrl, {
      headers: {Cookie: loginHandshakeCookie(login)},
      redirect: "manual",
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("IDENTITY_ADMISSION_DENIED");

    expect(externalIdentities(application.dataDirectory).map((row) => row.subject))
      .toEqual([realm.admittedSubject]);
    expect(rowCount(application.dataDirectory, "installation_members")).toBe(1);
    expect(rowCount(application.dataDirectory, "application_sessions")).toBe(1);
  });
});

function readKeycloakEnvironment(): KeycloakEnvironment {
  const adminPassword = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD"];
  const adminUser = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER"];
  const baseUrl = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_URL"];
  if (
    adminPassword === undefined || adminUser === undefined || baseUrl === undefined
  ) {
    throw new Error("Run this test through pnpm test:oidc.");
  }
  return {adminPassword, adminUser, baseUrl};
}

async function provisionKeycloakRealm(
  environment: KeycloakEnvironment,
  applicationOrigin: string,
): Promise<ProvisionedRealm> {
  const token = await requestAdminToken(environment);
  await adminRequest(environment, token, "POST", "/admin/realms", {
    enabled: true,
    realm: realmName,
  });
  await adminRequest(
    environment,
    token,
    "POST",
    `/admin/realms/${realmName}/clients`,
    {
      attributes: {"pkce.code.challenge.method": "S256"},
      clientId: oidcClientId,
      directAccessGrantsEnabled: false,
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      redirectUris: [`${applicationOrigin}/auth/callback`],
      secret: oidcClientSecret,
      serviceAccountsEnabled: false,
      standardFlowEnabled: true,
      webOrigins: [applicationOrigin],
    },
  );
  const admittedSubject = await createKeycloakUser(environment, token, {
    email: admittedEmail,
    firstName: "Ada",
    lastName: "Lovelace",
    password: admittedPassword,
    username: admittedEmail,
  });
  const strangerSubject = await createKeycloakUser(environment, token, {
    email: strangerEmail,
    firstName: "Grace",
    lastName: "Hopper",
    password: strangerPassword,
    username: strangerEmail,
  });
  return {
    admittedSubject,
    issuer: `${environment.baseUrl}/realms/${realmName}`,
    strangerSubject,
  };
}

async function requestAdminToken(
  environment: KeycloakEnvironment,
): Promise<string> {
  const response = await fetch(
    `${environment.baseUrl}/realms/master/protocol/openid-connect/token`,
    {
      body: new URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        password: environment.adminPassword,
        username: environment.adminUser,
      }),
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Keycloak refused the administrator token: HTTP ${response.status}`,
    );
  }
  return adminTokenSchema.parse(await response.json()).access_token;
}

async function createKeycloakUser(
  environment: KeycloakEnvironment,
  token: string,
  person: {
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly password: string;
    readonly username: string;
  },
): Promise<string> {
  const created = await adminRequest(
    environment,
    token,
    "POST",
    `/admin/realms/${realmName}/users`,
    {
      credentials: [{
        temporary: false,
        type: "password",
        value: person.password,
      }],
      email: person.email,
      emailVerified: true,
      enabled: true,
      firstName: person.firstName,
      lastName: person.lastName,
      username: person.username,
    },
  );
  const location = created.headers.get("location");
  if (location === null) {
    throw new Error("Keycloak created a user without a location header.");
  }
  const subject = location.split("/").pop();
  if (subject === undefined || subject === "") {
    throw new Error("Keycloak returned an unusable user location.");
  }
  return subject;
}

async function adminRequest(
  environment: KeycloakEnvironment,
  token: string,
  method: string,
  resourcePath: string,
  body: KeycloakRepresentation,
): Promise<Response> {
  const response = await fetch(`${environment.baseUrl}${resourcePath}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method,
  });
  if (!response.ok) {
    throw new Error(
      `Keycloak refused ${method} ${resourcePath}: HTTP ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

async function signInAtKeycloak(
  authorizationUrl: URL,
  credentials: KeycloakCredentials,
): Promise<URL> {
  const cookies = new Map<string, string>();
  const page = await fetch(authorizationUrl, {
    headers: {Cookie: cookieHeader(cookies)},
    redirect: "manual",
  });
  storeCookies(cookies, page.headers.getSetCookie());
  if (page.status !== 200) {
    throw new Error(
      `The Keycloak login page answered HTTP ${page.status}.`,
    );
  }
  const action = loginFormPattern.exec(await page.text())?.[1];
  if (action === undefined) {
    throw new Error("The Keycloak login page did not contain a login form.");
  }
  const submitted = await fetch(action.replaceAll("&amp;", "&"), {
    body: new URLSearchParams({
      credentialId: "",
      password: credentials.password,
      username: credentials.username,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(cookies),
    },
    method: "POST",
    redirect: "manual",
  });
  storeCookies(cookies, submitted.headers.getSetCookie());
  if (submitted.status !== 302) {
    throw new Error(
      `Keycloak did not accept the credentials: HTTP ${submitted.status}`,
    );
  }
  return redirectTarget(submitted, "the Keycloak login form");
}

function storeCookies(
  cookies: Map<string, string>,
  setCookieHeaders: readonly string[],
): void {
  for (const header of setCookieHeaders) {
    const pair = header.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "") cookies.delete(name);
    else cookies.set(name, value);
  }
}

function cookieHeader(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function applicationCookieHeader(setCookieHeaders: readonly string[]): string {
  const pairs = setCookieHeaders
    .filter((value) =>
      value.startsWith("artifact_session=") || value.startsWith("artifact_csrf=")
    )
    .map((value) => value.split(";", 1)[0]);
  if (pairs.length !== 2) {
    throw new Error("The login response did not issue both application cookies.");
  }
  return pairs.join("; ");
}

function redirectTarget(response: Response, step: string): URL {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(
      `${step} answered ${response.status} without a redirect location.`,
    );
  }
  return new URL(location);
}

async function startApplicationProcess(
  issuer: string,
  applicationOrigin: string,
  port: number,
): Promise<RunningApplication> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-oidc-"),
  );
  const server = await startTestServer({
    apiToken:
      "as_key_key_00000000-0000-4000-8000-000000000002_oidcIntegrationMachineCredential12345",
    browserBootstrapToken: "unused-private-team-browser-bootstrap-token",
    dataDirectory,
  }, {
    applicationOrigin,
    bootstrapAdministratorEmail: admittedEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin,
      clientId: oidcClientId,
      clientSecret: Redacted.make(oidcClientSecret, {label: "oidc-client-secret"}),
      issuer,
      scopes: oidcScopes,
    }),
    port,
  });
  return {
    baseUrl: server.baseUrl,
    dataDirectory,
    stop: () => server.stop(),
  };
}

function externalIdentities(
  dataDirectory: string,
): readonly z.infer<typeof externalIdentityRowSchema>[] {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return database
      .prepare(
        "SELECT provider, subject, member_id, email FROM external_identities ORDER BY subject",
      )
      .all()
      .map((row) => externalIdentityRowSchema.parse(row));
  } finally {
    database.close();
  }
}

function loginAttempts(
  dataDirectory: string,
): readonly z.infer<typeof loginAttemptRowSchema>[] {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return database
      .prepare(
        "SELECT consumed_at, nonce, provider FROM login_attempts ORDER BY created_at",
      )
      .all()
      .map((row) => loginAttemptRowSchema.parse(row));
  } finally {
    database.close();
  }
}

function rowCount(dataDirectory: string, table: string): number {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return countRowSchema.parse(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
    ).total;
  } finally {
    database.close();
  }
}

function openIdentityDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(path.join(dataDirectory, "artifact-server.db"), {
    readOnly: true,
  });
}
