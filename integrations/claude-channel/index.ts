/**
 * Artifact Server bridge as a Claude Code channel.
 *
 * Claude Code spawns this process over stdio when the channel is registered
 * and opted in. It runs the same claim loop as the Pi bridge (the long poll
 * is the heartbeat, so presence is real), and each claimed bundle is pushed
 * into the session as a `notifications/claude/channel` event. Claude replies
 * to and resolves each thread through the `artifact_comments` tool this
 * server exposes.
 *
 * Evidence tier: `channel` — the bridge reports `delivered` once the
 * notification is written to the transport, which proves admission to the
 * session, not model processing (spec section 4.3).
 */

import {homedir, hostname} from "node:os";
import process from "node:process";

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";

import {
  ActivityBeacon,
  type BridgeHandle,
  chooseDisplayName,
  type CommentOperations,
  createCommentOperations,
  type EnvironmentConfiguration,
  resolveBridgeCredentials,
  startBridge,
  ThreadLocationCache,
} from "@plannotator/agent-bridge";

const channelName = "artifact-server";

function environmentConfiguration(): EnvironmentConfiguration {
  return {
    agentDisplayName: process.env["ARTIFACT_SERVER_AGENT_NAME"],
    agentToken: process.env["ARTIFACT_SERVER_AGENT_TOKEN"],
    origin: process.env["ARTIFACT_SERVER_ORIGIN"],
  };
}

const artifactCommentsInputSchema = {
  properties: {
    body: {
      description: "Reply text (reply operation only).",
      type: "string",
    },
    operation: {
      description:
        "get_bundle reads threads with their replies; reply posts one " +
        "reply; resolve closes one thread.",
      enum: ["get_bundle", "reply", "resolve"],
      type: "string",
    },
    threadId: {
      description: "Target thread id (reply and resolve operations).",
      type: "string",
    },
    threadIds: {
      description: "Thread ids to read (get_bundle operation).",
      items: {type: "string"},
      type: "array",
    },
  },
  required: ["operation"],
  type: "object",
} as const;

const artifactCommentsArgumentsSchema = z.object({
  body: z.string().optional(),
  operation: z.enum(["get_bundle", "reply", "resolve"]),
  threadId: z.string().optional(),
  threadIds: z.array(z.string()).optional(),
});

type ArtifactCommentsArguments = z.infer<typeof artifactCommentsArgumentsSchema>;

function textContent(text: string) {
  return {content: [{text, type: "text" as const}]};
}

async function runArtifactComments(
  operations: CommentOperations | null,
  parameters: ArtifactCommentsArguments,
) {
  if (operations === null) {
    throw new Error("Artifact Server is not configured; the bridge is dormant.");
  }
  if (parameters.operation === "get_bundle") {
    const threadIds = parameters.threadIds ?? [];
    if (threadIds.length === 0) throw new Error("get_bundle requires threadIds.");
    const details = [];
    for (const threadId of threadIds) {
      // eslint-disable-next-line no-await-in-loop
      details.push(await operations.getThread(threadId));
    }
    return textContent(JSON.stringify(details, null, 2));
  }
  const threadId = parameters.threadId ?? "";
  if (threadId === "") throw new Error(`${parameters.operation} requires threadId.`);
  if (parameters.operation === "reply") {
    const body = parameters.body ?? "";
    if (body.trim() === "") throw new Error("reply requires a non-empty body.");
    await operations.reply(threadId, body);
    return textContent(`Replied to ${threadId}.`);
  }
  await operations.resolve(threadId);
  return textContent(`Resolved ${threadId}.`);
}

async function main(): Promise<void> {
  const mcp = new Server(
    {name: channelName, version: "0.0.0"},
    {
      capabilities: {
        experimental: {"claude/channel": {}},
        tools: {},
      },
      instructions:
        "Artifact Server review bundles arrive as " +
        '<channel source="artifact-server"> events listing comment threads ' +
        "with their ids. Do the work each thread asks for, then use the " +
        "artifact_comments tool: reply on each thread with what you did, " +
        "then resolve it. get_bundle rereads threads when you need the " +
        "full context.",
    },
  );

  const locations = new ThreadLocationCache();
  const beacon = new ActivityBeacon();
  const environment = environmentConfiguration();
  const credentials = await resolveBridgeCredentials(environment, homedir());
  const comments = credentials === null
    ? null
    : createCommentOperations(credentials, fetch, locations, beacon);

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      description:
        "Read, reply to, and resolve Artifact Server comment threads that " +
        "were sent to this session. Use get_bundle to read threads, reply " +
        "to record what you did on a thread, and resolve to close it when " +
        "done.",
      inputSchema: artifactCommentsInputSchema,
      name: "artifact_comments",
    }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "artifact_comments") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    return runArtifactComments(
      comments,
      artifactCommentsArgumentsSchema.parse(request.params.arguments ?? {}),
    );
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  let bridge: BridgeHandle | null = null;
  bridge = startBridge({
    agentSessionId: null,
    beacon,
    capabilities: {beacon: true, evidence: "channel"},
    credentials,
    displayName: chooseDisplayName(environment, process.cwd()),
    fetchImplementation: fetch,
    host: {
      // No compaction signal exists on this side of the stdio boundary;
      // Claude Code itself queues channel events while the session is busy.
      isCompacting: () => false,
      notify: (message) => {
        // A channel has no user-facing notice surface; stderr reaches the
        // channel log without entering the protocol stream on stdout.
        process.stderr.write(`${message}\n`);
      },
      sendUserMessage: (text) => {
        // Written to the transport fire-and-forget: resolution proves
        // admission, not processing, which is this tier's evidence bound. A
        // synchronous throw (transport gone) ends the claim loop fail-open.
        void mcp
          .notification({
            method: "notifications/claude/channel",
            params: {
              content: text,
              meta: {channel_kind: "artifact_server_dispatch"},
            },
          })
          .catch(() => {
            process.stderr.write("Channel notification failed.\n");
          });
      },
    },
    hostname: hostname(),
    kind: "claude",
    locations,
    log: (message) => {
      process.stderr.write(`${message}\n`);
    },
    workingDirectory: process.cwd(),
  });

  const stop = (): void => {
    const active = bridge;
    bridge = null;
    if (active !== null) {
      void active.stop({disconnect: true}).finally(() => {
        process.exit(0);
      });
    }
  };
  // The SDK transport exposes a single onclose property, not an event target.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = stop;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Channel failed to start: ${String(error)}\n`);
    process.exit(1);
  }
})();
