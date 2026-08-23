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

const dispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);
const dispatchSchema = z.object({
  addressedAt: z.iso.datetime().nullable(),
  agentId: z.string(),
  canceledAt: z.iso.datetime().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  state: dispatchStateSchema,
  threadIds: z.array(z.string()),
  updatedAt: z.iso.datetime(),
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
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}).loose(),
  token: z.string().startsWith("as_key_"),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const leaseMilliseconds = 5 * 60 * 1_000;

describe("agent dispatch state machine", () => {
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
      content: "<!doctype html><title>State machine</title>",
      idempotencyKey: "dispatch-state-machine-publish",
      name: "State machine report",
    })).body;
    administratorCookies = await signInAdministrator();
    agentToken = await issueKey(["agent:connect"], "State machine bridge");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-007-B: one dispatch walks queued, claimed, delivered, and addressed with its own stamp on every transition", async () => {
    expect.hasAssertions();
    const agentId = await registerAgent("state-machine-walk", "walking pi");
    const threadOne = await openThread("The heading is wrong.", "walk-one");
    const threadTwo = await openThread("The footer link 404s.", "walk-two");

    clock.advance(1_000);
    const created = dispatchCreationSchema.parse(await (await humanFetch(
      "POST",
      "/api/v1/agent-dispatches",
      {
        body: {agentId, note: "Please address both.", threadIds: [threadOne, threadTwo]},
        key: "dispatch-state-machine-send",
      },
    )).json());
    expect(created.replayed).toBe(false);
    expect(created.dispatch).toMatchObject({
      addressedAt: null,
      canceledAt: null,
      claimedAt: null,
      deliveredAt: null,
      failedAt: null,
      leaseExpiresAt: null,
      state: "queued",
      threadIds: [threadOne, threadTwo],
    });

    clock.advance(1_000);
    const claimResponse = await agentFetch(
      "POST",
      `/api/v1/agents/${agentId}/claims?wait=0`,
    );
    expect(claimResponse.status).toBe(200);
    const claimed = dispatchEnvelopeSchema.parse(await claimResponse.json())
      .dispatch;
    expect(claimed.id).toBe(created.dispatch.id);
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimedAt).toBe(clock.iso());
    expect(claimed.leaseExpiresAt)
      .toBe(clock.offsetIso(leaseMilliseconds));
    expect(claimed.deliveredAt).toBeNull();

    clock.advance(1_000);
    const deliveredResponse = await agentFetch(
      "POST",
      `/api/v1/agent-dispatches/${created.dispatch.id}/delivered`,
      {body: {agentId}},
    );
    expect(deliveredResponse.status).toBe(200);
    const delivered = dispatchEnvelopeSchema
      .parse(await deliveredResponse.json()).dispatch;
    expect(delivered.state).toBe("delivered");
    expect(delivered.deliveredAt).toBe(clock.iso());
    expect(delivered.claimedAt).toBe(claimed.claimedAt);
    expect(delivered.addressedAt).toBeNull();

    clock.advance(1_000);
    await resolveThread(threadOne);
    clock.advance(1_000);
    await resolveThread(threadTwo);
    clock.advance(1_000);
    const addressed = await readDispatch(created.dispatch.id);
    expect(addressed.state).toBe("addressed");
    expect(addressed.addressedAt).toBe(clock.iso());

    const stamps = [
      addressed.createdAt,
      addressed.claimedAt,
      addressed.deliveredAt,
      addressed.addressedAt,
    ].map((stamp) => Date.parse(stamp ?? ""));
    expect(stamps.every((stamp) => Number.isFinite(stamp))).toBe(true);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(stamps.toSorted((left, right) => left - right)).toEqual(stamps);
    expect(addressed).toMatchObject({
      canceledAt: null,
      failedAt: null,
      failureReason: null,
    });
  });

  test("DSP-007-F: every transition outside the machine is a state conflict that moves no recorded time", async () => {
    expect.hasAssertions();
    const holder = await registerAgent("state-machine-holder", "holding pi");
    const bystander = await registerAgent(
      "state-machine-bystander",
      "bystanding pi",
    );

    // A delivered dispatch that becomes addressed: neither state accepts a
    // second report, and neither accepts a cancel.
    const addressedThread = await openThread("Addressed work.", "conflict-one");
    const addressedDispatch = await send(
      holder,
      [addressedThread],
      "dispatch-conflict-addressed",
    );
    await claim(holder, addressedDispatch);
    await report(holder, addressedDispatch, "delivered");
    await expectConflicts(addressedDispatch, [
      {agentId: holder, kind: "delivered"},
      {agentId: holder, kind: "cancel"},
    ]);
    clock.advance(1_000);
    await resolveThread(addressedThread);
    clock.advance(1_000);
    expect((await readDispatch(addressedDispatch)).state).toBe("addressed");
    await expectConflicts(addressedDispatch, [
      {agentId: holder, kind: "delivered"},
      {agentId: holder, kind: "failed"},
      {agentId: holder, kind: "cancel"},
    ]);

    // A failed dispatch is terminal for the agent and for the human.
    const failedThread = await openThread("Failed work.", "conflict-two");
    const failedDispatch = await send(
      holder,
      [failedThread],
      "dispatch-conflict-failed",
    );
    await claim(holder, failedDispatch);
    await report(holder, failedDispatch, "failed");
    await expectConflicts(failedDispatch, [
      {agentId: holder, kind: "delivered"},
      {agentId: holder, kind: "failed"},
      {agentId: holder, kind: "cancel"},
    ]);

    // A claimed dispatch only answers its own holder.
    const heldThread = await openThread("Held work.", "conflict-three");
    const heldDispatch = await send(
      holder,
      [heldThread],
      "dispatch-conflict-held",
    );
    await claim(holder, heldDispatch);
    await expectConflicts(heldDispatch, [
      {agentId: bystander, kind: "delivered"},
      {agentId: bystander, kind: "failed"},
    ]);

    // A queued dispatch has nothing to report, and a canceled one is terminal.
    const queuedThread = await openThread("Queued work.", "conflict-four");
    const queuedDispatch = await send(
      holder,
      [queuedThread],
      "dispatch-conflict-queued",
    );
    await expectConflicts(queuedDispatch, [
      {agentId: holder, kind: "delivered"},
      {agentId: holder, kind: "failed"},
    ]);
    clock.advance(1_000);
    const canceled = dispatchEnvelopeSchema.parse(await (await humanFetch(
      "POST",
      `/api/v1/agent-dispatches/${queuedDispatch}/cancel`,
    )).json()).dispatch;
    expect(canceled.state).toBe("canceled");
    expect(canceled.canceledAt).toBe(clock.iso());
    await expectConflicts(queuedDispatch, [
      {agentId: holder, kind: "delivered"},
      {agentId: holder, kind: "failed"},
      {agentId: holder, kind: "cancel"},
    ]);
  });

  /**
   * Refuse a batch of illegal transitions against one dispatch and prove the
   * record is byte-identical afterwards, so a refusal can never restamp.
   */
  async function expectConflicts(
    dispatchId: string,
    attempts: readonly IllegalTransition[],
  ): Promise<void> {
    const before = await readDispatch(dispatchId);
    await refuseInOrder(dispatchId, attempts);
    expect(await readDispatch(dispatchId)).toEqual(before);
  }

  /** Attempt the illegal transitions one at a time, in the order given. */
  async function refuseInOrder(
    dispatchId: string,
    attempts: readonly IllegalTransition[],
  ): Promise<void> {
    const [attempt, ...remaining] = attempts;
    if (attempt === undefined) return;
    clock.advance(1_000);
    const response = attempt.kind === "cancel"
      ? await humanFetch(
        "POST",
        `/api/v1/agent-dispatches/${dispatchId}/cancel`,
      )
      : await agentFetch(
        "POST",
        `/api/v1/agent-dispatches/${dispatchId}/${attempt.kind}`,
        {
          body: attempt.kind === "failed"
            ? {agentId: attempt.agentId, reason: "An illegal report."}
            : {agentId: attempt.agentId},
        },
      );
    expect({
      attempt,
      failure: failureSchema.parse(await response.json()).error.code,
      status: response.status,
    }).toEqual({
      attempt,
      failure: "DISPATCH_STATE_CONFLICT",
      status: 409,
    });
    return refuseInOrder(dispatchId, remaining);
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
    const claimed = dispatchEnvelopeSchema.parse(await response.json()).dispatch;
    expect(claimed).toMatchObject({id: dispatchId, state: "claimed"});
  }

  async function report(
    agentId: string,
    dispatchId: string,
    kind: "delivered" | "failed",
  ): Promise<void> {
    clock.advance(1_000);
    const response = await agentFetch(
      "POST",
      `/api/v1/agent-dispatches/${dispatchId}/${kind}`,
      {
        body: kind === "failed"
          ? {agentId, reason: "The workspace was deleted."}
          : {agentId},
      },
    );
    expect(response.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await response.json()).dispatch.state)
      .toBe(kind);
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
      {body: {body}, key: `dispatch-state-machine-${key}`},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function resolveThread(threadId: string): Promise<void> {
    const response = await humanFetch(
      "PATCH",
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`,
      {body: {state: "resolved"}},
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

interface IllegalTransition {
  readonly agentId: string;
  readonly kind: "cancel" | "delivered" | "failed";
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

  offsetIso(milliseconds: number): string {
    return new Date(this.#milliseconds + milliseconds).toISOString();
  }
}
