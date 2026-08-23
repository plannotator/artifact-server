import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {Clock} from "../../src/core/ports.js";
import {
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const dispatchSchema = z.object({
  addressedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  id: z.string(),
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
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const threadDetailsSchema = z.object({
  thread: z.object({id: z.string(), state: z.string()}).loose(),
}).loose();
const issuedKeySchema = z.object({
  token: z.string().startsWith("as_key_"),
}).loose();

describe("agent dispatch addressed inference", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;
  let administratorCookies: ApplicationCookies;
  let agentToken: string;

  beforeEach(async () => {
    clock = new MutableClock(
      new Date(Math.ceil(Date.now() / 1_000) * 1_000).toISOString(),
    );
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Addressed</title>",
      idempotencyKey: "dispatch-addressed-publish",
      name: "Addressed report",
    })).body;
    administratorCookies = await signInAdministrator();
    agentToken = await issueKey(["agent:connect"], "Addressed bridge");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-008-B: a delivered bundle becomes addressed once every thread resolves, stamped when the read first observes it", async () => {
    expect.hasAssertions();
    const agentId = await registerAgent("addressed-walk", "addressing pi");
    const first = await openThread("Fix the axis labels.", "b-one");
    const second = await openThread("Fix the legend.", "b-two");
    const dispatchId = await send(agentId, [first, second], "addressed-send-b");
    await claim(agentId, dispatchId);
    await reportDelivered(agentId, dispatchId);

    clock.advance(1_000);
    await resolveThread(first);
    expect((await readDispatch(dispatchId)).state).toBe("delivered");
    clock.advance(1_000);
    await resolveThread(second);

    // Resolution is the ground truth, and the read is what observes it: the
    // stamp records the observing read, not the resolving write.
    clock.advance(60_000);
    const observedAt = clock.iso();
    const addressed = await readDispatch(dispatchId);
    expect(addressed.state).toBe("addressed");
    expect(addressed.addressedAt).toBe(observedAt);

    // Stamped once: a later read repeats the first observation.
    clock.advance(60_000);
    const reread = await readDispatch(dispatchId);
    expect(reread.addressedAt).toBe(observedAt);
    expect(reread.updatedAt).toBe(addressed.updatedAt);

    // The listing read applies the same inference for a second bundle.
    const third = await openThread("Fix the caption.", "b-three");
    const listedDispatchId = await send(
      agentId,
      [third],
      "addressed-send-b-list",
    );
    await claim(agentId, listedDispatchId);
    await reportDelivered(agentId, listedDispatchId);
    clock.advance(1_000);
    await resolveThread(third);
    clock.advance(30_000);
    const listObservedAt = clock.iso();
    const page = dispatchPageSchema.parse(await (await humanFetch(
      "GET",
      "/api/v1/agent-dispatches?limit=50",
    )).json());
    expect(page.items.find((item) => item.id === listedDispatchId))
      .toMatchObject({addressedAt: listObservedAt, state: "addressed"});
    clock.advance(30_000);
    expect(await readDispatch(listedDispatchId)).toMatchObject({
      addressedAt: listObservedAt,
      state: "addressed",
    });
  });

  test("DSP-008-F: an unresolved thread holds the dispatch delivered, and reopening one afterwards neither undoes nor restamps addressed", async () => {
    expect.hasAssertions();
    const agentId = await registerAgent("addressed-partial", "partial pi");
    const first = await openThread("Rework the intro.", "f-one");
    const second = await openThread("Rework the summary.", "f-two");
    const third = await openThread("Rework the appendix.", "f-three");
    const dispatchId = await send(
      agentId,
      [first, second, third],
      "addressed-send-f",
    );
    await claim(agentId, dispatchId);

    // Nothing is inferred before delivery: only a delivered bundle addresses.
    clock.advance(1_000);
    await resolveThread(first);
    clock.advance(1_000);
    await resolveThread(second);
    clock.advance(1_000);
    await resolveThread(third);
    clock.advance(1_000);
    expect(await readDispatch(dispatchId)).toMatchObject({
      addressedAt: null,
      state: "claimed",
    });

    // Reopen one thread, report delivered, and confirm all-but-one holds.
    clock.advance(1_000);
    await reopenThread(third);
    await reportDelivered(agentId, dispatchId);
    clock.advance(1_000);
    expect(await readDispatch(dispatchId)).toMatchObject({
      addressedAt: null,
      state: "delivered",
    });
    const listedWhileDelivered = dispatchPageSchema.parse(await (await humanFetch(
      "GET",
      "/api/v1/agent-dispatches?limit=50",
    )).json());
    expect(listedWhileDelivered.items.find((item) => item.id === dispatchId))
      .toMatchObject({addressedAt: null, state: "delivered"});

    clock.advance(1_000);
    await resolveThread(third);
    clock.advance(1_000);
    const observedAt = clock.iso();
    const addressed = await readDispatch(dispatchId);
    expect(addressed).toMatchObject({addressedAt: observedAt, state: "addressed"});

    // Reopening after the stamp reverts nothing already recorded.
    clock.advance(1_000);
    await reopenThread(second);
    expect(threadDetailsSchema.parse(await (await humanFetch(
      "GET",
      `/api/v1/artifacts/${published.artifact.id}/comments/${second}`,
    )).json()).thread.state).toBe("open");
    clock.advance(1_000);
    expect(await readDispatch(dispatchId)).toEqual(addressed);
    const listedAfterReopen = dispatchPageSchema.parse(await (await humanFetch(
      "GET",
      "/api/v1/agent-dispatches?limit=50",
    )).json());
    expect(listedAfterReopen.items.find((item) => item.id === dispatchId))
      .toEqual(addressed);
  });

  async function send(
    agentId: string,
    threadIds: readonly string[],
    idempotencyKey: string,
  ): Promise<string> {
    clock.advance(1_000);
    const response = await humanFetch("POST", "/api/v1/agent-dispatches", {
      body: {agentId, threadIds},
      key: idempotencyKey,
    });
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }

  async function claim(agentId: string, dispatchId: string): Promise<void> {
    clock.advance(1_000);
    const response = await agentFetch(
      "POST",
      `/api/v1/agents/${agentId}/claims?wait=0`,
    );
    expect(response.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await response.json()).dispatch)
      .toMatchObject({id: dispatchId, state: "claimed"});
  }

  async function reportDelivered(
    agentId: string,
    dispatchId: string,
  ): Promise<void> {
    clock.advance(1_000);
    const response = await agentFetch(
      "POST",
      `/api/v1/agent-dispatches/${dispatchId}/delivered`,
      {body: {agentId}},
    );
    expect(response.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await response.json()).dispatch.state)
      .toBe("delivered");
  }

  async function readDispatch(dispatchId: string) {
    const response = await humanFetch(
      "GET",
      `/api/v1/agent-dispatches/${dispatchId}`,
    );
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
  }

  async function registerAgent(
    connectionKey: string,
    displayName: string,
  ): Promise<string> {
    const response = await agentFetch("POST", "/api/v1/agents", {
      body: {
        agentSessionId: `session-${connectionKey}`,
        connectionKey,
        displayName,
        kind: "pi",
        workingDirectory: `/tmp/${connectionKey}`,
      },
    });
    expect(response.status).toBe(200);
    return agentEnvelopeSchema.parse(await response.json()).agent.id;
  }

  async function openThread(body: string, key: string): Promise<string> {
    clock.advance(1_000);
    const response = await humanFetch(
      "POST",
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      {body: {body}, key: `dispatch-addressed-${key}`},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  function resolveThread(threadId: string): Promise<void> {
    return setThreadState(threadId, "resolved");
  }

  function reopenThread(threadId: string): Promise<void> {
    return setThreadState(threadId, "open");
  }

  async function setThreadState(
    threadId: string,
    state: "open" | "resolved",
  ): Promise<void> {
    const response = await humanFetch(
      "PATCH",
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`,
      {body: {state}},
    );
    expect(response.status).toBe(200);
  }

  function humanFetch(
    method: string,
    pathname: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return credentialFetch(installation.apiToken, method, pathname, options);
  }

  function agentFetch(
    method: string,
    pathname: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return credentialFetch(agentToken, method, pathname, options);
  }

  function credentialFetch(
    credential: string,
    method: string,
    pathname: string,
    options: RequestOptions,
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

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(instant: string) {
    this.#milliseconds = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  iso(): string {
    return this.now().toISOString();
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}
