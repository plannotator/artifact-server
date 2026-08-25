import path from "node:path";

import {Option, type Command} from "commander";
import {currentCliInvocation} from "./current-cli-invocation.js";
import {openSystemBrowser} from "./cli-oauth-client.js";
import {ensureManagedLocalService} from "./local-service-manager.js";

interface OpenManagementOptions {
  readonly data: string;
}

/** Add the local Artifact Server opener. */
export function configureOpenManagementCommand(
  program: Command,
  defaultDataDirectory: string,
): void {
  program.command("open")
    .description("Open the local Artifact Server application.")
    .addOption(
      new Option("--data <directory>", "persistent data directory")
        .default(defaultDataDirectory),
    )
    .action(async (options: OpenManagementOptions) => {
      const dataDirectory = path.resolve(options.data);
      const origin = (await ensureManagedLocalService(
        dataDirectory,
        currentCliInvocation(),
      )).origin;
      await openSystemBrowser(new URL(origin), process.env);
      process.stdout.write("Opened the local Artifact Server application.\n");
    });
}
