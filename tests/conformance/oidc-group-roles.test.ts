import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import type {OidcGroupRoles} from "../../src/identity/oidc-groups-claim.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const bootstrapEmail = "administrator@example.test";
const groupRoles: OidcGroupRoles = {
  administratorGroups: ["artifact-admins"],
  claim: "roles",
  memberGroups: ["artifact-users"],
};
const sessionResponseSchema = z.object({
  principal: z.object({
    id: z.string(),
    membershipRole: z.enum(["administrator", "member"]),
  }),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const memberRowSchema = z.object({
  email: z.string(),
  role: z.string(),
  status: z.string(),
});

describe("generic OIDC browser login with issuer group roles", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "artifact-server-oidc-groups",
    });
    provider.claims.groupsClaim = groupRoles.claim;
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: bootstrapEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      groupRolePolicy: groupRoles,
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: provider.clientId,
        clientSecret: null,
        groupRoles,
        issuer: provider.issuer,
        scopes: "openid email profile",
      }),
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("the configured claim admits people by group and every login re-applies their role", async () => {
    provider.claims.email = "ada@example.test";
    provider.claims.subject = "subject-ada";
    provider.claims.groups = ["artifact-admins", "artifact-users"];
    const adaFirst = await signIn();
    expect(await sessionRole(adaFirst)).toBe("administrator");

    provider.claims.email = "grace@example.test";
    provider.claims.subject = "subject-grace";
    provider.claims.groups = ["artifact-users", "sales"];
    expect(await sessionRole(await signIn())).toBe("member");

    // Ada leaves the administrator group; her next login demotes her, and the
    // session she already holds follows the member it belongs to.
    provider.claims.email = "ada@example.test";
    provider.claims.subject = "subject-ada";
    provider.claims.groups = ["artifact-users"];
    expect(await sessionRole(await signIn())).toBe("member");
    expect(await sessionRole(adaFirst)).toBe("member");

    expect(members(installation)).toEqual([
      {email: "ada@example.test", role: "member", status: "active"},
      {email: "grace@example.test", role: "member", status: "active"},
    ]);
  });

  test("a person outside the groups is refused, deactivated, and signed out", async () => {
    provider.claims.email = bootstrapEmail;
    provider.claims.groups = ["artifact-users"];
    const session = await signIn();
    expect(await sessionRole(session)).toBe("member");

    provider.claims.groups = ["sales"];
    const refused = await completeLogin();
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await refused.json()).error).toEqual({
      code: "IDENTITY_ADMISSION_DENIED",
      message: "This person is not in a group admitted to the Artifact Server.",
    });
    expect(members(installation)).toEqual([
      {email: bootstrapEmail, role: "member", status: "inactive"},
    ]);
    const revoked = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: session},
    });
    expect(revoked.status).toBe(401);

    // Without the claim at all, the bootstrap email admits no one either.
    provider.claims.groups = null;
    expect((await completeLogin()).status).toBe(403);
  });

  test("a groups claim that is not a list of strings fails as a provider failure", async () => {
    provider.claims.email = bootstrapEmail;
    provider.claims.groups = "artifact-admins";
    const refused = await completeLogin();
    expect(refused.status).toBe(502);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("IDENTITY_PROVIDER_FAILURE");
    expect(members(installation)).toEqual([]);
  });

  async function completeLogin(): Promise<Response> {
    const authorization = await startStubOidcLogin(server.baseUrl);
    return fetch(authorization.callbackUrl, {
      headers: {Cookie: authorization.handshakeCookie},
      redirect: "manual",
    });
  }

  /** Complete one login and return the application cookie header it issued. */
  async function signIn(): Promise<string> {
    const completed = await completeLogin();
    expect(completed.status).toBe(303);
    const pairs = completed.headers.getSetCookie()
      .filter((value) =>
        value.startsWith("artifact_session=") || value.startsWith("artifact_csrf=")
      )
      .map((value) => value.split(";", 1)[0]);
    expect(pairs).toHaveLength(2);
    return pairs.join("; ");
  }

  async function sessionRole(cookieHeader: string): Promise<string> {
    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookieHeader},
    });
    expect(session.status).toBe(200);
    return sessionResponseSchema.parse(await session.json())
      .principal.membershipRole;
  }
});

function members(
  installation: TestInstallation,
): readonly z.infer<typeof memberRowSchema>[] {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
  try {
    return database
      .prepare("SELECT email, role, status FROM installation_members ORDER BY email")
      .all()
      .map((row) => memberRowSchema.parse(row));
  } finally {
    database.close();
  }
}
