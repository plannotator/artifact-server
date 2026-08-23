import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {
  apiHeaders,
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const memberCredential = "dispatch-authorization-admitted-member";
const fabricatedDispatchId = "dsp_00000000-0000-4000-8000-000000000000";
const fabricatedThreadId = "cmt_00000000-0000-4000-8000-000000000000";
const fabricatedAgentId = "agt_00000000-0000-4000-8000-000000000000";

const dispatchSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  projectId: z.string(),
  sender: z.object({
    displayName: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
  }).loose(),
  state: z.string(),
  threadIds: z.array(z.string()),
}).loose();
const dispatchEnvelopeSchema = z.object({dispatch: dispatchSchema}).loose();
const dispatchCreationSchema = z.object({
  dispatch: dispatchSchema,
  replayed: z.boolean(),
}).loose();
const dispatchPageSchema = z.object({
  items: z.array(dispatchSchema),
  nextCursor: z.string().nullable(),
}).loose();
const agentEnvelopeSchema = z.object({
  agent: z.object({id: z.string()}).loose(),
}).loose();
const agentPageSchema = z.object({
  items: z.array(z.object({connected: z.boolean(), id: z.string()}).loose()),
}).loose();
const projectSchema = z.object({
  project: z.object({id: z.string()}).loose(),
}).loose();
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const threadPageSchema = z.object({
  items: z.array(z.object({id: z.string()}).loose()),
  nextCursor: z.string().nullable(),
}).loose();
const issuedKeySchema = z.object({
  token: z.string().startsWith("as_key_"),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

describe("agent dispatch authorization", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;
  let administratorCookies: ApplicationCookies;
  let agentToken: string;
  let bridgeToken: string;
  let managerToken: string;
  let readerToken: string;
  let agentId: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: admittedMemberVerifier,
    });
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Authorization</title>",
      idempotencyKey: "dispatch-authorization-publish",
      name: "Authorization report",
    })).body;
    administratorCookies = await signInAdministrator();
    agentToken = await issueKey(
      [principalCapabilities.connectAgents],
      "Authorization bridge",
    );
    // The credential a real bridge holds: it connects, reads the annotations
    // it was sent, and answers them — and still may not send or cancel.
    bridgeToken = await issueKey(
      [
        principalCapabilities.connectAgents,
        principalCapabilities.readArtifacts,
        principalCapabilities.writeComments,
      ],
      "Authorization bridge credential",
    );
    managerToken = await issueKey(
      [principalCapabilities.manageAnyArtifact],
      "Authorization manager",
    );
    readerToken = await issueKey(
      [principalCapabilities.readArtifacts],
      "Authorization reader",
    );
    agentId = await registerAgent();
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-010-B: a human member and a manage-any key send and cancel while read authority lists and reads dispatches", async () => {
    expect.hasAssertions();
    const memberThread = await openThread("The member's annotation.", "member");
    const managerThread = await openThread("The manager's annotation.", "manager");

    const bySender = [
      {
        credential: memberCredential,
        expected: {displayName: "Priya Member", principalKind: "human"},
        key: "dispatch-authorization-send-member",
        threadId: memberThread,
      },
      {
        credential: managerToken,
        expected: {
          displayName: "Authorization manager",
          principalKind: "service",
        },
        key: "dispatch-authorization-send-manager",
        threadId: managerThread,
      },
    ];
    const sent = await sendInOrder(bySender);

    // Reading agents and dispatches needs only artifact read authority.
    const agents = await credentialFetch(readerToken, "GET", "/api/v1/agents");
    expect(agents.status).toBe(200);
    expect(agentPageSchema.parse(await agents.json()).items
      .map((item) => item.id)).toEqual([agentId]);
    const listed = await credentialFetch(
      readerToken,
      "GET",
      "/api/v1/agent-dispatches?limit=50",
    );
    expect(listed.status).toBe(200);
    expect(dispatchPageSchema.parse(await listed.json()).items
      .map((item) => item.id).toSorted()).toEqual([...sent].toSorted());
    const read = await Promise.all(sent.map(async (dispatchId) => {
      const response = await credentialFetch(
        readerToken,
        "GET",
        `/api/v1/agent-dispatches/${dispatchId}`,
      );
      return {
        id: dispatchEnvelopeSchema.parse(await response.json()).dispatch.id,
        status: response.status,
      };
    }));
    expect(read).toEqual(sent.map((dispatchId) => ({
      id: dispatchId,
      status: 200,
    })));

    // Both senders cancel, and each cancellation releases its own thread.
    const memberCancel = await credentialFetch(
      memberCredential,
      "POST",
      `/api/v1/agent-dispatches/${sent[0] ?? ""}/cancel`,
    );
    expect(memberCancel.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await memberCancel.json()).dispatch.state)
      .toBe("canceled");
    const managerCancel = await credentialFetch(
      managerToken,
      "POST",
      `/api/v1/agent-dispatches/${sent[1] ?? ""}/cancel`,
    );
    expect(managerCancel.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await managerCancel.json()).dispatch.state)
      .toBe("canceled");
    expect(await listThreads()).toEqual([memberThread, managerThread].toSorted());
  });

  test("a foreign agent-connect key cannot claim or report for an agent it did not register", async () => {
    expect.hasAssertions();
    // agentId was registered by agentToken; bridgeToken is a different
    // agent-connect principal. Acting as someone else's agent is refused
    // for the claim and both report surfaces, and changes nothing.
    const thread = await openThread("An annotation for the owner.", "owned");
    const created = dispatchCreationSchema.parse(await (await credentialFetch(
      memberCredential,
      "POST",
      "/api/v1/agent-dispatches",
      {
        body: {agentId, threadIds: [thread]},
        key: "dispatch-authorization-foreign-agent-send",
      },
    )).json());

    const foreignClaim = await credentialFetch(
      bridgeToken,
      "POST",
      `/api/v1/agents/${agentId}/claims?wait=0`,
    );
    expect(foreignClaim.status).toBe(403);

    const ownClaim = await credentialFetch(
      agentToken,
      "POST",
      `/api/v1/agents/${agentId}/claims?wait=0`,
    );
    expect(ownClaim.status).toBe(200);

    const foreignDelivered = await credentialFetch(
      bridgeToken,
      "POST",
      `/api/v1/agent-dispatches/${created.dispatch.id}/delivered`,
      {body: {agentId}},
    );
    expect(foreignDelivered.status).toBe(403);

    const foreignFailed = await credentialFetch(
      bridgeToken,
      "POST",
      `/api/v1/agent-dispatches/${created.dispatch.id}/failed`,
      {body: {agentId, reason: "not yours"}},
    );
    expect(foreignFailed.status).toBe(403);

    const ownDelivery = await credentialFetch(
      agentToken,
      "POST",
      `/api/v1/agent-dispatches/${created.dispatch.id}/delivered`,
      {body: {agentId}},
    );
    expect(ownDelivery.status).toBe(200);
  });

  test("DSP-010-F: an agent-connect key can neither send nor cancel, and identifiers from another project or installation are not found without disclosure", async () => {
    expect.hasAssertions();
    const thread = await openThread("An annotation to protect.", "protected");
    const dispatchId = dispatchCreationSchema.parse(await (await credentialFetch(
      memberCredential,
      "POST",
      "/api/v1/agent-dispatches",
      {
        body: {agentId, threadIds: [thread]},
        key: "dispatch-authorization-protected-send",
      },
    )).json()).dispatch.id;

    const otherThread = await openThread("A second annotation.", "second");
    await refuseSenders(dispatchId, otherThread, [
      {credential: agentToken, label: "agent-connect"},
      {credential: bridgeToken, label: "bridge"},
      {credential: readerToken, label: "read-only"},
    ]);
    // The refused sends marked nothing and the refused cancels released
    // nothing: the dispatched thread is still held, the other still free.
    expect(await listThreads()).toEqual([otherThread]);
    expect(await listThreads("only")).toEqual([thread]);

    // A dispatch presented under another project is not found, and the answer
    // is indistinguishable from one for an identifier that never existed.
    const supportProjectId = await createProject("Support");
    const supportArtifact = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Support</title>",
      idempotencyKey: "dispatch-authorization-support-publish",
      name: "Support report",
      projectId: supportProjectId,
    })).body;
    const foreignDispatchRead = await failureFor(
      "GET",
      `/api/v1/agent-dispatches/${dispatchId}?projectId=${supportProjectId}`,
    );
    const absentDispatchRead = await failureFor(
      "GET",
      `/api/v1/agent-dispatches/${fabricatedDispatchId}?projectId=${supportProjectId}`,
    );
    expect(foreignDispatchRead).toEqual(absentDispatchRead);
    expect(foreignDispatchRead).toMatchObject({
      failure: {error: {code: "DISPATCH_NOT_FOUND"}},
      status: 404,
    });
    expect(foreignDispatchRead.failure.error.message).not.toContain(dispatchId);
    const foreignDispatchCancel = await failureFor(
      "POST",
      `/api/v1/agent-dispatches/${dispatchId}/cancel?projectId=${supportProjectId}`,
    );
    expect(foreignDispatchCancel)
      .toEqual(await failureFor(
        "POST",
        `/api/v1/agent-dispatches/${fabricatedDispatchId}/cancel?projectId=${supportProjectId}`,
      ));
    expect(foreignDispatchCancel.status).toBe(404);

    // An agent registered in another installation is as unknown as one that
    // was never registered at all.
    const otherInstallation = await createTestInstallation();
    const otherServer = await startTestServer(otherInstallation);
    try {
      const foreignAgentResponse = await fetch(
        `${otherServer.baseUrl}/api/v1/agents`,
        {
          body: JSON.stringify({
            agentSessionId: "foreign-session",
            connectionKey: "dispatch-authorization-foreign",
            displayName: "foreign pi",
            kind: "pi",
            workingDirectory: "/tmp/foreign",
          }),
          headers: {
            Authorization: `Bearer ${otherInstallation.apiToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      expect(foreignAgentResponse.status).toBe(200);
      const foreignAgentId = agentEnvelopeSchema
        .parse(await foreignAgentResponse.json()).agent.id;
      const foreignAgentSend = await failureFor(
        "POST",
        `/api/v1/agent-dispatches?projectId=${published.artifact.projectId}`,
        {
          body: {agentId: foreignAgentId, threadIds: [otherThread]},
          key: "dispatch-authorization-foreign-agent",
        },
      );
      expect(foreignAgentSend).toEqual(await failureFor(
        "POST",
        `/api/v1/agent-dispatches?projectId=${published.artifact.projectId}`,
        {
          body: {agentId: fabricatedAgentId, threadIds: [otherThread]},
          key: "dispatch-authorization-absent-agent",
        },
      ));
      expect(foreignAgentSend).toMatchObject({
        failure: {error: {code: "AGENT_NOT_FOUND"}},
        status: 404,
      });
      expect(foreignAgentSend.failure.error.message).not.toContain(foreignAgentId);
    } finally {
      await otherServer.stop();
      await removeTestInstallation(otherInstallation);
    }

    // A thread from another project is refused exactly like one that does not
    // exist, so a send cannot probe another project's identifiers.
    const supportThread = await openThreadOn(
      supportArtifact,
      supportProjectId,
      "A support annotation.",
      "support",
    );
    const crossProjectThread = await failureFor(
      "POST",
      `/api/v1/agent-dispatches?projectId=${supportProjectId}`,
      {
        body: {agentId, threadIds: [otherThread]},
        key: "dispatch-authorization-cross-thread",
      },
    );
    expect(crossProjectThread).toEqual(await failureFor(
      "POST",
      `/api/v1/agent-dispatches?projectId=${supportProjectId}`,
      {
        body: {agentId, threadIds: [fabricatedThreadId]},
        key: "dispatch-authorization-absent-thread",
      },
    ));
    expect(crossProjectThread).toMatchObject({
      failure: {error: {code: "INVALID_DISPATCH"}},
      status: 422,
    });
    expect(crossProjectThread.failure.error.message).not.toContain(otherThread);
    expect(await listThreads()).toEqual([otherThread]);
    expect(await listThreadsOn(supportArtifact, supportProjectId))
      .toEqual([supportThread]);
  });

  /** Send one bundle per sender, in order, and collect the dispatch ids. */
  async function sendInOrder(
    senders: readonly DispatchSender[],
    sent: readonly string[] = [],
  ): Promise<readonly string[]> {
    const [sender, ...remaining] = senders;
    if (sender === undefined) return sent;
    const response = await credentialFetch(
      sender.credential,
      "POST",
      "/api/v1/agent-dispatches",
      {body: {agentId, threadIds: [sender.threadId]}, key: sender.key},
    );
    expect(response.status).toBe(201);
    const created = dispatchCreationSchema.parse(await response.json());
    expect(created.dispatch.sender).toMatchObject(sender.expected);
    expect(created.dispatch.threadIds).toEqual([sender.threadId]);
    return sendInOrder(remaining, [...sent, created.dispatch.id]);
  }

  /** Refuse a send and a cancel for each credential, one credential at a time. */
  async function refuseSenders(
    dispatchId: string,
    threadId: string,
    denied: readonly DeniedCredential[],
  ): Promise<void> {
    const [entry, ...remaining] = denied;
    if (entry === undefined) return;
    const send = await credentialFetch(
      entry.credential,
      "POST",
      "/api/v1/agent-dispatches",
      {
        body: {agentId, threadIds: [threadId]},
        key: `dispatch-authorization-denied-${entry.label}`,
      },
    );
    expect({
      code: failureSchema.parse(await send.json()).error.code,
      label: entry.label,
      status: send.status,
    }).toEqual({
      code: "AUTHORIZATION_DENIED",
      label: entry.label,
      status: 403,
    });
    const cancel = await credentialFetch(
      entry.credential,
      "POST",
      `/api/v1/agent-dispatches/${dispatchId}/cancel`,
    );
    expect({
      code: failureSchema.parse(await cancel.json()).error.code,
      label: entry.label,
      status: cancel.status,
    }).toEqual({
      code: "AUTHORIZATION_DENIED",
      label: entry.label,
      status: 403,
    });
    return refuseSenders(dispatchId, threadId, remaining);
  }

  async function failureFor(
    method: string,
    pathname: string,
    options: RequestOptions = {},
  ): Promise<{
    readonly failure: z.infer<typeof failureSchema>;
    readonly status: number;
  }> {
    const response = await credentialFetch(
      memberCredential,
      method,
      pathname,
      options,
    );
    return {
      failure: failureSchema.parse(await response.json()),
      status: response.status,
    };
  }

  function listThreads(
    dispatched: "exclude" | "include" | "only" = "exclude",
  ): Promise<readonly string[]> {
    return listThreadsOn(published, published.artifact.projectId, dispatched);
  }

  async function listThreadsOn(
    artifact: PublishResponse,
    projectId: string | null,
    dispatched: "exclude" | "include" | "only" = "exclude",
  ): Promise<readonly string[]> {
    const query = new URLSearchParams({dispatched, limit: "50"});
    if (projectId !== null) query.set("projectId", projectId);
    const response = await credentialFetch(
      installation.apiToken,
      "GET",
      `/api/v1/artifacts/${artifact.artifact.id}/comments?${query.toString()}`,
    );
    expect(response.status).toBe(200);
    return threadPageSchema.parse(await response.json()).items
      .map((item) => item.id).toSorted();
  }

  async function createProject(name: string): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name}),
      headers: apiHeaders(installation, `dispatch-authorization-${name}`),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return projectSchema.parse(await response.json()).project.id;
  }

  async function registerAgent(): Promise<string> {
    const response = await credentialFetch(
      agentToken,
      "POST",
      "/api/v1/agents",
      {
        body: {
          agentSessionId: "authorization-session",
          connectionKey: "dispatch-authorization-agent",
          displayName: "authorized pi",
          kind: "pi",
          workingDirectory: "/tmp/dispatch-authorization",
        },
      },
    );
    expect(response.status).toBe(200);
    return agentEnvelopeSchema.parse(await response.json()).agent.id;
  }

  function openThread(body: string, key: string): Promise<string> {
    return openThreadOn(published, published.artifact.projectId, body, key);
  }

  async function openThreadOn(
    artifact: PublishResponse,
    projectId: string | null,
    body: string,
    key: string,
  ): Promise<string> {
    const query = projectId === null ? "" : `?projectId=${projectId}`;
    const response = await credentialFetch(
      installation.apiToken,
      "POST",
      `/api/v1/artifacts/${artifact.artifact.id}` +
        `/versions/${artifact.version.id}/comments${query}`,
      {body: {body}, key: `dispatch-authorization-thread-${key}`},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  function credentialFetch(
    credential: string,
    method: string,
    pathname: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    });
    if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
    const init: RequestInit = options.body === undefined
      ? {headers, method}
      : {body: JSON.stringify(options.body), headers, method};
    return fetch(`${server.baseUrl}${pathname}`, init);
  }

  async function signInAdministrator(): Promise<ApplicationCookies> {
    const localBrowserToken = await issueLocalBrowserLogin(server, installation);
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    );
    if (login.status !== 303) {
      throw new Error(`The administrator login failed with ${login.status}.`);
    }
    return applicationCookies(login.headers.getSetCookie());
  }

  async function issueKey(
    capabilities: readonly string[],
    name: string,
  ): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        name,
      }),
      headers: browserMutationHeaders(server.baseUrl, administratorCookies),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }
});

interface DispatchSender {
  readonly credential: string;
  readonly expected: {
    readonly displayName: string;
    readonly principalKind: string;
  };
  readonly key: string;
  readonly threadId: string;
}

interface DeniedCredential {
  readonly credential: string;
  readonly label: string;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly key?: string;
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

function applicationCookies(
  setCookieHeaders: readonly string[],
): ApplicationCookies {
  const session = setCookieHeaders.find((value) =>
    value.startsWith("artifact_session=")
  );
  const csrf = setCookieHeaders.find((value) =>
    value.startsWith("artifact_csrf=")
  );
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response issued a malformed application cookie.");
  }
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

const admittedMemberPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Priya Member",
  id: "member_dispatch_authorization",
  installationId: "local",
  kind: principalKinds.human,
  membershipRole: membershipRoles.member,
};

const admittedMemberVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === memberCredential
      ? Effect.succeed(admittedMemberPrincipal)
      : Effect.fail(new AuthenticationRequired({
        message: "The dispatch authorization credential is invalid.",
      })),
};
