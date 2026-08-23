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
  canceledAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
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
}).loose();
const dispatchEnvelopeSchema = z.object({dispatch: dispatchSchema}).loose();
const dispatchCreationSchema = z.object({
  dispatch: dispatchSchema,
  replayed: z.boolean(),
}).loose();
const agentEnvelopeSchema = z.object({
  agent: z.object({id: z.string()}).loose(),
}).loose();
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const replyCreationSchema = z.object({
  reply: z.object({body: z.string(), id: z.string()}).loose(),
}).loose();
const threadDetailsSchema = z.object({
  replies: z.array(z.object({body: z.string(), id: z.string()}).loose()),
  thread: z.object({id: z.string(), state: z.string()}).loose(),
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

const unavailableStalenessMilliseconds = 15 * 60 * 1_000;

describe("agent dispatch thread release", () => {
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
      content: "<!doctype html><title>Release</title>",
      idempotencyKey: "dispatch-release-publish",
      name: "Release report",
    })).body;
    administratorCookies = await signInAdministrator();
    agentToken = await issueKey(["agent:connect"], "Release bridge");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-009-B: failure, cancellation, and an agent that stops polling each release their threads back into the default listings", async () => {
    expect.hasAssertions();
    const workingAgent = await registerAgent("release-working", "working pi");
    const failedThread = await openThread("The chart is upside down.", "fail");
    const failedReply = await replyToThread(failedThread, "Agreed.", "fail");
    const canceledThread = await openThread("The table is stale.", "cancel");
    const canceledReply = await replyToThread(canceledThread, "Noted.", "cancel");
    const abandonedThread = await openThread("The link is dead.", "stale");
    const abandonedReply = await replyToThread(abandonedThread, "Same here.", "stale");

    // Every send is consumptive first: nothing is listed by default.
    const failedDispatch = await send(
      workingAgent,
      [failedThread],
      "release-send-failed",
    );
    const canceledDispatch = await send(
      workingAgent,
      [canceledThread],
      "release-send-canceled",
    );
    expect(await listThreads()).toEqual([abandonedThread]);

    await claim(workingAgent, failedDispatch);
    clock.advance(1_000);
    const reported = await agentFetch(
      "POST",
      `/api/v1/agent-dispatches/${failedDispatch}/failed`,
      {body: {agentId: workingAgent, reason: "The workspace was deleted."}},
    );
    expect(reported.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await reported.json()).dispatch)
      .toMatchObject({
        failedAt: clock.iso(),
        failureReason: "The workspace was deleted.",
        state: "failed",
      });

    clock.advance(1_000);
    const canceled = await humanFetch(
      "POST",
      `/api/v1/agent-dispatches/${canceledDispatch}/cancel`,
    );
    expect(canceled.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await canceled.json()).dispatch)
      .toMatchObject({canceledAt: clock.iso(), state: "canceled"});

    // A third bundle waits for an agent that registered and never polled.
    const abandonedAgent = await registerAgent("release-abandoned", "quiet pi");
    const abandonedDispatch = await send(
      abandonedAgent,
      [abandonedThread],
      "release-send-abandoned",
    );
    expect(await listThreads()).toEqual(sorted([canceledThread, failedThread]));
    clock.advance(1_000);
    const releaseWatermark = clock.iso();
    clock.advance(unavailableStalenessMilliseconds + 1_000);
    const abandoned = await readDispatch(abandonedDispatch);
    expect(abandoned).toMatchObject({
      failedAt: clock.iso(),
      failureReason: "agent_unavailable",
      state: "failed",
    });

    // Every released thread is back on the default surface, replies intact.
    expect(await listThreads()).toEqual(sorted([
      abandonedThread,
      canceledThread,
      failedThread,
    ]));
    expect(await listThreads("only")).toEqual([]);
    const released = await Promise.all(
      [failedThread, canceledThread, abandonedThread].map(readThread),
    );
    expect(released.map((details) => ({
      replies: details.replies.map((reply) => reply.id),
      state: details.thread.state,
    }))).toEqual([
      {replies: [failedReply], state: "open"},
      {replies: [canceledReply], state: "open"},
      {replies: [abandonedReply], state: "open"},
    ]);

    // Releasing a marker is a thread edit, so an incremental poller resuming
    // from the time its previous pass started sees the thread come back and
    // does not have to re-list everything to notice.
    expect(await listThreads("exclude", releaseWatermark))
      .toEqual([abandonedThread]);
  });

  test("DSP-009-F: an addressed dispatch releases nothing and a held thread joins no second dispatch until it is released", async () => {
    expect.hasAssertions();
    const agentId = await registerAgent("release-holder", "holding pi");
    const addressedThread = await openThread("Redo the summary.", "addressed");
    const heldThread = await openThread("Redo the intro.", "held");
    const freeThread = await openThread("Redo the appendix.", "free");

    // An addressed bundle keeps its markers: the threads are resolved and
    // stay off the default surface.
    const addressedDispatch = await send(
      agentId,
      [addressedThread],
      "release-send-addressed",
    );
    await claim(agentId, addressedDispatch);
    clock.advance(1_000);
    expect((await agentFetch(
      "POST",
      `/api/v1/agent-dispatches/${addressedDispatch}/delivered`,
      {body: {agentId}},
    )).status).toBe(200);
    clock.advance(1_000);
    await setThreadState(addressedThread, "resolved");
    clock.advance(1_000);
    expect((await readDispatch(addressedDispatch)).state).toBe("addressed");
    expect(await listThreads()).toEqual(sorted([freeThread, heldThread]));
    expect(await listThreads("only")).toEqual([addressedThread]);
    expect(await listThreads("include"))
      .toEqual(sorted([addressedThread, freeThread, heldThread]));

    // A held thread cannot join a second bundle, and the rejected bundle
    // leaves its other thread completely unmarked.
    const heldDispatch = await send(
      agentId,
      [heldThread],
      "release-send-held",
    );
    clock.advance(1_000);
    const doubleBooked = await humanFetch("POST", "/api/v1/agent-dispatches", {
      body: {agentId, threadIds: [freeThread, heldThread]},
      key: "release-send-double-booked",
    });
    expect(doubleBooked.status).toBe(422);
    const doubleBookedFailure = failureSchema.parse(await doubleBooked.json());
    expect(doubleBookedFailure.error.code).toBe("INVALID_DISPATCH");
    expect(doubleBookedFailure.error.message).not.toContain(heldThread);
    expect(await listThreads()).toEqual([freeThread]);
    expect(await listThreads("only")).toEqual(sorted([addressedThread, heldThread]));

    // A canceled dispatch releases once: the repeat is a state conflict and
    // changes nothing on the comment surfaces.
    clock.advance(1_000);
    expect((await humanFetch(
      "POST",
      `/api/v1/agent-dispatches/${heldDispatch}/cancel`,
    )).status).toBe(200);
    expect(await listThreads()).toEqual(sorted([freeThread, heldThread]));
    clock.advance(1_000);
    const canceledTwice = await humanFetch(
      "POST",
      `/api/v1/agent-dispatches/${heldDispatch}/cancel`,
    );
    expect(canceledTwice.status).toBe(409);
    expect(failureSchema.parse(await canceledTwice.json()).error.code)
      .toBe("DISPATCH_STATE_CONFLICT");
    expect(await listThreads()).toEqual(sorted([freeThread, heldThread]));
    expect(await listThreads("only")).toEqual([addressedThread]);

    // Released means sendable again, and the marker returns with the send.
    const resent = await send(agentId, [heldThread], "release-send-again");
    expect(resent).not.toBe(heldDispatch);
    expect(await listThreads()).toEqual([freeThread]);
    expect(await listThreads("only")).toEqual(sorted([addressedThread, heldThread]));

    // Reopening a thread of an addressed bundle releases that one marker:
    // the annotation returns to the default listings and can be sent again,
    // while the addressed dispatch itself is left exactly as it was stamped.
    const stamped = await readDispatch(addressedDispatch);
    clock.advance(1_000);
    await setThreadState(addressedThread, "open");
    expect(await listThreads()).toEqual(sorted([addressedThread, freeThread]));
    expect(await listThreads("only")).toEqual([heldThread]);
    expect(await readDispatch(addressedDispatch)).toEqual(stamped);
    const resentAddressed = await send(
      agentId,
      [addressedThread],
      "release-send-reopened",
    );
    expect(resentAddressed).not.toBe(addressedDispatch);
    expect(await listThreads()).toEqual([freeThread]);
  });

  async function listThreads(
    dispatched: "exclude" | "include" | "only" = "exclude",
    since: string | null = null,
  ): Promise<readonly string[]> {
    const response = await humanFetch(
      "GET",
      `/api/v1/artifacts/${published.artifact.id}` +
        `/comments?dispatched=${dispatched}&limit=50` +
        (since === null ? "" : `&since=${encodeURIComponent(since)}`),
    );
    expect(response.status).toBe(200);
    const page = threadPageSchema.parse(await response.json());
    return page.items.map((item) => item.id).toSorted();
  }

  async function readThread(threadId: string) {
    const response = await humanFetch(
      "GET",
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`,
    );
    expect(response.status).toBe(200);
    return threadDetailsSchema.parse(await response.json());
  }

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
      {body: {body}, key: `dispatch-release-thread-${key}`},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function replyToThread(
    threadId: string,
    body: string,
    key: string,
  ): Promise<string> {
    clock.advance(1_000);
    const response = await humanFetch(
      "POST",
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies`,
      {body: {body}, key: `dispatch-release-reply-${key}`},
    );
    expect(response.status).toBe(201);
    return replyCreationSchema.parse(await response.json()).reply.id;
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

/** Compare listings by membership: the listing order is not the contract. */
function sorted(threadIds: readonly string[]): readonly string[] {
  return threadIds.toSorted();
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
