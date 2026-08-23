/**
 * A scripted, offline model endpoint for the live-Pi suite.
 *
 * The suite drives a REAL `pi` process, which needs a model to run. Instead of
 * a paid provider, this module serves the OpenAI Chat Completions streaming
 * shape from loopback and answers every turn from a planner the test owns.
 * That makes the model deterministic and — more useful — makes it the suite's
 * observation window: every request carries Pi's whole conversation, so a test
 * can prove exactly when the bridge's bundle message entered Pi's context.
 */

import {createServer, type Server} from "node:http";

import {z} from "zod";

/** One text or tool-call message as Pi sent it to the model. */
export interface ModelMessage {
  readonly role: string;
  readonly text: string;
}

/** One completion request: Pi's whole conversation at that moment. */
export interface ModelTurn {
  /** 1-based position in the request sequence. */
  readonly index: number;
  readonly messages: readonly ModelMessage[];
}

/** One tool call the scripted model asks Pi to run. */
export interface ScriptedToolCall {
  readonly arguments: Readonly<Record<string, string | readonly string[]>>;
  readonly name: string;
}

/** What the scripted model answers for one turn. */
export type ScriptedReply =
  | {readonly kind: "text"; readonly text: string}
  | {readonly kind: "toolCalls"; readonly toolCalls: readonly ScriptedToolCall[]};

/**
 * Answers one turn. The planner may await anything before replying; the
 * response stream stays open until it resolves, which is how a test holds Pi
 * inside a single unit of work while it sends a bundle.
 */
export type ModelPlanner = (turn: ModelTurn) => Promise<ScriptedReply>;

/** The running scripted model. */
export interface ScriptedModel {
  /** Base URL for a `models.json` provider entry. */
  readonly baseUrl: string;
  stop(): Promise<void>;
  /** Every completion request the live Pi process has made, in order. */
  turns(): readonly ModelTurn[];
  /** Resolve once at least `count` requests have arrived. */
  waitForTurns(count: number, timeoutMilliseconds?: number): Promise<void>;
}

/** Chat Completions content is either one string or an array of text parts. */
const messageContentSchema = z.union([
  z.string(),
  z.array(z.object({text: z.string().optional()}).loose())
    .transform((parts) => parts.map((part) => part.text ?? "").join("")),
]);
const messageSchema = z.object({
  content: messageContentSchema.nullish().transform((content) => content ?? ""),
  role: z.string(),
}).loose();
const completionRequestSchema = z.object({
  messages: z.array(messageSchema),
  model: z.string(),
}).loose();

/** One streamed tool call, in the wire shape the OpenAI client expects. */
interface ToolCallDelta {
  readonly function: {readonly arguments: string; readonly name: string};
  readonly id: string;
  readonly index: number;
  readonly type: "function";
}

/** One streamed delta of an assistant message. */
interface CompletionDelta {
  readonly content?: string;
  readonly role?: string;
  readonly tool_calls?: readonly ToolCallDelta[];
}

/** One `chat.completion.chunk` server-sent event payload. */
interface CompletionChunk {
  readonly choices: readonly {
    readonly delta: CompletionDelta;
    readonly finish_reason: string | null;
    readonly index: number;
  }[];
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly object: "chat.completion.chunk";
}

const defaultWaitMilliseconds = 60_000;
const pollMilliseconds = 25;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Every user message the bridge rendered, newest last. */
export function bundleMessages(turn: ModelTurn): readonly string[] {
  return turn.messages
    .filter((message) =>
      message.role === "user" && message.text.startsWith("Artifact Server:")
    )
    .map((message) => message.text);
}

/** The last user message of one turn, or the empty string when there is none. */
export function latestUserMessage(turn: ModelTurn): string {
  const userMessages = turn.messages.filter(
    (message) => message.role === "user",
  );
  return userMessages.at(-1)?.text ?? "";
}

/** Start the scripted model on a free loopback port. */
export async function startScriptedModel(
  planner: ModelPlanner,
): Promise<ScriptedModel> {
  const turns: ModelTurn[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = [];
        request.on("data", (chunk: Buffer) => parts.push(chunk));
        request.on("end", () => {
          resolve(Buffer.concat(parts).toString("utf8"));
        });
        request.on("error", reject);
      });
      const parsed = completionRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        response.writeHead(400, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: {message: "unscripted request"}}));
        return;
      }
      const turn: ModelTurn = {
        index: turns.length + 1,
        messages: parsed.data.messages.map((message) => ({
          role: message.role,
          text: message.content,
        })),
      };
      turns.push(turn);

      const identifier = `chatcmpl-${turn.index}`;
      const model = parsed.data.model;
      const write = (payload: CompletionChunk): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const chunk = (
        delta: CompletionDelta,
        finishReason: string | null,
      ): CompletionChunk => ({
        choices: [{delta, finish_reason: finishReason, index: 0}],
        created: Math.floor(Date.now() / 1_000),
        id: identifier,
        model,
        object: "chat.completion.chunk",
      });

      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      // The opening chunk lands before the planner is consulted, so Pi is
      // already streaming this turn while a test decides how it ends.
      write(chunk({content: "", role: "assistant"}, null));

      const reply = await planner(turn);
      if (reply.kind === "text") {
        write(chunk({content: reply.text}, null));
        write(chunk({}, "stop"));
      } else {
        reply.toolCalls.forEach((call, position) => {
          write(chunk({
            tool_calls: [{
              function: {
                arguments: JSON.stringify(call.arguments),
                name: call.name,
              },
              id: `call-${turn.index}-${position + 1}`,
              index: position,
              type: "function",
            }],
          }, null));
        });
        write(chunk({}, "tool_calls"));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({port: z.number()}).parse(server.address());

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
    turns: () => turns,
    async waitForTurns(count, timeoutMilliseconds = defaultWaitMilliseconds) {
      const deadline = Date.now() + timeoutMilliseconds;
      while (turns.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `The scripted model saw ${turns.length} turn(s); ${count} were expected.`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMilliseconds);
      }
    },
  };
}
