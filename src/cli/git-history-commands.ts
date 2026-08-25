import {spawn} from "node:child_process";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {type Command, Option} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {
  resolveCliServerConnection,
  type CliServerConnection,
  type CliServerConnectionOptions,
} from "./cli-server-connection.js";
import {readCompactInstallation} from "../lifecycle/compact-installation.js";
import {runCliEffect} from "./run-cli-effect.js";
import {
  configuredNodeGitHistory,
  loadNodeGitHistoryConfiguration,
} from "../git-history/node-git-history-configuration.js";
import {CloudflareArtifactsGitHistoryProvider} from
  "../git-history/cloudflare-artifacts-git-history-provider.js";
import {
  applyGitHistoryPurge,
  planGitHistoryPurge,
  type GitHistoryPurgeStore,
} from "../git-history/git-history-purge.js";
import type {GitHistoryProviderIdentityStore} from
  "../git-history/git-history-provider-identity.js";
import {SqliteArtifactRepository} from
  "../storage/sqlite-artifact-repository.js";
import {SqliteGitHistoryProviderIdentityStore} from
  "../storage/sqlite-git-history-provider-identity-store.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {PostgresArtifactRepository} from
  "../storage/postgres-artifact-repository.js";
import {PostgresGitHistoryProviderIdentityStore} from
  "../storage/postgres-git-history-provider-identity-store.js";
import {parseExternalMigrationConfiguration} from
  "../lifecycle/runtime-configuration.js";

const cloneCredentialSchema = z.object({
  defaultBranch: z.literal("main"),
  expiresAt: z.string(),
  remote: z.url(),
  token: z.string().min(1),
}).strict();
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({
      id: z.string(),
      name: z.string(),
      projectId: z.string(),
    }).passthrough(),
  }).passthrough()),
  nextCursor: z.string().nullable(),
}).strict();

interface HistoryConnectionOptions extends CliServerConnectionOptions {}

interface CloneOptions extends HistoryConnectionOptions {
  readonly project: string;
}

interface CheckoutProjectOptions extends HistoryConnectionOptions {
  readonly concurrency: string;
}

interface PurgeOptions {
  readonly apply?: boolean;
  readonly confirmInstallation?: string;
  readonly data: string;
  readonly mode: "compact" | "external-storage";
  readonly pageSize: string;
  readonly plan?: boolean;
}

export interface GitHistoryCommandOptions {
  readonly defaultProfileDirectory: string;
}

/** Register member-facing, credential-safe Git history checkout commands. */
export function configureGitHistoryCommands(
  program: Command,
  commandOptions: GitHistoryCommandOptions,
): void {
  const history = program.command("history")
    .description("Clone optional Git-backed artifact history.");
  history.command("clone")
    .description("Clone one artifact's derived version history.")
    .requiredOption("--project <id>", "project ID")
    .argument("<artifact>", "artifact ID")
    .argument("[directory]", "destination directory")
    .addOption(serverOption())
    .addOption(dataOption())
    .addOption(tokenFileOption())
    .addOption(profileOption())
    .addOption(profileDataOption(commandOptions.defaultProfileDirectory))
    .action(async (
      artifactId: string,
      directory: string | undefined,
      options: CloneOptions,
    ) => {
      const connection = await resolveCliServerConnection(options, "history");
      const destination = path.resolve(directory ?? artifactId);
      const result = await cloneArtifactHistory(
        connection,
        options.project,
        artifactId,
        destination,
      );
      console.log(JSON.stringify(result, null, 2));
    });

  history.command("checkout-project")
    .description("Clone every provisioned artifact history in one project.")
    .argument("<project>", "project ID")
    .argument("[directory]", "destination directory")
    .addOption(serverOption())
    .addOption(dataOption())
    .addOption(tokenFileOption())
    .addOption(profileOption())
    .addOption(profileDataOption(commandOptions.defaultProfileDirectory))
    .addOption(
      new Option("--concurrency <count>", "maximum simultaneous clones")
        .default("3"),
    )
    .action(async (
      projectId: string,
      directory: string | undefined,
      options: CheckoutProjectOptions,
    ) => {
      const concurrency = parseConcurrency(options.concurrency);
      const connection = await resolveCliServerConnection(options, "history");
      const destination = path.resolve(directory ?? projectId);
      await mkdir(destination, {recursive: true, mode: 0o700});
      const artifacts = await listProjectArtifacts(connection, projectId);
      const results = await cloneProjectArtifacts(
        connection,
        projectId,
        destination,
        artifacts,
        concurrency,
      );
      const manifest = {
        artifacts: results.map((result) => ({
          artifactId: result.artifactId,
          directory: result.directory,
          status: result.status,
        })),
        projectId,
        schemaVersion: 1,
      };
      const metadataDirectory = path.join(destination, ".artifactserver");
      await mkdir(metadataDirectory, {recursive: true, mode: 0o700});
      await writeFile(
        path.join(metadataDirectory, "project.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        {encoding: "utf8", mode: 0o600},
      );
      console.log(JSON.stringify(manifest, null, 2));
    });

  history.command("purge")
    .description("Plan or apply permanent removal of derived Git repositories.")
    .option("--plan", "read the persisted purge inventory without provider calls")
    .option("--apply", "delete every persisted repository coordinate")
    .option(
      "--confirm-installation <id>",
      "exact installation ID required by --apply",
    )
    .addOption(
      new Option("--mode <mode>", "storage mode")
        .choices(["compact", "external-storage"])
        .default("compact"),
    )
    .addOption(
      new Option("--data <directory>", "compact data directory")
        .default(".artifact-server"),
    )
    .addOption(
      new Option("--page-size <count>", "repositories per durable apply page")
        .default("25"),
    )
    .action(async (options: PurgeOptions) => {
      requireOnePurgeMode(options);
      const resources = await openPurgeResources(options);
      try {
        const persistedIdentity = await runCliEffect(resources.identity.read());
        if (persistedIdentity === null) {
          throw new Error("This installation has no persisted Git provider identity.");
        }
        if (options.plan === true) {
          console.log(JSON.stringify(await planGitHistoryPurge({
            installationId: resources.installationId,
            persistedIdentity,
            store: resources.store,
          }), null, 2));
          return;
        }
        const confirmation = options.confirmInstallation?.trim() ?? "";
        if (confirmation === "") {
          throw new Error("--apply requires --confirm-installation <installation-id>.");
        }
        const configuration = await runCliEffect(
          loadNodeGitHistoryConfiguration(process.env),
        );
        const configured = configuredNodeGitHistory(configuration);
        if (configured === null) {
          throw new Error(
            "Git history must be configured with the provider that owns these repositories.",
          );
        }
        const provider = new CloudflareArtifactsGitHistoryProvider({
          apiToken: configured.apiToken,
          identity: configured.identity,
        });
        console.log(JSON.stringify(await applyGitHistoryPurge({
          configuredIdentity: configured.identity,
          confirmInstallationId: confirmation,
          installationId: resources.installationId,
          pageSize: parsePurgePageSize(options.pageSize),
          persistedIdentity,
          provider,
          store: resources.store,
        }), null, 2));
      } finally {
        await resources.close();
      }
    });
}

interface PurgeResources {
  readonly close: () => Promise<void>;
  readonly identity: GitHistoryProviderIdentityStore;
  readonly installationId: string;
  readonly store: GitHistoryPurgeStore;
}

async function openPurgeResources(options: PurgeOptions): Promise<PurgeResources> {
  if (options.mode === "compact") {
    const dataDirectory = path.resolve(options.data);
    const installation = await runCliEffect(readCompactInstallation(dataDirectory));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    const store = new SqliteArtifactRepository(
      databasePath,
      installation.installationId,
    );
    const identity = new SqliteGitHistoryProviderIdentityStore(
      databasePath,
      installation.installationId,
    );
    return {
      close: async () => {
        identity.close();
        store.close();
      },
      identity,
      installationId: installation.installationId,
      store,
    };
  }
  const configuration = await runCliEffect(
    parseExternalMigrationConfiguration(process.env),
  );
  const database = await PostgresDatabase.open({
    applicationName: `artifact-server-git-history-purge:${configuration.installationId}`,
    maxConnections: 2,
    url: configuration.databaseUrl,
  }, "validate");
  try {
    const store = await PostgresArtifactRepository.open(
      database,
      configuration.installationId,
    );
    const identity = new PostgresGitHistoryProviderIdentityStore(
      database,
      configuration.installationId,
    );
    return {
      close: () => database.close(),
      identity,
      installationId: configuration.installationId,
      store,
    };
  } catch (cause) {
    await database.close();
    throw cause;
  }
}

function requireOnePurgeMode(options: PurgeOptions): void {
  if ((options.plan === true) === (options.apply === true)) {
    throw new Error("Choose exactly one of --plan or --apply.");
  }
}

function parsePurgePageSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--page-size must be an integer from 1 through 100.");
  }
  return parsed;
}

interface ProjectArtifact {
  readonly id: string;
  readonly name: string;
}

interface CheckoutResult {
  readonly artifactId: string;
  readonly directory: string;
  readonly status: "cloned" | "history-unavailable";
}

async function listProjectArtifacts(
  connection: CliServerConnection,
  projectId: string,
  cursor?: string,
  accumulated: readonly ProjectArtifact[] = [],
): Promise<readonly ProjectArtifact[]> {
  const query = new URLSearchParams({limit: "100", project: projectId});
  if (cursor !== undefined) query.set("cursor", cursor);
  const response = await authenticatedFetch(
    connection,
    `/api/v1/artifacts?${query.toString()}`,
    {method: "GET"},
  );
  const page = artifactPageSchema.parse(await response.json());
  const next = [
    ...accumulated,
    ...page.artifacts.map((item) => ({
      id: item.artifact.id,
      name: item.artifact.name,
    })),
  ];
  return page.nextCursor === null
    ? next
    : listProjectArtifacts(connection, projectId, page.nextCursor, next);
}

async function cloneProjectArtifacts(
  connection: CliServerConnection,
  projectId: string,
  destination: string,
  artifacts: readonly ProjectArtifact[],
  concurrency: number,
  index = 0,
  accumulated: readonly CheckoutResult[] = [],
): Promise<readonly CheckoutResult[]> {
  const batch = artifacts.slice(index, index + concurrency);
  if (batch.length === 0) return accumulated;
  const completed = await Promise.all(batch.map(async (artifact) => {
    const artifactDirectory = path.join(destination, artifact.id);
    try {
      await cloneArtifactHistory(
        connection,
        projectId,
        artifact.id,
        artifactDirectory,
      );
      return {
        artifactId: artifact.id,
        directory: artifactDirectory,
        status: "cloned" as const,
      };
    } catch (cause) {
      if (cause instanceof GitHistoryUnavailableError) {
        return {
          artifactId: artifact.id,
          directory: artifactDirectory,
          status: "history-unavailable" as const,
        };
      }
      throw cause;
    }
  }));
  return cloneProjectArtifacts(
    connection,
    projectId,
    destination,
    artifacts,
    concurrency,
    index + batch.length,
    [...accumulated, ...completed],
  );
}

async function cloneArtifactHistory(
  connection: CliServerConnection,
  projectId: string,
  artifactId: string,
  destination: string,
): Promise<{
  readonly artifactId: string;
  readonly defaultBranch: "main";
  readonly directory: string;
  readonly expiresAt: string;
  readonly projectId: string;
}> {
  const response = await authenticatedFetch(
    connection,
    `/api/v1/projects/${encodeURIComponent(projectId)}` +
      `/artifacts/${encodeURIComponent(artifactId)}/history/clone-token`,
    {
      body: JSON.stringify({ttlSeconds: 900}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    },
    true,
  );
  if (response.status === 404) throw new GitHistoryUnavailableError();
  requireSuccessfulResponse(response);
  const credential = cloneCredentialSchema.parse(await response.json());
  await runGitClone(credential, destination);
  return {
    artifactId,
    defaultBranch: credential.defaultBranch,
    directory: destination,
    expiresAt: credential.expiresAt,
    projectId,
  };
}

async function authenticatedFetch(
  connection: CliServerConnection,
  route: string,
  init: RequestInit,
  allowNotFound = false,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${Redacted.value(connection.apiToken)}`);
  const response = await fetch(new URL(route, connection.origin), {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!allowNotFound || response.status !== 404) requireSuccessfulResponse(response);
  return response;
}

function requireSuccessfulResponse(response: Response): void {
  if (!response.ok) {
    throw new Error(`Artifact Server returned HTTP ${response.status}.`);
  }
}

async function runGitClone(
  credential: z.infer<typeof cloneCredentialSchema>,
  destination: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [
      "clone",
      "--branch",
      credential.defaultBranch,
      "--single-branch",
      credential.remote,
      destination,
    ], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.token}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `git clone failed${signal === null ? ` with exit code ${code}` : ` after ${signal}`}.`,
      ));
    });
  });
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error("--concurrency must be an integer from 1 through 8.");
  }
  return parsed;
}

function serverOption(): Option {
  return new Option("--server <origin>", "Artifact Server origin")
    .env("ARTIFACT_SERVER_URL");
}

function dataOption(): Option {
  return new Option("--data <directory>", "local Artifact Server data directory")
    .default(".artifact-server");
}

function tokenFileOption(): Option {
  return new Option(
    "--token-file <path>",
    "file containing an Artifact Server API token",
  );
}

function profileOption(): Option {
  return new Option("--profile <name>", "saved Artifact Server profile");
}

function profileDataOption(defaultDirectory: string): Option {
  return new Option("--profile-data <directory>", "user-local CLI profile directory")
    .default(defaultDirectory)
    .env("ARTIFACT_SERVER_HOME");
}

class GitHistoryUnavailableError extends Error {}
