import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command, Option } from "commander";
import { z } from "zod";

import {startLocalServer} from "../local/start-local-server.js";

interface StartOptions {
  readonly data: string;
  readonly port: string;
}

const systemErrorSchema = z.object({code: z.string().optional()});

const program = new Command()
  .name("artifactserver")
  .description("Run the local Artifact Server implementation.")
  .showHelpAfterError();

program
  .command("start")
  .description("Start one local Artifact Server process.")
  .addOption(
    new Option("--data <directory>", "persistent data directory")
      .default(".artifact-server"),
  )
  .addOption(
    new Option("--port <number>", "HTTP port")
      .default("8787")
      .env("ARTIFACT_SERVER_PORT"),
  )
  .action(async (options: StartOptions) => {
    const port = parsePort(options.port);
    const dataDirectory = path.resolve(options.data);
    const apiToken = await loadOrCreateLocalToken(dataDirectory);
    const server = await startLocalServer({
      apiToken,
      contentDomain: "localhost",
      dataDirectory,
      port,
    });

    console.log(`Artifact Server: http://localhost:${port}`);
    console.log(`Local API token: ${apiToken}`);
    console.log(`Data directory: ${dataDirectory}`);

    await new Promise<void>((resolve, reject) => {
      const shutdown = () => {
        void server.close().then(resolve, reject);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  });

await program.parseAsync();

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The port must be an integer between 1 and 65535.");
  }
  return port;
}

async function loadOrCreateLocalToken(dataDirectory: string): Promise<string> {
  const tokenPath = path.join(dataDirectory, "local-api-token");
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
  await chmod(tokenPath, 0o600);
  return token;
}
