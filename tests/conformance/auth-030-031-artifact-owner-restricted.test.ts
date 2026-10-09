import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const allCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link", "restricted"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactSchema})),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const threadSchema = z.object({thread: z.object({id: z.string()})});
const agentSchema = z.object({agent: z.object({id: z.string()})});
const errorSchema = z.object({error: z.object({code: z.string()})});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A caller that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

/** The local-owner administrator, signed in through a browser session. */
interface BrowserActor {
  readonly cookies: ApplicationCookies;
  readonly id: string;
}

type Caller = Actor | BrowserActor;

/** The administrator's request to issue one API key. */
interface IssueKeyRequest {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

describe("artifact owners and restricted access", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Actor;
  let ben: Actor;
  let service: Actor;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    ada = await memberWithKey("Ada", "ada@example.test");
    ben = await memberWithKey("Ben", "ben@example.test");
    service = await issueKey(undefined, "Release bot");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-030-B: each creator is recorded as owner and an upgrade backfills owners from version 1", async () => {
    expect.hasAssertions();
    const byAda = await publishAs(ada, "Ada's page");
    const byService = await publishAs(service, "Bot page");
    expect((await readArtifact(ada, byAda.id)).ownerPrincipalId).toBe(ada.id);
    expect((await readArtifact(service, byService.id)).ownerPrincipalId)
      .toBe(service.id);

    // A database from before owners were recorded has no owner column at all.
    await server.stop();
    const database = openDatabase();
    database.exec(`
      DROP INDEX artifacts_project_owner_active_created;
      ALTER TABLE artifacts DROP COLUMN owner_principal_id;
      PRAGMA user_version = 12;
    `);
    database.close();
    server = await startTestServer(installation);
    expect((await readArtifact(ada, byAda.id)).ownerPrincipalId).toBe(ada.id);
    expect((await readArtifact(service, byService.id)).ownerPrincipalId)
      .toBe(service.id);
  });

  test("AUTH-030-F: republishing, restoring, and changing tags or access through another member never change the owner", async () => {
    expect.hasAssertions();
    const published = await publishAs(ada, "Ada's shared page");
    const firstVersionId = published.currentVersionId;
    const second = await publishVersion(server, as(ben), {
      artifactId: published.id,
      content: "Ben's edit",
      expectedCurrentVersionId: firstVersionId,
      idempotencyKey: "auth-030-ben-version",
      projectId: published.projectId,
    });
    expect(second.response.status).toBe(201);
    const restored = await mutate(ben, "POST", `${published.id}/restore`, {
      expectedCurrentVersionId: second.body.version.id,
      versionId: firstVersionId,
    });
    expect(restored.status).toBe(200);
    const afterRestore = await readArtifact(ben, published.id);
    expect((await mutate(ben, "PATCH", `${published.id}/tags`, {
      expectedCurrentVersionId: afterRestore.currentVersionId,
      tags: ["edited-by-ben"],
    })).status).toBe(200);
    expect((await mutate(ben, "PATCH", `${published.id}/access`, {
      accessSetting: "public_link",
      expectedCurrentVersionId: afterRestore.currentVersionId,
    })).status).toBe(200);

    expect((await readArtifact(ada, published.id)).ownerPrincipalId).toBe(ada.id);

    // Restarting runs the owner migration again; it never overwrites an owner.
    await server.stop();
    server = await startTestServer(installation);
    expect((await readArtifact(ada, published.id)).ownerPrincipalId).toBe(ada.id);
  });

  test("AUTH-031-B: the owner and an administrator use a restricted artifact on every surface, and switching back restores member access", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's draft", "restricted");
    expect(draft.accessSetting).toBe("restricted");

    await Promise.all([ada, administratorActor()].map(async (viewer) => {
      expect(await listedNames(viewer)).toContain("Ada's draft");
      expect(await listedNames(viewer, "draft")).toContain("Ada's draft");
      expect((await readArtifact(viewer, draft.id)).accessSetting).toBe("restricted");
      expect((await request(viewer, "GET", `${draft.id}/versions`)).status).toBe(200);
      expect((await request(viewer, "POST", `${draft.id}/content-sessions`)).status)
        .toBe(201);
    }));

    const next = await publishVersion(server, as(ada), {
      artifactId: draft.id,
      content: "Ada's second draft",
      expectedCurrentVersionId: draft.currentVersionId,
      idempotencyKey: "auth-031-ada-version",
      projectId: draft.projectId,
    });
    expect(next.response.status).toBe(201);
    const thread = await commentOn(ada, draft.id, next.body.version.id);
    expect((await request(administratorActor(), "GET", `${draft.id}/comments`))
      .status).toBe(200);
    const agent = await registerAgent(service);
    expect((await dispatch(ada, agent, [thread])).status).toBe(201);

    expect(await listedNames(ben)).not.toContain("Ada's draft");
    expect((await mutate(ada, "PATCH", `${draft.id}/access`, {
      accessSetting: "account_required",
      expectedCurrentVersionId: next.body.version.id,
    })).status).toBe(200);
    expect(await listedNames(ben)).toContain("Ada's draft");
    expect((await readArtifact(ben, draft.id)).accessSetting).toBe("account_required");

    // An administrator can restrict, and lift the restriction, on anyone's artifact.
    expect((await mutate(administratorActor(), "PATCH", `${draft.id}/access`, {
      accessSetting: "restricted",
      expectedCurrentVersionId: next.body.version.id,
    })).status).toBe(200);
    expect(await listedNames(ben)).not.toContain("Ada's draft");
  });

  test("AUTH-031-F: other members and service principals cannot find, read, open, change, comment on, or dispatch a restricted artifact", async () => {
    expect.hasAssertions();
    const shared = await publishAs(ada, "Ada's page");
    const thread = await commentOn(ada, shared.id, shared.currentVersionId);

    // Ben opens content while it is shared; the switch must end that access.
    expect((await request(ben, "POST", `${shared.id}/content-sessions`)).status)
      .toBe(201);
    expect(openContentAccess(shared.id, ben.id)).toBeGreaterThan(0);

    // Only the owner or an administrator may restrict, even with manage:any.
    const denied = await mutate(ben, "PATCH", `${shared.id}/access`, {
      accessSetting: "restricted",
      expectedCurrentVersionId: shared.currentVersionId,
    });
    expect(denied.status).toBe(403);
    expect(errorSchema.parse(await denied.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await mutate(ada, "PATCH", `${shared.id}/access`, {
      accessSetting: "restricted",
      expectedCurrentVersionId: shared.currentVersionId,
    })).status).toBe(200);
    expect(openContentAccess(shared.id, ben.id)).toBe(0);

    const missing = await request(ben, "GET", "art_00000000-0000-4000-8000-000000000000");
    const missingBody = errorSchema.parse(await missing.json());
    await Promise.all([ben, service].map(async (outsider) => {
      expect(await listedNames(outsider)).not.toContain("Ada's page");
      expect(await listedNames(outsider, "page")).not.toContain("Ada's page");
      const attempts = await Promise.all([
        request(outsider, "GET", shared.id),
        request(outsider, "GET", `${shared.id}/versions`),
        request(outsider, "GET", `${shared.id}/comments`),
        request(outsider, "POST", `${shared.id}/content-sessions`),
        mutate(outsider, "PATCH", `${shared.id}/access`, {
          accessSetting: "account_required",
          expectedCurrentVersionId: shared.currentVersionId,
        }),
        mutate(outsider, "PATCH", `${shared.id}/tags`, {
          expectedCurrentVersionId: shared.currentVersionId,
          tags: ["outsider"],
        }),
        mutate(outsider, "POST", `${shared.id}/restore`, {
          expectedCurrentVersionId: shared.currentVersionId,
          versionId: shared.currentVersionId,
        }),
        mutate(outsider, "DELETE", shared.id, {
          expectedCurrentVersionId: shared.currentVersionId,
        }),
      ]);
      // Indistinguishable from an artifact that does not exist.
      expect(attempts.map((attempt) => attempt.status))
        .toEqual(attempts.map(() => missing.status));
      const bodies = await Promise.all(attempts.map(async (attempt) =>
        errorSchema.parse(await attempt.json())
      ));
      expect(bodies).toEqual(attempts.map(() => missingBody));
      await expect(publishVersion(server, as(outsider), {
        artifactId: shared.id,
        content: "outsider version",
        expectedCurrentVersionId: shared.currentVersionId,
        idempotencyKey: `auth-031-outsider-version-${outsider.id}`,
        projectId: shared.projectId,
      })).rejects.toThrow(`HTTP ${missing.status}`);
    }));

    const agent = await registerAgent(service);
    const dispatched = await dispatch(ben, agent, [thread]);
    expect(dispatched.status).toBeGreaterThanOrEqual(400);
    expect(dispatched.status).toBeLessThan(500);

    // A service principal could never see what it created, so it cannot start one restricted.
    await expect(publishNew(server, as(service), {
      accessSetting: "restricted",
      content: "bot draft",
      idempotencyKey: "auth-031-service-restricted",
      name: "Bot draft",
    })).rejects.toThrow("HTTP 403");

    expect((await readArtifact(ada, shared.id)).accessSetting).toBe("restricted");
  });

  function administratorActor(): BrowserActor {
    return {cookies: administrator, id: "administrator"};
  }

  function as(actor: Actor): TestInstallation {
    return {...installation, apiToken: actor.token};
  }

  async function memberWithKey(displayName: string, email: string): Promise<Actor> {
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    return issueKey(memberId, `${displayName}'s key`);
  }

  async function issueKey(memberId: string | undefined, name: string): Promise<Actor> {
    const keyRequest: IssueKeyRequest = {
      capabilities: [...allCapabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    };
    const body: IssueKeyRequest = memberId === undefined
      ? keyRequest
      : {...keyRequest, memberId};
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(body),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const issued = issuedKeySchema.parse(await response.json());
    return {id: issued.apiKey.principalId, token: issued.token};
  }

  async function publishAs(
    actor: Actor,
    name: string,
    accessSetting: "account_required" | "restricted" = "account_required",
  ): Promise<z.infer<typeof artifactSchema>> {
    const published = await publishNew(server, as(actor), {
      accessSetting,
      content: name,
      idempotencyKey: `publish-${name}-${actor.id}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function readArtifact(actor: Caller, artifactId: string) {
    const response = await request(actor, "GET", artifactId);
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  async function listedNames(actor: Caller, search?: string): Promise<string[]> {
    const query = search === undefined ? "" : `?search=${encodeURIComponent(search)}`;
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts${query}`, {
      headers: headersFor(actor),
    });
    expect(response.status).toBe(200);
    return artifactPageSchema.parse(await response.json()).artifacts
      .map(({artifact}) => artifact.name);
  }

  async function commentOn(
    actor: Actor,
    artifactId: string,
    versionId: string,
  ): Promise<string> {
    const response = await mutate(
      actor,
      "POST",
      `${artifactId}/versions/${versionId}/comments`,
      {body: "Please check this."},
    );
    expect(response.status).toBe(201);
    return threadSchema.parse(await response.json()).thread.id;
  }

  async function registerAgent(actor: Actor): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/agents`, {
      body: JSON.stringify({
        displayName: "Test agent",
        kind: "pi",
        workingDirectory: "/tmp/agent",
      }),
      headers: headersFor(actor, {json: true}),
      method: "POST",
    });
    expect(response.status).toBeLessThan(300);
    return agentSchema.parse(await response.json()).agent.id;
  }

  function dispatch(
    actor: Actor,
    agentId: string,
    threadIds: readonly string[],
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/agent-dispatches`, {
      body: JSON.stringify({agentId, threadIds}),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method: "POST",
    });
  }

  function request(actor: Caller, method: string, artifactPath: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {
      headers: headersFor(actor),
      method,
    });
  }

  function mutate(
    actor: Caller,
    method: string,
    artifactPath: string,
    body: RequestBody,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {
      body: JSON.stringify(body),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method,
    });
  }

  function headersFor(
    actor: Caller,
    options: {readonly idempotent?: boolean; readonly json?: boolean} = {},
  ): Headers {
    const headers = "cookies" in actor
      ? new Headers({
        Cookie: actor.cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": actor.cookies.csrf,
      })
      : new Headers({Authorization: `Bearer ${actor.token}`});
    if (options.json === true) headers.set("Content-Type", "application/json");
    if (options.idempotent === true) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return headers;
  }

  function browserMutationHeaders(): Headers {
    return new Headers({
      "Content-Type": "application/json",
      Cookie: administrator.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": administrator.csrf,
    });
  }

  function openContentAccess(artifactId: string, principalId: string): number {
    const database = openDatabase();
    try {
      const count = z.object({total: z.number()});
      return ["content_sessions", "content_bootstraps"].reduce(
        (total, table) => total + count.parse(database.prepare(
          `SELECT COUNT(*) AS total FROM ${table}
           WHERE artifact_id = ? AND principal_id = ?`,
        ).get(artifactId, principalId)).total,
        0,
      );
    } finally {
      database.close();
    }
  }

  function openDatabase(): DatabaseSync {
    return new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
  }
});
