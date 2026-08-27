import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";
import {signInAdministrator} from "../support/agent-dispatch.js";

const issuedKeySchema = z.object({
  apiKey: z.object({
    authorizedByPrincipalId: z.string(),
    capabilities: z.array(z.string()),
    id: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
    rotatedFromId: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});

const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    authorizedByPrincipalId: z.string().nullable(),
    idempotencyKey: z.string(),
    principalId: z.string(),
  })),
});

describe("managed API-key rotation", () => {
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

  test("rotation preserves human and service attribution while replacing each credential", async () => {
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await readSessionPrincipalId(server, cookies.header);
    const memberId = await admitMember(server, cookies, {
      displayName: "Ada",
      email: "ada@example.test",
    });
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "rotation attribution",
      idempotencyKey: "auth-009-publish",
      name: "Rotation attribution",
    });

    const human = await issueKey(server, cookies, {
      memberId,
      name: "Ada's key",
    });
    const rotatedHuman = await rotateKey(server, cookies, human.apiKey.id);
    expect(rotatedHuman.apiKey).toMatchObject({
      authorizedByPrincipalId: human.apiKey.authorizedByPrincipalId,
      capabilities: human.apiKey.capabilities,
      principalId: memberId,
      principalKind: "human",
      rotatedFromId: human.apiKey.id,
    });
    expect(await artifactListStatus(server, human.token)).toBe(401);
    expect(await changeTags(server, rotatedHuman.token, published.body, {
      idempotencyKey: "auth-009-human-tags",
      tags: ["human-rotation"],
    })).toBe(200);

    const service = await issueKey(server, cookies, {name: "Release bot"});
    const rotatedService = await rotateKey(server, cookies, service.apiKey.id);
    expect(rotatedService.apiKey).toMatchObject({
      authorizedByPrincipalId: service.apiKey.authorizedByPrincipalId,
      capabilities: service.apiKey.capabilities,
      principalId: service.apiKey.principalId,
      principalKind: "service",
      rotatedFromId: service.apiKey.id,
    });
    expect(await artifactListStatus(server, service.token)).toBe(401);
    expect(await changeTags(server, rotatedService.token, published.body, {
      idempotencyKey: "auth-009-service-tags",
      tags: ["service-rotation"],
    })).toBe(200);

    const actions = await readActions(server, installation, published.body);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "change_tags",
        authorizedByPrincipalId: administratorId,
        idempotencyKey: "auth-009-human-tags",
        principalId: memberId,
      }),
      expect.objectContaining({
        action: "change_tags",
        authorizedByPrincipalId: administratorId,
        idempotencyKey: "auth-009-service-tags",
        principalId: service.apiKey.principalId,
      }),
    ]));
  });
});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

interface KeyInput {
  readonly memberId?: string;
  readonly name: string;
}

interface MemberInput {
  readonly displayName: string;
  readonly email: string;
}

interface TagChangeInput {
  readonly idempotencyKey: string;
  readonly tags: readonly string[];
}

function browserMutationHeaders(
  server: RunningTestServer,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function readSessionPrincipalId(
  server: RunningTestServer,
  cookie: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: cookie},
  });
  expect(response.status).toBe(200);
  return z.object({principal: z.object({id: z.string()})})
    .parse(await response.json()).principal.id;
}

async function admitMember(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  input: MemberInput,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    body: JSON.stringify(input),
    headers: browserMutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({member: z.object({id: z.string()})})
    .parse(await response.json()).member.id;
}

async function issueKey(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  input: KeyInput,
): Promise<z.infer<typeof issuedKeySchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    body: JSON.stringify({
      capabilities: ["artifact:manage:any"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...input,
    }),
    headers: browserMutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return issuedKeySchema.parse(await response.json());
}

async function rotateKey(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  keyId: string,
): Promise<z.infer<typeof issuedKeySchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
    {headers: browserMutationHeaders(server, cookies), method: "POST"},
  );
  expect(response.status).toBe(201);
  return issuedKeySchema.parse(await response.json());
}

function artifactListStatus(
  server: RunningTestServer,
  token: string,
): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

async function changeTags(
  server: RunningTestServer,
  token: string,
  published: Awaited<ReturnType<typeof publishNew>>["body"],
  input: TagChangeInput,
): Promise<number> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${encodeURIComponent(published.artifact.id)}/tags` +
      `?projectId=${encodeURIComponent(published.artifact.projectId)}`,
    {
      body: JSON.stringify({
        expectedCurrentVersionId: published.version.id,
        tags: input.tags,
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      method: "PATCH",
    },
  ).then((response) => response.status);
}

async function readActions(
  server: RunningTestServer,
  installation: TestInstallation,
  published: Awaited<ReturnType<typeof publishNew>>["body"],
): Promise<z.infer<typeof actionPageSchema>["actions"]> {
  const query = new URLSearchParams({
    limit: "100",
    projectId: published.artifact.projectId,
  });
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${encodeURIComponent(published.artifact.id)}/actions?${query}`,
    {headers: {Authorization: `Bearer ${installation.apiToken}`}},
  );
  expect(response.status).toBe(200);
  return actionPageSchema.parse(await response.json()).actions;
}
