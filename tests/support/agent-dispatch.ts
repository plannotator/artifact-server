import {z} from "zod";

import type {Clock} from "../../src/core/ports.js";
import {
  issueLocalBrowserLogin,
  type RunningTestServer,
  type TestInstallation,
} from "./runtime-harness.js";
import type {PublishResponse} from "./publishing.js";

/** Wire shape of one registered agent, exactly as the HTTP routes answer it. */
export const registeredAgentSchema = z.object({
  agentSessionId: z.string().nullable(),
  connectionKey: z.string(),
  createdAt: z.iso.datetime(),
  displayName: z.string(),
  id: z.string().startsWith("agt_"),
  kind: z.literal("pi"),
  lastSeenAt: z.iso.datetime(),
  principalId: z.string(),
  workingDirectory: z.string(),
}).strict();
export const agentRegistrationSchema = z.object({
  agent: registeredAgentSchema,
}).strict();
export const connectedAgentSchema = registeredAgentSchema.extend({
  connected: z.boolean(),
}).strict();
export const agentListSchema = z.object({
  items: z.array(connectedAgentSchema),
}).strict();

/** Wire shape of one dispatch record, exactly as the HTTP routes answer it. */
export const dispatchSchema = z.object({
  addressedAt: z.iso.datetime().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.iso.datetime().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  id: z.string().startsWith("dsp_"),
  idempotencyKey: z.string(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  sender: z.object({
    authorizedByPrincipalId: z.string().nullable(),
    displayName: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
  }).strict(),
  state: z.enum([
    "addressed",
    "canceled",
    "claimed",
    "delivered",
    "failed",
    "queued",
  ]),
  threadIds: z.array(z.string()),
  updatedAt: z.iso.datetime(),
}).strict();
export const dispatchEnvelopeSchema = z.object({dispatch: dispatchSchema})
  .strict();
export const dispatchCreationSchema = z.object({
  dispatch: dispatchSchema,
  replayed: z.boolean(),
}).strict();
export const dispatchPageSchema = z.object({
  items: z.array(dispatchSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const commentThreadSchema = z.object({
  body: z.string(),
  id: z.string(),
  projectId: z.string(),
  state: z.enum(["open", "resolved"]),
}).loose();
export const commentThreadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).loose();
export const commentThreadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).loose();
export const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).strict();
export const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}).loose(),
  token: z.string().startsWith("as_key_"),
}).loose();
export const projectSchema = z.object({
  project: z.object({id: z.string()}).loose(),
}).loose();

export type RegisteredAgent = z.infer<typeof registeredAgentSchema>;
export type Dispatch = z.infer<typeof dispatchSchema>;

/** A clock the test moves deliberately, so leases and staleness are exact. */
export class MutableClock implements Clock {
  #milliseconds: number;

  constructor(instant: string = new Date(
    Math.ceil(Date.now() / 1_000) * 1_000,
  ).toISOString()) {
    this.#milliseconds = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}

/** One bearer credential driving the real HTTP boundary. */
export class ApiClient {
  readonly #server: RunningTestServer;
  readonly #credential: string;

  constructor(server: RunningTestServer, credential: string) {
    this.#server = server;
    this.#credential = credential;
  }

  fetch(
    pathname: string,
    init: RequestInit & {readonly idempotencyKey?: string} = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#credential}`);
    headers.set("Content-Type", "application/json");
    if (init.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", init.idempotencyKey);
    }
    return fetch(`${this.#server.baseUrl}${pathname}`, {...init, headers});
  }

  /** Register or re-register one self-naming agent. */
  async registerAgent(body: {
    readonly agentSessionId?: string | null;
    readonly connectionKey: string;
    readonly displayName: string;
    readonly workingDirectory: string;
  }): Promise<RegisteredAgent> {
    const response = await this.fetch("/api/v1/agents", {
      body: JSON.stringify({...body, kind: "pi"}),
      method: "POST",
    });
    if (response.status !== 200) {
      throw new Error(
        `Agent registration answered ${response.status}: ${await response.text()}`,
      );
    }
    return agentRegistrationSchema.parse(await response.json()).agent;
  }

  listAgents(): Promise<Response> {
    return this.fetch("/api/v1/agents");
  }

  /** Poll one agent's claim route, optionally holding the request open. */
  claim(agentId: string, waitSeconds?: number): Promise<Response> {
    const query = waitSeconds === undefined ? "" : `?wait=${waitSeconds}`;
    return this.fetch(`/api/v1/agents/${agentId}/claims${query}`, {
      method: "POST",
    });
  }

  reportDelivered(dispatchId: string, agentId: string): Promise<Response> {
    return this.fetch(`/api/v1/agent-dispatches/${dispatchId}/delivered`, {
      body: JSON.stringify({agentId}),
      method: "POST",
    });
  }

  reportFailed(
    dispatchId: string,
    agentId: string,
    reason: string,
  ): Promise<Response> {
    return this.fetch(`/api/v1/agent-dispatches/${dispatchId}/failed`, {
      body: JSON.stringify({agentId, reason}),
      method: "POST",
    });
  }

  cancelDispatch(dispatchId: string, projectId: string): Promise<Response> {
    return this.fetch(
      `/api/v1/agent-dispatches/${dispatchId}/cancel?projectId=${projectId}`,
      {method: "POST"},
    );
  }

  sendDispatch(input: {
    readonly agentId: string;
    readonly idempotencyKey: string;
    readonly note?: string;
    readonly projectId: string;
    readonly threadIds: readonly string[];
  }): Promise<Response> {
    const body = input.note === undefined
      ? {agentId: input.agentId, threadIds: [...input.threadIds]}
      : {
        agentId: input.agentId,
        note: input.note,
        threadIds: [...input.threadIds],
      };
    return this.fetch(
      `/api/v1/agent-dispatches?projectId=${input.projectId}`,
      {
        body: JSON.stringify(body),
        idempotencyKey: input.idempotencyKey,
        method: "POST",
      },
    );
  }

  getDispatch(dispatchId: string, projectId: string): Promise<Response> {
    return this.fetch(
      `/api/v1/agent-dispatches/${dispatchId}?projectId=${projectId}`,
    );
  }

  listDispatches(projectId: string, query = ""): Promise<Response> {
    return this.fetch(
      `/api/v1/agent-dispatches?projectId=${projectId}${query}`,
    );
  }

  /** Open one comment thread on a published version. */
  async openThread(
    published: PublishResponse,
    body: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof commentThreadSchema>> {
    const response = await this.fetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments` +
        `?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({body, path: "index.html"}),
        idempotencyKey,
        method: "POST",
      },
    );
    if (response.status !== 201) {
      throw new Error(
        `Opening a comment thread answered ${response.status}: ${await response.text()}`,
      );
    }
    return commentThreadCreationSchema.parse(await response.json()).thread;
  }

  listThreads(
    published: PublishResponse,
    query = "",
  ): Promise<Response> {
    return this.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments` +
        `?projectId=${published.artifact.projectId}${query}`,
    );
  }

  async listThreadIds(
    published: PublishResponse,
    query = "",
  ): Promise<readonly string[]> {
    const response = await this.listThreads(published, query);
    if (response.status !== 200) {
      throw new Error(
        `Listing comment threads answered ${response.status}: ${await response.text()}`,
      );
    }
    return commentThreadPageSchema.parse(await response.json()).items
      .map((thread) => thread.id);
  }

  setThreadState(
    published: PublishResponse,
    threadId: string,
    state: "open" | "resolved",
  ): Promise<Response> {
    return this.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
        `?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({state}), method: "PATCH"},
    );
  }

  async createProject(name: string, idempotencyKey: string): Promise<string> {
    const response = await this.fetch("/api/v1/projects", {
      body: JSON.stringify({name}),
      idempotencyKey,
      method: "POST",
    });
    if (response.status !== 201) {
      throw new Error(
        `Creating a project answered ${response.status}: ${await response.text()}`,
      );
    }
    return projectSchema.parse(await response.json()).project.id;
  }
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** Sign the bootstrap administrator in and keep its browser cookies. */
export async function signInAdministrator(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<ApplicationCookies> {
  const localBrowserToken = await issueLocalBrowserLogin(server, installation);
  const login = await fetch(
    `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
    {redirect: "manual"},
  );
  if (login.status !== 303) {
    throw new Error(`The administrator login failed with ${login.status}.`);
  }
  const setCookies = login.headers.getSetCookie();
  const session = setCookies.find((value) =>
    value.startsWith("artifact_session=")
  );
  const csrf = setCookies.find((value) => value.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0] ?? "";
  const csrfPair = csrf.split(";", 1)[0] ?? "";
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

/** Issue one API key with an exact capability set, as an administrator does. */
export async function issueApiKey(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  capabilities: readonly string[],
  name: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    body: JSON.stringify({
      capabilities: [...capabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    }),
    headers: new Headers({
      "Content-Type": "application/json",
      Cookie: cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": cookies.csrf,
    }),
    method: "POST",
  });
  if (response.status !== 201) {
    throw new Error(
      `Issuing an API key answered ${response.status}: ${await response.text()}`,
    );
  }
  return issuedKeySchema.parse(await response.json()).token;
}

/** Read one page of comment threads the way the web application reads it. */
export async function browserThreadIds(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  published: PublishResponse,
  query = "",
): Promise<readonly string[]> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments` +
      `?projectId=${published.artifact.projectId}${query}`,
    {
      headers: new Headers({
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      }),
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `The browser comment listing answered ${response.status}: ${await response.text()}`,
    );
  }
  return commentThreadPageSchema.parse(await response.json()).items
    .map((thread) => thread.id);
}
