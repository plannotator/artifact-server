import path from "node:path";

import {Option, type Command} from "commander";
import {z} from "zod";

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

const localBrowserLoginResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  token: z.string().min(32).max(200),
}).strict();

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
      const issueResponse = await fetch(new URL("/auth/local", origin), {
        headers: {Authorization: `Bearer ${browserCredential}`},
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
      if (!issueResponse.ok) {
        throw new Error(
          "The local Artifact Server did not issue a browser login.",
        );
      }
      const issued = localBrowserLoginResponseSchema.parse(
        await issueResponse.json(),
      );
      const login = new URL("/auth/local", origin);
      login.searchParams.set("token", issued.token);
      await openSystemBrowser(login, process.env);
      process.stdout.write("Opened the local Artifact Server management application.\n");
    });
}
