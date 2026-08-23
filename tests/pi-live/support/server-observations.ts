/**
 * Polling reads of the real Artifact Server used by the live-Pi suite. Every
 * assertion about what the bridge did lands here, on the HTTP boundary, rather
 * than on scraped terminal text.
 */

import {z} from "zod";

import {
  agentListSchema,
  type ApiClient,
  type Dispatch,
  dispatchEnvelopeSchema,
} from "../../support/agent-dispatch.js";
import type {PublishResponse} from "../../support/publishing.js";

const pollMilliseconds = 100;
const defaultWaitMilliseconds = 60_000;

/** One connected agent row as the picker would see it. */
export const connectedAgentRowSchema = z.object({
  agentSessionId: z.string().nullable(),
  connected: z.boolean(),
  displayName: z.string(),
  id: z.string(),
  workingDirectory: z.string(),
}).loose();
export type ConnectedAgentRow = z.infer<typeof connectedAgentRowSchema>;

/** One comment thread with its replies, as the human would read it. */
export const threadDetailsSchema = z.object({
  replies: z.array(z.object({body: z.string()}).loose()),
  thread: z.object({
    id: z.string(),
    state: z.enum(["open", "resolved"]),
  }).loose(),
}).loose();
export type ThreadDetails = z.infer<typeof threadDetailsSchema>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function listAgentRows(
  client: ApiClient,
): Promise<readonly ConnectedAgentRow[]> {
  const response = await client.listAgents();
  if (response.status !== 200) {
    throw new Error(`Listing agents answered ${response.status}.`);
  }
  return agentListSchema.parse(await response.json()).items.map((item) =>
    connectedAgentRowSchema.parse(item)
  );
}

/** Wait until exactly one agent has registered itself and is connected. */
export async function waitForConnectedAgent(
  client: ApiClient,
  timeoutMilliseconds = defaultWaitMilliseconds,
): Promise<ConnectedAgentRow> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await listAgentRows(client);
    const connected = rows.find((row) => row.connected);
    if (connected !== undefined) return connected;
    if (Date.now() > deadline) {
      throw new Error("No Pi session registered itself as a connected agent.");
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMilliseconds);
  }
}

/** Wait until the same connection has re-registered under a new Pi session. */
export async function waitForRegistrationChange(
  client: ApiClient,
  previous: ConnectedAgentRow,
  timeoutMilliseconds = defaultWaitMilliseconds,
): Promise<ConnectedAgentRow> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await listAgentRows(client);
    const rebound = rows.find((row) =>
      row.connected && row.agentSessionId !== previous.agentSessionId
    );
    if (rebound !== undefined) return rebound;
    if (Date.now() > deadline) {
      throw new Error(
        `Pi never re-registered; rows: ${JSON.stringify(rows)}`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMilliseconds);
  }
}

/** Read one dispatch, with the server's lazy transitions applied. */
export async function readDispatch(
  client: ApiClient,
  projectId: string,
  dispatchId: string,
): Promise<Dispatch> {
  const response = await client.getDispatch(dispatchId, projectId);
  if (response.status !== 200) {
    throw new Error(`Reading dispatch ${dispatchId} answered ${response.status}.`);
  }
  return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
}

/** Wait until one dispatch reaches any of the given states. */
export async function waitForDispatchState(
  client: ApiClient,
  projectId: string,
  dispatchId: string,
  states: readonly Dispatch["state"][],
  timeoutMilliseconds = defaultWaitMilliseconds,
): Promise<Dispatch> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const dispatch = await readDispatch(client, projectId, dispatchId);
    if (states.includes(dispatch.state)) return dispatch;
    if (Date.now() > deadline) {
      throw new Error(
        `Dispatch ${dispatchId} stayed ${dispatch.state}; expected ${
          states.join(" or ")
        }.`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMilliseconds);
  }
}

/** Read one comment thread together with its replies. */
export async function readThread(
  client: ApiClient,
  published: PublishResponse,
  threadId: string,
): Promise<ThreadDetails> {
  const response = await client.fetch(
    `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
      `?projectId=${published.artifact.projectId}`,
  );
  if (response.status !== 200) {
    throw new Error(`Reading thread ${threadId} answered ${response.status}.`);
  }
  return threadDetailsSchema.parse(await response.json());
}
