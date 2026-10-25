import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {DirectorySyncReport} from
  "../../src/application/directory-sync.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import type {OidcGroupRoles} from "../../src/identity/oidc-groups-claim.js";
import {
  KeycloakDirectory,
  keycloakAdminBaseUrl,
} from "../../src/identity/keycloak-directory.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  keycloakUser,
  startStubKeycloak,
  type RunningStubKeycloak,
} from "../support/stub-keycloak-directory.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administrators = "artifact-admins";
const users = "artifact-users";
const groupRoles: OidcGroupRoles = {
  administratorGroups: [administrators],
  claim: "groups",
  memberGroups: [users],
};
const memberRowSchema = z.object({
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  role: z.string(),
  status: z.string(),
});
const bindingRowSchema = z.object({member_id: z.string(), subject: z.string()});
const sessionSchema = z.object({
  principal: z.object({id: z.string(), membershipRole: z.string()}),
});

type MemberRow = z.infer<typeof memberRowSchema>;

describe("Keycloak directory sync", () => {
  let installation: TestInstallation;
  let keycloak: RunningStubKeycloak;

  beforeEach(async () => {
    installation = await createTestInstallation();
    keycloak = await startStubKeycloak();
  });

  afterEach(async () => {
    await keycloak.stop();
    await removeTestInstallation(installation);
  });

  test("admits every group member with its role across pages, administrators winning", async () => {
    const many = Array.from(
      {length: 205},
      (_, index) => keycloakUser(`user${String(index).padStart(3, "0")}`),
    );
    const ada = keycloakUser("ada", {firstName: " Ada ", lastName: "Lovelace"});
    keycloak.groups.set(users, [...many, ada]);
    keycloak.groups.set(administrators, [ada, keycloakUser("bob")]);

    expect(await sync()).toEqual(report({
      admitted: 207,
      directoryUsers: 207,
    }));
    const rows = members(installation);
    expect(rows).toHaveLength(207);
    expect(byEmail(rows, "ada@example.test")).toMatchObject({
      displayName: "Ada Lovelace",
      role: "administrator",
      status: "active",
    });
    expect(byEmail(rows, "bob@example.test")).toMatchObject({
      displayName: "bob",
      role: "administrator",
    });
    expect(byEmail(rows, "user204@example.test")).toMatchObject({role: "member"});

    const memberPages = keycloak.adminRequests()
      .filter((request) => request.path.endsWith("/members"))
      .map((request) => request.query);
    expect(memberPages).toContainEqual({
      briefRepresentation: "true",
      first: "200",
      max: "100",
    });
    expect(memberPages.filter((query) => query.first === "300")).toEqual([]);
    expect(keycloak.adminRequests()
      .filter((request) => request.path === "/groups")
      .map((request) => request.query))
      .toEqual([
        {exact: "true", search: administrators},
        {exact: "true", search: users},
      ]);

    // A second pass with nothing changed writes nothing.
    expect(await sync()).toEqual(report({directoryUsers: 207, unchanged: 207}));
  });

  test("roles change both ways, leavers are deactivated, and returners restored", async () => {
    keycloak.groups.set(administrators, [keycloakUser("ada")]);
    keycloak.groups.set(users, [keycloakUser("bob"), keycloakUser("carol")]);
    await sync();
    const before = members(installation);

    keycloak.groups.set(administrators, [keycloakUser("bob")]);
    keycloak.groups.set(users, [keycloakUser("ada")]);
    expect(await sync()).toEqual(report({
      deactivated: 1,
      directoryUsers: 2,
      roleChanged: 2,
    }));
    expect(members(installation)).toEqual([
      {...byEmail(before, "ada@example.test"), role: "member"},
      {...byEmail(before, "bob@example.test"), role: "administrator"},
      {...byEmail(before, "carol@example.test"), status: "inactive"},
    ]);

    keycloak.groups.set(users, [keycloakUser("ada"), keycloakUser("carol")]);
    expect(await sync()).toEqual(report({
      directoryUsers: 3,
      reactivated: 1,
      unchanged: 2,
    }));
    expect(byEmail(members(installation), "carol@example.test")).toEqual({
      ...byEmail(before, "carol@example.test"),
      status: "active",
    });

    // The issuer decides who administers: the last administrator leaves too.
    keycloak.groups.set(administrators, []);
    keycloak.groups.set(users, [keycloakUser("ada")]);
    expect(await sync()).toEqual(report({
      deactivated: 2,
      directoryUsers: 1,
      unchanged: 1,
    }));
    expect(byEmail(members(installation), "bob@example.test"))
      .toMatchObject({role: "member", status: "inactive"});
  });

  test("disabled, unverified, and email-less users are skipped and lose membership", async () => {
    keycloak.groups.set(administrators, [keycloakUser("ada")]);
    keycloak.groups.set(users, [keycloakUser("bob")]);
    await sync();

    keycloak.groups.set(users, [
      keycloakUser("bob", {enabled: false}),
      keycloakUser("carol", {emailVerified: false}),
      keycloakUser("dave", {email: ""}),
      {emailVerified: true, enabled: true, id: "user-erin", username: "erin"},
    ]);
    expect(await sync()).toEqual(report({
      deactivated: 1,
      directoryUsers: 5,
      skipped: 4,
      unchanged: 1,
    }));
    expect(members(installation).map(({email, status}) => ({email, status})))
      .toEqual([
        {email: "ada@example.test", status: "active"},
        {email: "bob@example.test", status: "inactive"},
      ]);
  });

  test("an unknown group, a token failure, a failed page, or an empty directory changes nothing", async () => {
    const many = Array.from({length: 150}, (_, index) => keycloakUser(`user${index}`));
    keycloak.groups.set(administrators, [keycloakUser("ada")]);
    keycloak.groups.set(users, many);
    await sync();
    const baseline = members(installation);
    expect(baseline).toHaveLength(151);

    keycloak.groups.delete(administrators);
    await expect(sync()).rejects.toThrow(
      `DirectoryUnavailable: The Keycloak group ${administrators} does not exist.`,
    );
    expect(members(installation)).toEqual(baseline);
    keycloak.groups.set(administrators, [keycloakUser("ada")]);

    keycloak.setTokenStatus(503);
    await expect(sync()).rejects.toThrow("The Keycloak token request returned HTTP 503.");
    expect(members(installation)).toEqual(baseline);
    keycloak.setTokenStatus(200);

    // Losing the second page must not read as fifty people leaving.
    keycloak.failMembersPage(100);
    await expect(sync()).rejects.toThrow(`The Keycloak members of ${users} returned HTTP 500.`);
    expect(members(installation)).toEqual(baseline);
    keycloak.failMembersPage(null);

    keycloak.groups.set(administrators, [keycloakUser("ada", {enabled: false})]);
    keycloak.groups.set(users, Array.from(
      {length: 150},
      (_, index) => keycloakUser(`user${index}`, {emailVerified: false}),
    ));
    await expect(sync()).rejects.toThrow("nothing was changed");
    expect(members(installation)).toEqual(baseline);

    await expect(sync("wrong-secret")).rejects.toThrow("HTTP 401");
    expect(members(installation)).toEqual(baseline);
  });

  test("a member the sync admitted binds to the OIDC subject at first login and keeps the role", async () => {
    keycloak.groups.set(administrators, [keycloakUser("ada")]);
    keycloak.groups.set(users, [keycloakUser("bob")]);
    await sync();
    const [ada] = members(installation);

    const provider = await startStubOidcProvider({clientId: "artifact-server"});
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    const server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: "bootstrap@example.test",
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
    try {
      provider.claims.email = "ada@example.test";
      provider.claims.subject = "keycloak-subject-ada";
      provider.claims.groups = [administrators];
      const authorization = await startStubOidcLogin(server.baseUrl);
      const completed = await fetch(authorization.callbackUrl, {
        headers: {Cookie: authorization.handshakeCookie},
        redirect: "manual",
      });
      expect(completed.status).toBe(303);
      const cookie = completed.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .filter((pair) =>
          pair?.startsWith("artifact_session=") === true ||
          pair?.startsWith("artifact_csrf=") === true
        )
        .join("; ");
      const session = await fetch(`${server.baseUrl}/api/v1/session`, {
        headers: {Cookie: cookie},
      });
      expect(sessionSchema.parse(await session.json()).principal).toEqual({
        id: ada?.id,
        membershipRole: "administrator",
      });
    } finally {
      await server.stop();
      await provider.stop();
    }
    expect(members(installation)).toHaveLength(2);
    expect(bindings(installation)).toEqual([
      {member_id: ada?.id, subject: "keycloak-subject-ada"},
    ]);
  });

  test("the admin base follows a realm issuer and refuses anything else", () => {
    expect(keycloakAdminBaseUrl("https://idp.example.test/realms/main"))
      .toBe("https://idp.example.test/admin/realms/main");
    expect(keycloakAdminBaseUrl("https://idp.example.test/auth/realms/main"))
      .toBe("https://idp.example.test/auth/admin/realms/main");
    expect(keycloakAdminBaseUrl("https://idp.example.test")).toBeNull();
    expect(keycloakAdminBaseUrl("https://idp.example.test/realms")).toBeNull();
    expect(keycloakAdminBaseUrl("https://idp.example.test/realms/main/extra"))
      .toBeNull();
  });

  async function sync(secret = keycloak.clientSecret): Promise<DirectorySyncReport> {
    const runtime = await createLocalRuntime({
      apiToken: installation.apiToken,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      contentDomain: "localhost",
      dataDirectory: installation.dataDirectory,
      groupRolePolicy: groupRoles,
    });
    try {
      const adminBaseUrl = keycloakAdminBaseUrl(keycloak.issuer);
      if (adminBaseUrl === null) throw new Error("The stub issuer is not a realm.");
      return await runtime.syncDirectory(new KeycloakDirectory({
        adminBaseUrl,
        clientId: keycloak.clientId,
        clientSecret: Redacted.make(secret),
        issuer: keycloak.issuer,
      }), groupRoles);
    } finally {
      await runtime.close();
    }
  }
});

function report(changes: Partial<DirectorySyncReport>): DirectorySyncReport {
  return {
    groups: 2,
    directoryUsers: 0,
    admitted: 0,
    reactivated: 0,
    roleChanged: 0,
    deactivated: 0,
    unchanged: 0,
    skipped: 0,
    ...changes,
  };
}

function byEmail(rows: readonly MemberRow[], email: string): MemberRow {
  const row = rows.find((candidate) => candidate.email === email);
  if (row === undefined) throw new Error(`No member has ${email}.`);
  return row;
}

function members(installation: TestInstallation): readonly MemberRow[] {
  return rowsOf(
    installation,
    "SELECT id, email, display_name AS displayName, role, status FROM installation_members ORDER BY email",
  ).map((row) => memberRowSchema.parse(row));
}

function bindings(
  installation: TestInstallation,
): readonly z.infer<typeof bindingRowSchema>[] {
  return rowsOf(
    installation,
    "SELECT member_id, subject FROM external_identities ORDER BY subject",
  ).map((row) => bindingRowSchema.parse(row));
}

function rowsOf(installation: TestInstallation, sql: string) {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}
