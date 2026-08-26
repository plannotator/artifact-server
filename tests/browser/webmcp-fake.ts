import type {BrowserContext, Frame, Page} from "@playwright/test";
import type {z} from "zod";

/** JSON as the user agent serializes a tool result. */
type JsonValue = z.infer<ReturnType<typeof z.json>>;
/** The JSON arguments an agent's invocation hands a tool. */
type ToolInput = Record<string, boolean | number | string>;

declare global {
  interface Window {
    /** The recording probe the fake model context installs for these tests. */
    readonly wmcProbe?: {
      call(name: string, input: ToolInput): Promise<JsonValue>;
      describe(): string[];
      failure(name: string, input: ToolInput): Promise<string | null>;
      names(): string[];
    };
  }
}

/**
 * A recording stand-in for a WebMCP-capable browser, installed before any
 * application script runs: it exposes `document.modelContext.registerTool`
 * per the webmachinelearning/webmcp draft (registration, `{signal}`
 * unregistration) and a `window.wmcProbe` probe the tests drive tools through,
 * exactly as an agent's invocation would reach the page callback.
 */
const fakeModelContextScript = `(() => {
  const tools = new Map();
  const modelContext = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => tools.delete(tool.name));
      }
      return Promise.resolve(undefined);
    },
    getTools() {
      return Promise.resolve([...tools.values()].map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
      })));
    },
  };
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: modelContext,
  });
  window.wmcProbe = {
    call: async (name, input) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error("No tool named " + name);
      return JSON.parse(JSON.stringify(await tool.execute(input ?? {})));
    },
    describe: () => [...tools.values()].map((tool) => tool.description),
    failure: async (name, input) => {
      const tool = tools.get(name);
      if (tool === undefined) return "No tool named " + name;
      try {
        await tool.execute(input ?? {});
        return null;
      } catch (error) {
        return String(error && error.message ? error.message : error);
      }
    },
    names: () => [...tools.keys()].sort(),
  };
})();`;

export async function installFakeModelContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(fakeModelContextScript);
}

export function registeredToolNames(target: Frame | Page): Promise<readonly string[]> {
  return target.evaluate(() => window.wmcProbe === undefined ? [] : window.wmcProbe.names());
}

export function toolDescriptions(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => window.wmcProbe === undefined ? [] : window.wmcProbe.describe());
}

export function callTool(
  page: Page,
  name: string,
  input: ToolInput = {},
): Promise<JsonValue> {
  return page.evaluate(
    ([toolName, toolInput]) => {
      if (window.wmcProbe === undefined) throw new Error("The fake model context is missing.");
      return window.wmcProbe.call(toolName, toolInput);
    },
    [name, input] as const,
  );
}

export function toolFailure(
  page: Page,
  name: string,
  input: ToolInput = {},
): Promise<string | null> {
  return page.evaluate(
    ([toolName, toolInput]) => {
      if (window.wmcProbe === undefined) {
        return Promise.resolve("The fake model context is missing.");
      }
      return window.wmcProbe.failure(toolName, toolInput);
    },
    [name, input] as const,
  );
}

export const expectedToolNames = [
  "artifact_server_comment",
  "artifact_server_get_view",
  "artifact_server_list_artifacts",
  "artifact_server_open",
  "artifact_server_reopen",
  "artifact_server_reply",
  "artifact_server_resolve",
] as const;
