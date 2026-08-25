import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
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
const claudeUserConfigurationSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
}).loose();
const claudeStdioEntrySchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
  type: z.literal("stdio"),
}).strict();
const systemErrorSchema = z.object({code: z.string().optional()});
const commandSnapshotSchema = managedCommandSchema.nullable();
const jsonClientChangeSchema = z.object({
  afterDocumentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  afterEntry: jsoncMcpEntrySchema.nullable(),
  beforeDocumentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  beforeEntry: jsoncMcpEntrySchema.nullable(),
  configPath: z.string().min(1),
  kind: z.literal("json"),
  parentKey: z.enum(["mcpServers", "servers"]),
}).strict();
const nativeClientChangeSchema = z.object({
  after: commandSnapshotSchema,
  before: commandSnapshotSchema,
  kind: z.literal("native"),
}).strict();
const onboardingJournalSchema = z.object({
  action: z.enum(["connect", "disconnect"]),
  change: z.discriminatedUnion("kind", [
    jsonClientChangeSchema,
    nativeClientChangeSchema,
  ]),
  client: clientIdSchema,
  createdAt: z.iso.datetime(),
  registrationAfter: registrationStateSchema,
  registrationBeforeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  registrationBefore: registrationStateSchema,
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
}).strict();

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
  const recovered = await recoverPendingOnboarding(dataDirectory, environment);
  if (recovered?.action === "connect" && recovered.client === client) return;
  const command = localMcpCommand(invocation, dataDirectory);
  const state = await readRegistrationState(dataDirectory);
  const owned = state.registrations.find((item) => item.client === client);
  const change = client === "codex" || client === "claude"
    ? await planNativeChange(client, owned, command, environment)
    : await planJsonChange(client, owned, command, environment);
  const registrationAfter = {
    registrations: [
      ...state.registrations.filter((item) => item.client !== client),
      {
        ...command,
        args: [...command.args],
        client,
        configuredAt: new Date().toISOString(),
      },
    ],
    schemaVersion: 1 as const,
  };
  await executeOnboardingTransaction(dataDirectory, environment, {
    action: "connect",
    change,
    client,
    registrationAfter,
    registrationBefore: state,
  });
}

/** Remove only an Artifact Server registration previously owned by this CLI. */
export async function disconnectMcpClient(
  client: McpClientId,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const recovered = await recoverPendingOnboarding(dataDirectory, environment);
  if (recovered?.action === "disconnect" && recovered.client === client) return true;
  const state = await readRegistrationState(dataDirectory);
  const owned = state.registrations.find((item) => item.client === client);
  if (owned === undefined) return false;
  const change = client === "codex" || client === "claude"
    ? await planNativeChange(client, owned, null, environment)
    : await planJsonChange(client, owned, null, environment);
  const registrationAfter = {
    registrations: state.registrations.filter((item) => item.client !== client),
    schemaVersion: 1 as const,
  };
  await executeOnboardingTransaction(dataDirectory, environment, {
    action: "disconnect",
    change,
    client,
    registrationAfter,
    registrationBefore: state,
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

interface ManagedCommand {
  readonly args: readonly string[];
  readonly command: string;
}
type Registration = z.infer<typeof registrationSchema>;
type RegistrationState = z.infer<typeof registrationStateSchema>;
type OnboardingJournal = z.infer<typeof onboardingJournalSchema>;
type ClientChange = OnboardingJournal["change"];

interface OnboardingTransactionInput {
  readonly action: OnboardingJournal["action"];
  readonly change: ClientChange;
  readonly client: McpClientId;
  readonly registrationAfter: RegistrationState;
  readonly registrationBefore: RegistrationState;
}

async function planNativeChange(
  client: "claude" | "codex",
  owned: Registration | undefined,
  after: ManagedCommand | null,
  environment: NodeJS.ProcessEnv,
): Promise<z.infer<typeof nativeClientChangeSchema>> {
  const current = await inspectNativeClient(client, environment);
  if (current.exists && owned === undefined) {
    throw new Error(
      `${displayName(client)} already has an unmanaged ${managedServerName} entry.`,
    );
  }
  const before = owned === undefined
    ? null
    : {args: [...owned.args], command: owned.command};
  if (!nativeInspectionMatches(current, before)) {
    throw new Error(
      `${displayName(client)}'s ${managedServerName} entry changed after Artifact Server created it.`,
    );
  }
  return {
    after: after === null ? null : {args: [...after.args], command: after.command},
    before,
    kind: "native",
  };
}

async function planJsonChange(
  client: "cursor" | "vscode",
  owned: Registration | undefined,
  after: ManagedCommand | null,
  environment: NodeJS.ProcessEnv,
): Promise<z.infer<typeof jsonClientChangeSchema>> {
  const configPath = jsonClientConfigPath(client, environment);
  const document = await readJsoncDocument(configPath);
  const parentKey = client === "cursor" ? "mcpServers" : "servers";
  const existing = inspectManagedEntry(document.value, parentKey);
  if (existing.state !== "absent" && owned === undefined) {
    throw new Error(
      `${displayName(client)} already has an unmanaged ${managedServerName} entry.`,
    );
  }
  const beforeEntry = owned === undefined
    ? null
    : jsonEntry(client, owned);
  if (
    owned !== undefined
    && (
      existing.state !== "valid"
      || JSON.stringify(existing.entry) !== JSON.stringify(beforeEntry)
    )
  ) {
    throw new Error(
      `${displayName(client)}'s ${managedServerName} entry changed after Artifact Server created it.`,
    );
  }
  const afterEntry = after === null ? null : jsonEntry(client, after);
  const next = editJsoncValue(document.text, [parentKey, managedServerName], afterEntry);
  return {
    afterDocumentDigest: digestText(next),
    afterEntry,
    beforeDocumentDigest: digestText(document.text),
    beforeEntry,
    configPath,
    kind: "json",
    parentKey,
  };
}

async function executeOnboardingTransaction(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
  input: OnboardingTransactionInput,
): Promise<void> {
  const journal = onboardingJournalSchema.parse({
    ...input,
    createdAt: new Date().toISOString(),
    registrationBeforeDigest: registrationDigest(input.registrationBefore),
    schemaVersion: 1,
    transactionId: randomUUID(),
  });
  await assertRegistrationState(
    dataDirectory,
    journal.registrationBeforeDigest,
  );
  await writeOnboardingJournal(dataDirectory, journal);
  try {
    await applyClientChange(journal.client, journal.change, "forward", environment);
    if (!await clientChangeMatches(
      journal.client,
      journal.change,
      "after",
      environment,
    )) {
      throw new Error("The MCP client did not preserve the requested configuration.");
    }
    await writeRegistrationState(
      dataDirectory,
      journal.registrationAfter,
      journal.registrationBeforeDigest,
    );
    await removeOnboardingJournal(dataDirectory);
  } catch (error) {
    try {
      await rollbackOnboarding(journal, dataDirectory, environment);
    } catch (rollbackError) {
      throw new Error(
        "MCP onboarding stopped and could not roll back safely. Client configuration that changed independently is preserved; otherwise the operation will resume from its journal. Run artifactserver connect or disconnect again.",
        {cause: rollbackError},
      );
    }
    throw error;
  }
}

async function recoverPendingOnboarding(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<Pick<OnboardingJournal, "action" | "client"> | null> {
  const journal = await readOnboardingJournal(dataDirectory);
  if (journal === null) return null;
  const registration = await readRegistrationState(dataDirectory);
  const currentDigest = registrationDigest(registration);
  const afterDigest = registrationDigest(journal.registrationAfter);
  if (
    currentDigest !== journal.registrationBeforeDigest
    && currentDigest !== afterDigest
  ) {
    throw new Error(
      "MCP onboarding cannot resume because its private registration state changed independently.",
    );
  }
  if (!await clientChangeMatches(journal.client, journal.change, "after", environment)) {
    await applyClientChange(journal.client, journal.change, "forward", environment);
  }
  if (currentDigest === journal.registrationBeforeDigest) {
    await writeRegistrationState(
      dataDirectory,
      journal.registrationAfter,
      journal.registrationBeforeDigest,
    );
  }
  await removeOnboardingJournal(dataDirectory);
  return {action: journal.action, client: journal.client};
}

async function rollbackOnboarding(
  journal: OnboardingJournal,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const currentRegistration = await readRegistrationState(dataDirectory);
  const currentDigest = registrationDigest(currentRegistration);
  const afterDigest = registrationDigest(journal.registrationAfter);
  const clientBefore = await clientChangeMatches(
    journal.client,
    journal.change,
    "before",
    environment,
  );
  const clientAfter = await clientChangeMatches(
    journal.client,
    journal.change,
    "after",
    environment,
  );
  if (!clientBefore && !clientAfter) {
    throw new Error("The MCP client configuration changed independently.");
  }
  if (
    clientAfter
    && (journal.change.kind === "json" || currentDigest === afterDigest)
  ) {
    throw new Error(
      "The durable client change must be completed forward from its journal.",
    );
  }
  if (currentDigest === afterDigest) {
    await writeRegistrationState(
      dataDirectory,
      journal.registrationBefore,
      afterDigest,
    );
  } else if (currentDigest !== journal.registrationBeforeDigest) {
    throw new Error("The MCP registration state changed during rollback.");
  }
  if (!clientBefore) {
    await applyClientChange(journal.client, journal.change, "rollback", environment);
  }
  await removeOnboardingJournal(dataDirectory);
}

async function applyClientChange(
  client: McpClientId,
  change: ClientChange,
  direction: "forward" | "rollback",
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (change.kind === "json") {
    await applyJsonClientChange(change, direction);
    return;
  }
  if (client !== "codex" && client !== "claude") {
    throw new Error("A native onboarding journal named a JSON-only client.");
  }
  const before = direction === "forward" ? change.before : change.after;
  const after = direction === "forward" ? change.after : change.before;
  let replacementBefore = before;
  if (!await nativeClientMatches(client, before, environment)) {
    const resumableIntermediate = before !== null
      && after !== null
      && await nativeClientMatches(client, null, environment);
    if (!resumableIntermediate) {
      throw new Error(
        `${displayName(client)} changed independently during MCP onboarding.`,
      );
    }
    replacementBefore = null;
  }
  await replaceNativeClient(client, replacementBefore, after, environment);
}

async function clientChangeMatches(
  client: McpClientId,
  change: ClientChange,
  side: "after" | "before",
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (change.kind === "json") {
    const expected = side === "after"
      ? change.afterDocumentDigest
      : change.beforeDocumentDigest;
    return digestText((await readJsoncDocument(change.configPath)).text) === expected;
  }
  return nativeClientMatches(client, change[side], environment);
}

async function applyJsonClientChange(
  change: z.infer<typeof jsonClientChangeSchema>,
  direction: "forward" | "rollback",
): Promise<void> {
  const expectedDigest = direction === "forward"
    ? change.beforeDocumentDigest
    : change.afterDocumentDigest;
  const nextDigest = direction === "forward"
    ? change.afterDocumentDigest
    : change.beforeDocumentDigest;
  const value = direction === "forward" ? change.afterEntry : change.beforeEntry;
  const document = await readJsoncDocument(change.configPath);
  if (digestText(document.text) !== expectedDigest) {
    throw new Error("The MCP client configuration changed independently.");
  }
  const next = editJsoncValue(
    document.text,
    [change.parentKey, managedServerName],
    value,
  );
  if (digestText(next) !== nextDigest) {
    throw new Error("The MCP client configuration no longer matches its journal.");
  }
  await writeJsoncDocument(change.configPath, document.text, next);
}

function jsonEntry(
  client: "cursor" | "vscode",
  command: ManagedCommand,
): JsoncMcpEntry {
  return client === "vscode"
    ? {args: [...command.args], command: command.command, type: "stdio"}
    : {args: [...command.args], command: command.command};
}

function registrationDigest(state: RegistrationState): string {
  return digestText(JSON.stringify(state));
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface NativeClientInspection {
  readonly exists: boolean;
  readonly output: string;
  readonly parsed: ManagedCommand | null;
}

async function replaceNativeClient(
  client: "claude" | "codex",
  before: ManagedCommand | null,
  after: ManagedCommand | null,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const current = await inspectNativeClient(client, environment);
  if (!nativeInspectionMatches(current, before)) {
    throw new Error(
      `${displayName(client)} changed independently during MCP onboarding.`,
    );
  }
  const executable = client === "codex" ? "codex" : "claude";
  if (current.exists) {
    const removeArguments = client === "claude"
      ? ["mcp", "remove", "--scope", "user", managedServerName]
      : ["mcp", "remove", managedServerName];
    await requireSuccessfulClientCommand(
      executable,
      removeArguments,
      environment,
      `Could not remove Artifact Server from ${displayName(client)}.`,
    );
  }
  if (after === null) return;
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
      after.command,
      ...after.args,
    ]
    : [
      "mcp",
      "add",
      managedServerName,
      "--",
      after.command,
      ...after.args,
    ];
  await requireSuccessfulClientCommand(
    executable,
    addArguments,
    environment,
    `Could not add Artifact Server to ${displayName(client)}.`,
  );
}

async function nativeClientMatches(
  client: McpClientId,
  expected: ManagedCommand | null,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (client !== "codex" && client !== "claude") {
    throw new Error("A JSON MCP client was routed through native inspection.");
  }
  return nativeInspectionMatches(
    await inspectNativeClient(client, environment),
    expected,
  );
}

async function inspectNativeClient(
  client: "claude" | "codex",
  environment: NodeJS.ProcessEnv,
): Promise<NativeClientInspection> {
  const executable = client === "codex" ? "codex" : "claude";
  const result = await runClientCommand(
    executable,
    ["mcp", "get", managedServerName, ...(client === "codex" ? ["--json"] : [])],
    environment,
  );
  if (result.exitCode !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
    const notFound = client === "codex"
      ? /^Error: No MCP server named '.+' found\.$/u.test(diagnostic)
      : /^No MCP server named ".+"(?:\.|\. Configured servers: .*)$/u.test(
        diagnostic,
      );
    if (notFound) return {exists: false, output: diagnostic, parsed: null};
    throw new Error(
      `${displayName(client)} MCP inspection failed${
        diagnostic === "" ? "." : `: ${diagnostic}`
      }`,
    );
  }
  const claudeConfiguration = client === "claude"
    ? await readClaudeManagedCommand(environment)
    : null;
  return {
    exists: true,
    output: result.stdout,
    parsed: claudeConfiguration ?? parseNativeCommand(client, result.stdout),
  };
}

function nativeInspectionMatches(
  inspection: NativeClientInspection,
  expected: ManagedCommand | null,
): boolean {
  if (expected === null) return !inspection.exists;
  if (!inspection.exists) return false;
  if (inspection.parsed !== null) {
    return JSON.stringify(inspection.parsed) === JSON.stringify(expected);
  }
  const lines = inspection.output.split(/\r?\n/u);
  const environmentLine = lines.findIndex((line) => line.trim() === "Environment:");
  const followingEnvironmentLine = environmentLine === -1
    ? undefined
    : lines[environmentLine + 1];
  return lines.some((line) => line.trim() === "Type: stdio")
    && lines.some((line) => line.trim() === `Command: ${expected.command}`)
    && lines.some((line) => line.trim() === `Args: ${expected.args.join(" ")}`)
    && environmentLine !== -1
    && (followingEnvironmentLine === undefined || followingEnvironmentLine.trim() === "");
}

function parseNativeCommand(
  client: "claude" | "codex",
  output: string,
): ManagedCommand | null {
  try {
    const decoded: unknown = JSON.parse(output);
    const direct = managedCommandSchema.safeParse(decoded);
    if (direct.success) return direct.data;
    if (client === "codex") {
      const codex = z.object({
        disabled_reason: z.null(),
        disabled_tools: z.null(),
        enabled: z.literal(true),
        enabled_tools: z.null(),
        startup_timeout_sec: z.null(),
        tool_timeout_sec: z.null(),
        transport: z.object({
          args: z.array(z.string()),
          command: z.string().min(1),
          cwd: z.null(),
          env: z.null(),
          env_vars: z.array(z.never()).max(0),
          type: z.literal("stdio"),
        }).strict(),
      }).passthrough().safeParse(decoded);
      if (codex.success) {
        return {
          args: codex.data.transport.args,
          command: codex.data.transport.command,
        };
      }
    }
  } catch {
    // Claude currently exposes human-readable output instead of JSON.
  }
  return null;
}

async function readClaudeManagedCommand(
  environment: NodeJS.ProcessEnv,
): Promise<ManagedCommand | null> {
  const home = environment["HOME"] ?? homedir();
  try {
    const decoded: unknown = JSON.parse(await readFile(
      path.join(home, ".claude.json"),
      "utf8",
    ));
    const root = claudeUserConfigurationSchema.parse(decoded);
    const entry = claudeStdioEntrySchema.safeParse(
      root.mcpServers?.[managedServerName],
    );
    if (!entry.success || Object.keys(entry.data.env).length > 0) return null;
    return {args: entry.data.args, command: entry.data.command};
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    return null;
  }
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

function editJsoncValue(
  source: string,
  jsonPath: readonly string[],
  value: JsoncMcpEntry | null,
): string {
  const edits = modify(source, [...jsonPath], value ?? undefined, {
    formattingOptions: {insertSpaces: true, tabSize: 2},
  });
  return applyEdits(source, edits);
}

async function writeJsoncDocument(
  configPath: string,
  expectedSource: string,
  next: string,
): Promise<void> {
  const current = await readJsoncDocument(configPath);
  if (current.text !== expectedSource) {
    throw new Error("The MCP client configuration changed before it could be saved.");
  }
  await mkdir(path.dirname(configPath), {recursive: true, mode: 0o700});
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, next, {encoding: "utf8", mode: 0o600});
  await chmod(temporary, 0o600);
  const latest = await readJsoncDocument(configPath);
  if (latest.text !== expectedSource) {
    await rm(temporary, {force: true});
    throw new Error("The MCP client configuration changed while it was being saved.");
  }
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
  expectedDigest?: string,
): Promise<void> {
  const validated = registrationStateSchema.parse(state);
  if (expectedDigest !== undefined) {
    await assertRegistrationState(dataDirectory, expectedDigest);
  }
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  const target = path.join(dataDirectory, "mcp-registrations.json");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeSyncedPrivateFile(
    temporary,
    `${JSON.stringify(validated, null, 2)}\n`,
  );
  if (expectedDigest !== undefined) {
    try {
      await assertRegistrationState(dataDirectory, expectedDigest);
    } catch (error) {
      await rm(temporary, {force: true});
      throw error;
    }
  }
  await rename(temporary, target);
}

async function assertRegistrationState(
  dataDirectory: string,
  expectedDigest: string,
): Promise<void> {
  const current = await readRegistrationState(dataDirectory);
  if (registrationDigest(current) !== expectedDigest) {
    throw new Error("The MCP registration state changed independently.");
  }
}

async function readOnboardingJournal(
  dataDirectory: string,
): Promise<OnboardingJournal | null> {
  try {
    const decoded: unknown = JSON.parse(await readFile(
      onboardingJournalPath(dataDirectory),
      "utf8",
    ));
    return onboardingJournalSchema.parse(decoded);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    throw error;
  }
}

async function writeOnboardingJournal(
  dataDirectory: string,
  journal: OnboardingJournal,
): Promise<void> {
  const validated = onboardingJournalSchema.parse(journal);
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  const target = onboardingJournalPath(dataDirectory);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  try {
    await link(temporary, target);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
    throw new Error(
      "Another MCP onboarding transaction is pending. Run the command again to resume it safely.",
      {cause: error},
    );
  } finally {
    await rm(temporary, {force: true});
  }
}

async function writeSyncedPrivateFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

function removeOnboardingJournal(dataDirectory: string): Promise<void> {
  return rm(onboardingJournalPath(dataDirectory), {force: true});
}

function onboardingJournalPath(dataDirectory: string): string {
  return path.join(dataDirectory, "mcp-onboarding-transaction.json");
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
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({
      exitCode: code ?? 1,
      stderr: Buffer.concat(stderr).toString("utf8").slice(0, 8_192),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
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
