import {spawn} from "node:child_process";
import {constants} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import {Effect, Schema} from "effect";
import {z} from "zod";

import type {CliInvocation} from "./current-cli-invocation.js";
import {localMcpCommand} from "./current-cli-invocation.js";

const managedServerName = "artifact-server";
const clientIdSchema = z.enum(["codex", "claude", "cursor", "vscode"]);
const managedCommandSchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
}).strict();
const registrationSchema = managedCommandSchema.extend({
  client: clientIdSchema,
  configuredAt: z.iso.datetime(),
}).strict();
const registrationStateSchema = z.object({
  registrations: z.array(registrationSchema),
  schemaVersion: z.literal(1),
}).strict();
const jsoncRootSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  servers: z.record(z.string(), z.unknown()).optional(),
}).loose();
const jsoncMcpEntrySchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
  type: z.literal("stdio").optional(),
}).strict();
const systemErrorSchema = z.object({code: z.string().optional()});

type JsoncRoot = z.infer<typeof jsoncRootSchema>;
type JsoncMcpEntry = z.infer<typeof jsoncMcpEntrySchema>;
type JsoncMcpEntryInspection =
  | {readonly state: "absent"}
  | {readonly state: "other"}
  | {readonly entry: JsoncMcpEntry; readonly state: "valid"};

class UnsupportedMcpClient extends Schema.TaggedError<UnsupportedMcpClient>()(
  "UnsupportedMcpClient",
  {message: Schema.String},
) {}

/** AI clients supported by the local onboarding command. */
export type McpClientId = z.infer<typeof clientIdSchema>;

/** Safe registration inspection for one supported client. */
export interface McpClientRegistrationInspection {
  readonly client: McpClientId;
  readonly installed: boolean;
  readonly managed: boolean;
}

/** Parse a user-provided MCP client name. */
export function parseMcpClientId(
  value: string,
): Effect.Effect<McpClientId, UnsupportedMcpClient> {
  const parsed = clientIdSchema.safeParse(value);
  if (!parsed.success) {
    return new UnsupportedMcpClient({
      message:
        `Unsupported AI client "${value}". Choose codex, claude, cursor, or vscode.`,
    });
  }
  return Effect.succeed(parsed.data);
}

/** Find supported client executables available in the current environment. */
export async function detectInstalledMcpClients(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly McpClientId[]> {
  const checks = await Promise.all(clientExecutables.map(async ([client, executable]) => ({
    client,
    installed: await executableExists(executable, environment),
  })));
  return checks.filter((check) => check.installed).map((check) => check.client);
}

/** Register Artifact Server in one user-scoped MCP client configuration. */
export async function connectMcpClient(
  client: McpClientId,
  dataDirectory: string,
  invocation: CliInvocation,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = localMcpCommand(invocation, dataDirectory);
  const state = await readRegistrationState(dataDirectory);
  const owned = state.registrations.find((item) => item.client === client);
  if (client === "codex" || client === "claude") {
    await connectNativeClient(client, command, owned !== undefined, environment);
  } else {
    await connectJsonClient(client, command, owned, environment);
  }
  await writeRegistrationState(dataDirectory, {
    registrations: [
      ...state.registrations.filter((item) => item.client !== client),
      {
        ...command,
        args: [...command.args],
        client,
        configuredAt: new Date().toISOString(),
      },
    ],
    schemaVersion: 1,
  });
}

/** Remove only an Artifact Server registration previously owned by this CLI. */
export async function disconnectMcpClient(
  client: McpClientId,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const state = await readRegistrationState(dataDirectory);
  const owned = state.registrations.find((item) => item.client === client);
  if (owned === undefined) return false;
  if (client === "codex" || client === "claude") {
    await disconnectNativeClient(client, environment);
  } else {
    await disconnectJsonClient(client, owned, environment);
  }
  await writeRegistrationState(dataDirectory, {
    registrations: state.registrations.filter((item) => item.client !== client),
    schemaVersion: 1,
  });
  return true;
}

/** Inspect installed and managed state without changing client configuration. */
export async function inspectMcpClientRegistrations(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly McpClientRegistrationInspection[]> {
  const [installed, state] = await Promise.all([
    detectInstalledMcpClients(environment),
    readRegistrationState(dataDirectory),
  ]);
  return clientIdSchema.options.map((client) => ({
    client,
    installed: installed.includes(client),
    managed: state.registrations.some((item) => item.client === client),
  }));
}

/** List client IDs currently owned by this Artifact Server installation. */
export async function managedMcpClients(
  dataDirectory: string,
): Promise<readonly McpClientId[]> {
  return (await readRegistrationState(dataDirectory)).registrations.map(
    (registration) => registration.client,
  );
}

async function connectNativeClient(
  client: "claude" | "codex",
  command: {readonly args: readonly string[]; readonly command: string},
  owned: boolean,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const executable = client === "codex" ? "codex" : "claude";
  const existing = await runClientCommand(
    executable,
    ["mcp", "get", managedServerName, ...(client === "codex" ? ["--json"] : [])],
    environment,
  );
  if (existing.exitCode === 0 && !owned) {
    throw new Error(
      `${displayName(client)} already has an unmanaged ${managedServerName} entry.`,
    );
  }
  if (existing.exitCode === 0) {
    const removeArguments = client === "claude"
      ? ["mcp", "remove", "--scope", "user", managedServerName]
      : ["mcp", "remove", managedServerName];
    await requireSuccessfulClientCommand(
      executable,
      removeArguments,
      environment,
      `Could not replace the existing ${displayName(client)} registration.`,
    );
  }
  const addArguments = client === "claude"
    ? [
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      managedServerName,
      "--",
      command.command,
      ...command.args,
    ]
    : [
      "mcp",
      "add",
      managedServerName,
      "--",
      command.command,
      ...command.args,
    ];
  await requireSuccessfulClientCommand(
    executable,
    addArguments,
    environment,
    `Could not add Artifact Server to ${displayName(client)}.`,
  );
}

async function disconnectNativeClient(
  client: "claude" | "codex",
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const executable = client === "codex" ? "codex" : "claude";
  const removeArguments = client === "claude"
    ? ["mcp", "remove", "--scope", "user", managedServerName]
    : ["mcp", "remove", managedServerName];
  const removed = await runClientCommand(executable, removeArguments, environment);
  if (removed.exitCode !== 0) {
    const existing = await runClientCommand(
      executable,
      ["mcp", "get", managedServerName, ...(client === "codex" ? ["--json"] : [])],
      environment,
    );
    if (existing.exitCode === 0) {
      throw new Error(`Could not remove Artifact Server from ${displayName(client)}.`);
    }
  }
}

async function connectJsonClient(
  client: "cursor" | "vscode",
  command: {readonly args: readonly string[]; readonly command: string},
  owned: z.infer<typeof registrationSchema> | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const configPath = jsonClientConfigPath(client, environment);
  const document = await readJsoncDocument(configPath);
  const parentKey = client === "cursor" ? "mcpServers" : "servers";
  const existing = inspectManagedEntry(document.value, parentKey);
  if (existing.state !== "absent" && owned === undefined) {
    throw new Error(
      `${displayName(client)} already has an unmanaged ${managedServerName} entry.`,
    );
  }
  if (existing.state !== "absent" && owned !== undefined) {
    const previous: JsoncMcpEntry = client === "vscode"
      ? {args: owned.args, command: owned.command, type: "stdio"}
      : {args: owned.args, command: owned.command};
    if (
      existing.state !== "valid"
      || JSON.stringify(existing.entry) !== JSON.stringify(previous)
    ) {
      throw new Error(
        `${displayName(client)}'s ${managedServerName} entry changed after Artifact Server created it.`,
      );
    }
  }
  const entry: JsoncMcpEntry = client === "vscode"
    ? {args: [...command.args], command: command.command, type: "stdio"}
    : {args: [...command.args], command: command.command};
  await writeJsoncValue(configPath, document.text, [parentKey, managedServerName], entry);
}

async function disconnectJsonClient(
  client: "cursor" | "vscode",
  owned: z.infer<typeof registrationSchema>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const configPath = jsonClientConfigPath(client, environment);
  const document = await readJsoncDocument(configPath);
  const parentKey = client === "cursor" ? "mcpServers" : "servers";
  const existing = inspectManagedEntry(document.value, parentKey);
  if (existing.state === "absent") return;
  const expected: JsoncMcpEntry = client === "vscode"
    ? {args: owned.args, command: owned.command, type: "stdio"}
    : {args: owned.args, command: owned.command};
  if (
    existing.state !== "valid"
    || JSON.stringify(existing.entry) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `${displayName(client)}'s ${managedServerName} entry changed after Artifact Server created it.`,
    );
  }
  await writeJsoncValue(configPath, document.text, [parentKey, managedServerName], undefined);
}

function inspectManagedEntry(
  document: JsoncRoot,
  parentKey: "mcpServers" | "servers",
): JsoncMcpEntryInspection {
  const candidate = document[parentKey]?.[managedServerName];
  if (candidate === undefined) return {state: "absent"};
  const parsed = jsoncMcpEntrySchema.safeParse(candidate);
  return parsed.success
    ? {entry: parsed.data, state: "valid"}
    : {state: "other"};
}

async function readJsoncDocument(
  configPath: string,
): Promise<{readonly text: string; readonly value: JsoncRoot}> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
    text = "{}\n";
  }
  const errors: ParseError[] = [];
  const parsedJson: unknown = parse(text, errors, {allowTrailingComma: true});
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Cannot update malformed MCP configuration at ${configPath}: ${first === undefined ? "unknown parse error" : printParseErrorCode(first.error)}.`,
    );
  }
  return {text, value: jsoncRootSchema.parse(parsedJson)};
}

async function writeJsoncValue(
  configPath: string,
  source: string,
  jsonPath: readonly string[],
  value: JsoncMcpEntry | undefined,
): Promise<void> {
  const edits = modify(source, [...jsonPath], value, {
    formattingOptions: {insertSpaces: true, tabSize: 2},
  });
  const next = applyEdits(source, edits);
  await mkdir(path.dirname(configPath), {recursive: true, mode: 0o700});
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, next, {encoding: "utf8", mode: 0o600});
  await chmod(temporary, 0o600);
  await rename(temporary, configPath);
}

async function readRegistrationState(
  dataDirectory: string,
): Promise<z.infer<typeof registrationStateSchema>> {
  try {
    const value: unknown = JSON.parse(await readFile(
      path.join(dataDirectory, "mcp-registrations.json"),
      "utf8",
    ));
    return registrationStateSchema.parse(value);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") {
      return {registrations: [], schemaVersion: 1};
    }
    throw error;
  }
}

async function writeRegistrationState(
  dataDirectory: string,
  state: z.infer<typeof registrationStateSchema>,
): Promise<void> {
  const validated = registrationStateSchema.parse(state);
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  const target = path.join(dataDirectory, "mcp-registrations.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

async function requireSuccessfulClientCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
): Promise<void> {
  const result = await runClientCommand(executable, arguments_, environment);
  if (result.exitCode !== 0) throw new Error(failureMessage);
}

function runClientCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{readonly exitCode: number}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({exitCode: code ?? 1}));
  });
}

async function executableExists(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const searchPath = environment["PATH"] ?? "";
  const extensions = process.platform === "win32"
    ? (environment["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  const candidates = searchPath.split(path.delimiter).filter(Boolean).flatMap(
    (directory) => extensions.map(
      (extension) => path.join(directory, `${executable}${extension}`),
    ),
  );
  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
  return results.includes(true);
}

function jsonClientConfigPath(
  client: "cursor" | "vscode",
  environment: NodeJS.ProcessEnv,
): string {
  const override = client === "cursor"
    ? environment["ARTIFACT_SERVER_CURSOR_MCP_CONFIG"]
    : environment["ARTIFACT_SERVER_VSCODE_MCP_CONFIG"];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const home = environment["HOME"] ?? homedir();
  if (client === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (process.platform === "win32") {
    const applicationData = environment["APPDATA"];
    if (applicationData === undefined) {
      throw new Error("APPDATA is required to locate the VS Code user configuration.");
    }
    return path.join(applicationData, "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

function displayName(client: McpClientId): string {
  return {
    claude: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    vscode: "VS Code",
  }[client];
}

const clientExecutables: readonly (readonly [McpClientId, string])[] = [
  ["codex", "codex"],
  ["claude", "claude"],
  ["cursor", "cursor"],
  ["vscode", "code"],
];
