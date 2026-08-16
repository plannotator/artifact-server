import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";

const memberSchema = z.object({member: z.object({id: z.string()})});
const keySchema = z.object({token: z.string().startsWith("as_key_")});
const mutationSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    ownerPrincipalId: z.string(),
  }),
  replayed: z.boolean(),
  version: z.object({id: z.string()}),
});
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    targetOwnerPrincipalId: z.string().nullable(),
  })),
});

describe("artifact ownership transfer", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ART-009-B ART-009-F: a human administrator transfers ownership atomically and owner-scoped authority follows", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Owned work</title>",
      idempotencyKey: "ownership-publish-source",
    });
    const cookies = await bootstrapAdministrator(server, installation);
    const firstMember = await admitMember(server, cookies, "First owner");
    const secondMember = await admitMember(server, cookies, "Second owner");
    const firstOwnerKey = await issueOwnerKey(server, cookies, firstMember);
    const secondOwnerKey = await issueOwnerKey(server, cookies, secondMember);

    const serviceTransfer = await transferOwner(
      server,
      bearerHeaders(installation.apiToken, "ownership-service-denied"),
      published.body.artifact.id,
      published.body.version.id,
      firstMember,
    );
    expect(serviceTransfer.status).toBe(403);

    const firstTransfer = await transferOwner(
      server,
      browserHeaders(server.baseUrl, cookies, "ownership-first-transfer"),
      published.body.artifact.id,
      published.body.version.id,
      firstMember,
    );
    expect(firstTransfer.status).toBe(200);
    expect(mutationSchema.parse(await firstTransfer.json())).toEqual({
      artifact: {
        currentVersionId: published.body.version.id,
        ownerPrincipalId: firstMember,
      },
      replayed: false,
      version: {id: published.body.version.id},
    });

    const replay = mutationSchema.parse(await (await transferOwner(
      server,
      browserHeaders(server.baseUrl, cookies, "ownership-first-transfer"),
      published.body.artifact.id,
      published.body.version.id,
      firstMember,
    )).json());
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.ownerPrincipalId).toBe(firstMember);

    expect(await replaceTags(
      server,
      firstOwnerKey,
      published.body.artifact.id,
      published.body.version.id,
      "ownership-first-owner-tags",
    )).toBe(200);

    expect((await transferOwner(
      server,
      browserHeaders(server.baseUrl, cookies, "ownership-second-transfer"),
      published.body.artifact.id,
      published.body.version.id,
      secondMember,
    )).status).toBe(200);

    expect(await replaceTags(
      server,
      firstOwnerKey,
      published.body.artifact.id,
      published.body.version.id,
      "ownership-former-owner-denied",
    )).toBe(403);
    expect(await replaceTags(
      server,
      secondOwnerKey,
      published.body.artifact.id,
      published.body.version.id,
      "ownership-current-owner-tags",
    )).toBe(200);

    const actions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/actions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(actions.status).toBe(200);
    const ownershipActions = actionPageSchema.parse(await actions.json()).actions
      .filter(({action}) => action === "change_owner");
    expect(ownershipActions.map(({targetOwnerPrincipalId}) =>
      targetOwnerPrincipalId)).toEqual([secondMember, firstMember]);
  });
});

interface BrowserCookies {
  readonly csrf: string;
  readonly header: string;
}

async function bootstrapAdministrator(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<BrowserCookies> {
  const response = await fetch(
    `${server.baseUrl}/auth/local?token=${installation.browserBootstrapToken}`,
    {redirect: "manual"},
  );
  expect(response.status).toBe(303);
  const session = response.headers.getSetCookie()
    .find((value) => value.startsWith("artifact_session="));
  const csrf = response.headers.getSetCookie()
    .find((value) => value.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("Local login did not issue application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("Local login issued malformed application cookies.");
  }
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

async function admitMember(
  server: RunningTestServer,
  cookies: BrowserCookies,
  displayName: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    body: JSON.stringify({
      displayName,
      email: `${displayName.toLowerCase().replaceAll(" ", "-")}@example.test`,
    }),
    headers: browserHeaders(server.baseUrl, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return memberSchema.parse(await response.json()).member.id;
}

async function issueOwnerKey(
  server: RunningTestServer,
  cookies: BrowserCookies,
  memberId: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    body: JSON.stringify({
      capabilities: ["artifact:manage:owned"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      memberId,
      name: `Owner key ${memberId}`,
    }),
    headers: browserHeaders(server.baseUrl, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return keySchema.parse(await response.json()).token;
}

function browserHeaders(
  origin: string,
  cookies: BrowserCookies,
  idempotencyKey?: string,
): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
  if (idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  return headers;
}

function bearerHeaders(token: string, idempotencyKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}

function transferOwner(
  server: RunningTestServer,
  headers: Headers,
  artifactId: string,
  expectedCurrentVersionId: string,
  targetOwnerPrincipalId: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/owner`, {
    body: JSON.stringify({expectedCurrentVersionId, targetOwnerPrincipalId}),
    headers,
    method: "POST",
  });
}

async function replaceTags(
  server: RunningTestServer,
  token: string,
  artifactId: string,
  expectedCurrentVersionId: string,
  idempotencyKey: string,
): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/tags`, {
    body: JSON.stringify({expectedCurrentVersionId, tags: ["owner-verified"]}),
    headers: bearerHeaders(token, idempotencyKey),
    method: "PATCH",
  }).then((response) => response.status);
}
