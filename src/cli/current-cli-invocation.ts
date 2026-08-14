import path from "node:path";

/** Executable and fixed arguments required to invoke this exact CLI release. */
export interface CliInvocation {
  readonly command: string;
  readonly prefixArguments: readonly string[];
}

/** Concrete stdio server registration used by supported AI clients. */
export interface LocalMcpCommand {
  readonly args: readonly string[];
  readonly command: string;
}

/** Resolve this running CLI without relying on a shell alias or PATH entry. */
export function currentCliInvocation(): CliInvocation {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Artifact Server could not resolve its CLI entrypoint.");
  }
  return {
    command: process.execPath,
    prefixArguments: [...process.execArgv, path.resolve(entrypoint)],
  };
}

/** Build the stdio registration command for one local data directory. */
export function localMcpCommand(
  invocation: CliInvocation,
  dataDirectory: string,
): LocalMcpCommand {
  return {
    args: [
      ...invocation.prefixArguments,
      "mcp",
      "--data",
      path.resolve(dataDirectory),
    ],
    command: invocation.command,
  };
}
