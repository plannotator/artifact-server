import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {type Command, Option} from "commander";

import {readLocalApiCredential} from "../local/local-credentials.js";
import {startLocalMcpStdioBridge} from "../mcp/start-local-mcp-stdio-bridge.js";
import {currentCliInvocation, localMcpCommand} from "./current-cli-invocation.js";
import {runCliEffect} from "./run-cli-effect.js";
import {
  connectMcpClient,
  detectInstalledMcpClients,
  disconnectMcpClient,
  inspectMcpClientRegistrations,
  managedMcpClients,
  parseMcpClientId,
  type McpClientId,
} from "./mcp-client-registrations.js";
import {
  ensureManagedLocalService,
  inspectManagedLocalService,
} from "./local-service-manager.js";

const modernProtocolRevision = "2026-07-28";

interface DataOptions {
  readonly data: string;
}

/** Build values needed by the local MCP onboarding commands. */
export interface McpOnboardingCommandOptions {
  readonly defaultDataDirectory: string;
  readonly productVersion: string;
}

/** Register local MCP serving, connection, removal, and diagnostics commands. */
export function configureMcpOnboardingCommands(
  program: Command,
  options: McpOnboardingCommandOptions,
): void {
  configureMcpCommand(program, options);
  configureConnectCommand(program, options);
  configureDisconnectCommand(program, options);
  configureDoctorCommand(program, options);
}

function configureMcpCommand(
  program: Command,
  options: McpOnboardingCommandOptions,
): void {
  program
    .command("mcp")
    .description("Serve the local Artifact Server over MCP stdio.")
    .addOption(dataOption(options.defaultDataDirectory))
    .action((commandOptions: DataOptions) => {
      startLocalMcpStdioBridge({
        dataDirectory: path.resolve(commandOptions.data),
        invocation: currentCliInvocation(),
        productVersion: options.productVersion,
      });
    });
}

function configureConnectCommand(
  program: Command,
  options: McpOnboardingCommandOptions,
): void {
  program
    .command("connect [client]")
    .description("Connect Artifact Server to an installed AI client.")
    .addOption(dataOption(options.defaultDataDirectory))
    .action(async (clientName: string | undefined, commandOptions: DataOptions) => {
      const dataDirectory = path.resolve(commandOptions.data);
      const client = await selectInstalledClient(clientName);
      const invocation = currentCliInvocation();
      const service = await ensureManagedLocalService(dataDirectory, invocation);
      await connectMcpClient(client, dataDirectory, invocation);
      await verifyLocalStdioBridge(
        dataDirectory,
        invocation,
        options.productVersion,
      );
      console.log(JSON.stringify({
        client,
        serverAddress: service.origin,
      }, null, 2));
    });
}

function configureDisconnectCommand(
  program: Command,
  options: McpOnboardingCommandOptions,
): void {
  program
    .command("disconnect [client]")
    .description("Remove Artifact Server from one AI client.")
    .addOption(dataOption(options.defaultDataDirectory))
    .action(async (clientName: string | undefined, commandOptions: DataOptions) => {
      const dataDirectory = path.resolve(commandOptions.data);
      const client = await selectDisconnectClient(clientName, dataDirectory);
      const removed = await disconnectMcpClient(client, dataDirectory);
      console.log(JSON.stringify({
        client,
        status: removed ? "disconnected" : "already_disconnected",
      }, null, 2));
    });
}

function configureDoctorCommand(
  program: Command,
  options: McpOnboardingCommandOptions,
): void {
  program
    .command("doctor [client]")
    .description("Inspect local MCP service and client setup without changing it.")
    .addOption(dataOption(options.defaultDataDirectory))
    .action(async (clientName: string | undefined, commandOptions: DataOptions) => {
      const dataDirectory = path.resolve(commandOptions.data);
      const requestedClient = clientName === undefined
        ? null
        : await runCliEffect(parseMcpClientId(clientName));
      const [service, clients] = await Promise.all([
        inspectManagedLocalService(dataDirectory),
        inspectMcpClientRegistrations(dataDirectory),
      ]);
      const selectedClients = requestedClient === null
        ? clients
        : clients.filter((client) => client.client === requestedClient);
      let discovery: {protocolRevision: string; status: "healthy"; tools: number}
        | {reason: string; status: "unhealthy"};
      if (!service.reachable || service.record === null) {
        discovery = {reason: "The managed local service is not reachable.", status: "unhealthy"};
      } else {
        discovery = await inspectModernMcp(
          dataDirectory,
          service.record.origin,
          options.productVersion,
        );
      }
      const clientHealthy = requestedClient === null
        || selectedClients.every((client) => client.installed && client.managed);
      const healthy = service.reachable
        && discovery.status === "healthy"
        && clientHealthy;
      console.log(JSON.stringify({
        clients: selectedClients,
        dataDirectory,
        discovery,
        remediation: healthy
          ? []
          : [`artifactserver connect${requestedClient === null ? "" : ` ${requestedClient}`}`],
        service: {
          processAlive: service.processAlive,
          reachable: service.reachable,
          recordState: service.recordState === "valid" && !service.reachable
            ? (service.processAlive === true ? "unhealthy" : "stale")
            : service.recordState,
        },
        status: healthy ? "healthy" : "unhealthy",
      }, null, 2));
      if (!healthy) process.exitCode = 2;
    });
}

async function selectInstalledClient(
  clientName: string | undefined,
): Promise<McpClientId> {
  const installed = await detectInstalledMcpClients();
  if (clientName !== undefined) {
    const selected = await runCliEffect(parseMcpClientId(clientName));
    if (!installed.includes(selected)) {
      throw new Error(`${selected} is not installed or is not available on PATH.`);
    }
    return selected;
  }
  return selectSingleClient(installed, "installed");
}

async function selectDisconnectClient(
  clientName: string | undefined,
  dataDirectory: string,
): Promise<McpClientId> {
  if (clientName !== undefined) {
    return runCliEffect(parseMcpClientId(clientName));
  }
  const managed = await managedMcpClients(dataDirectory);
  if (managed.length > 0) return selectSingleClient(managed, "connected");
  return selectSingleClient(await detectInstalledMcpClients(), "installed");
}

function selectSingleClient(
  clients: readonly McpClientId[],
  state: "connected" | "installed",
): McpClientId {
  const selected = clients[0];
  if (clients.length === 1 && selected !== undefined) return selected;
  if (clients.length === 0) {
    throw new Error(`No supported ${state} AI client was found.`);
  }
  throw new Error(
    `More than one supported AI client is ${state}: ${clients.join(", ")}. Run the command again with one client name.`,
  );
}

async function verifyLocalStdioBridge(
  dataDirectory: string,
  invocation: ReturnType<typeof currentCliInvocation>,
  productVersion: string,
): Promise<{readonly protocolRevision: string; readonly tools: number}> {
  const stdio = localMcpCommand(invocation, dataDirectory);
  const transport = new StdioClientTransport({
    args: [...stdio.args],
    command: stdio.command,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client(
    {name: "artifact-server-connect-verifier", version: productVersion},
    {versionNegotiation: {mode: {pin: modernProtocolRevision}}},
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (listed.tools.length === 0) {
      throw new Error("Artifact Server connected but returned no MCP tools.");
    }
    return {
      protocolRevision: client.getNegotiatedProtocolVersion() ?? modernProtocolRevision,
      tools: listed.tools.length,
    };
  } finally {
    await client.close();
  }
}

async function inspectModernMcp(
  dataDirectory: string,
  origin: string,
  productVersion: string,
): Promise<
  | {reason: string; status: "unhealthy"}
  | {protocolRevision: string; status: "healthy"; tools: number}
> {
  const client = new Client(
    {name: "artifact-server-doctor", version: productVersion},
    {versionNegotiation: {mode: {pin: modernProtocolRevision}}},
  );
  try {
    const credential = await readLocalApiCredential(dataDirectory);
    await client.connect(new StreamableHTTPClientTransport(
      new URL("/mcp", origin),
      {authProvider: {token: async () => credential}},
    ));
    const listed = await client.listTools();
    return {
      protocolRevision: client.getNegotiatedProtocolVersion() ?? modernProtocolRevision,
      status: "healthy",
      tools: listed.tools.length,
    };
  } catch {
    return {reason: "Modern MCP discovery failed.", status: "unhealthy"};
  } finally {
    await client.close();
  }
}

function dataOption(defaultDataDirectory: string): Option {
  return new Option("--data <directory>", "per-user Artifact Server data directory")
    .default(defaultDataDirectory);
}
