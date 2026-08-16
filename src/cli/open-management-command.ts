import path from "node:path";

import {Option, type Command} from "commander";

import {
  loadOrCreateLocalCredential,
  localCredentialFiles,
} from "../local/local-credentials.js";
import {currentCliInvocation} from "./current-cli-invocation.js";
import {openSystemBrowser} from "./cli-oauth-client.js";
import {ensureManagedLocalService} from "./local-service-manager.js";

interface OpenManagementOptions {
  readonly data: string;
}

/** Add the credential-hidden local management-application opener. */
export function configureOpenManagementCommand(
  program: Command,
  defaultDataDirectory: string,
): void {
  program.command("open")
    .description("Open the local Artifact Server management application.")
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
      const browserCredential = await loadOrCreateLocalCredential(
        dataDirectory,
        localCredentialFiles.browser,
      );
      const login = new URL("/auth/local", origin);
      login.searchParams.set("token", browserCredential);
      await openSystemBrowser(login, process.env);
      process.stdout.write("Opened the local Artifact Server management application.\n");
    });
}
