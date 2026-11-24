import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import path from "node:path";

import {type Command, Option} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {
  type CliServerConnection, type CliServerConnectionOptions, resolveCliServerConnection,
} from "./cli-server-connection.js";

interface LinkFolderOptions extends CliServerConnectionOptions {
  readonly folder?: string;
  readonly idempotencyKey?: string;
  readonly ignore?: readonly string[];
  readonly name?: string;
  readonly pause?: boolean;
  readonly project?: string;
  readonly resume?: boolean;
  readonly scan?: boolean;
  readonly status?: boolean;
  readonly unlink?: boolean;
}

const folderLinkSchema = z.object({
  id: z.string(),
  path: z.string(),
  revision: z.number().int(),
}).loose();
const linkListSchema = z.object({folderLinks: z.array(folderLinkSchema)});
const projectsSchema = z.object({
  projects: z.array(z.object({id: z.string(), archivedAt: z.string().nullable()})),
});
const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()})});
const jsonSchema = z.json();

const capabilityUnavailableExplanation =
  "This server does not link folders. Linked folders work only on a local Artifact Server started with ARTIFACT_SERVER_LINKED_FILES=on and reached on its loopback address.";

/**
 * Add `link-folder` and `capture` to the Artifact Server CLI. The server reads
 * the directory itself, so paths are resolved to absolute paths here; nothing
 * on disk is ever written by either command.
 */
export function configureLinkFolderCommands(program: Command, profileDirectory: string): void {
  const configure = (name: string, description: string) => program.command(name)
    .description(description)
    .argument("<directory>", "directory on this machine")
    .option("--project <id>", "project ID; defaults to the only active project")
    .addOption(new Option("--server <origin>", "Artifact Server origin").env("ARTIFACT_SERVER_URL"))
    .option("--data <directory>", "local Artifact Server data directory", ".artifact-server")
    .option("--token-file <path>", "file containing an Artifact Server API token")
    .option("--profile <name>", "saved Artifact Server profile")
    .option("--idempotency-key <key>", "reuse this key when retrying")
    .addOption(new Option("--profile-data <directory>", "CLI profile directory")
      .default(profileDirectory).env("ARTIFACT_SERVER_HOME"));

  configure("link-folder", "Link a directory to an Artifact Server folder, or manage an existing folder link.")
    .option("--folder <folder-id>", "existing folder to link; defaults to a new folder at the project root")
    .option("--name <name>", "name of the new folder")
    .option("--ignore <pattern...>", "per-link ignore patterns (gitignore syntax)")
    .option("--status", "show the link and its pending inventory")
    .option("--scan", "rescan the linked directory now")
    .option("--pause", "pause watching and scheduled scans")
    .option("--resume", "resume a paused link")
    .option("--unlink", "remove the link; captured artifacts stay linked individually")
    .action(async (directory: string, options: LinkFolderOptions) => {
      const {connection, projectId} = await linkConnection(options);
      const absolute = path.resolve(directory);
      const managing = options.status === true || options.scan === true || options.pause === true
        || options.resume === true || options.unlink === true;
      if (!managing) {
        print(await request(connection, `/api/v1/projects/${encodeURIComponent(projectId)}/folder-links`, {
          body: JSON.stringify({
            folderId: options.folder ?? null,
            ignore: options.ignore ?? [],
            newFolderName: options.name ?? null,
            path: absolute,
          }),
          headers: {"Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey ?? randomUUID()},
          method: "POST",
        }));
        return;
      }
      const link = await findLink(connection, projectId, absolute);
      const linkPath = `/api/v1/folder-links/${encodeURIComponent(link.id)}`;
      if (options.scan === true) {
        print(await request(connection, `${linkPath}/scan`, {method: "POST"}));
      } else if (options.pause === true || options.resume === true) {
        print(await request(connection, linkPath, {
          body: JSON.stringify({expectedRevision: link.revision, paused: options.pause === true}),
          headers: {"Content-Type": "application/json"},
          method: "PATCH",
        }));
      } else if (options.unlink === true) {
        print(await request(connection, `${linkPath}?expectedRevision=${link.revision}`, {method: "DELETE"}));
      } else {
        const current = await request(connection, linkPath);
        const inventory = await request(connection, `${linkPath}/inventory?pending=true`);
        print({folderLink: current, pending: inventory});
      }
    });

  configure("capture", "Capture every pending file in a linked directory as linked artifacts or new versions.")
    .action(async (directory: string, options: LinkFolderOptions) => {
      const {connection, projectId} = await linkConnection(options);
      const link = await findLink(connection, projectId, path.resolve(directory));
      print(await request(connection, `/api/v1/folder-links/${encodeURIComponent(link.id)}/capture`, {
        body: JSON.stringify({all: true}),
        headers: {"Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey ?? randomUUID()},
        method: "POST",
      }));
    });
}

async function linkConnection(options: LinkFolderOptions) {
  const connection = await resolveCliServerConnection(options, "link");
  if (options.project !== undefined) return {connection, projectId: options.project};
  const response = projectsSchema.parse(await request(connection, "/api/v1/projects"));
  const only = response.projects.filter(({archivedAt}) => archivedAt === null);
  const project = only.length === 1 ? only[0] : undefined;
  if (project === undefined) throw new Error("Pass --project to select a project.");
  return {connection, projectId: project.id};
}

async function findLink(connection: CliServerConnection, projectId: string, directory: string) {
  let canonical = directory;
  try {
    canonical = await realpath(directory);
  } catch {
    // An unavailable directory may still have a link recorded by its old path.
  }
  const links = linkListSchema.parse(await request(
    connection,
    `/api/v1/projects/${encodeURIComponent(projectId)}/folder-links`,
  ));
  const link = links.folderLinks.find((candidate) => candidate.path === canonical || candidate.path === directory);
  if (link === undefined) throw new Error("FOLDER_LINK_NOT_FOUND: No folder link names that directory.");
  return link;
}

function print(value: z.infer<typeof jsonSchema>): void {
  console.log(JSON.stringify(value, null, 2));
}

async function request(
  connection: CliServerConnection,
  pathname: string,
  init?: RequestInit,
): Promise<z.infer<typeof jsonSchema>> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${Redacted.value(connection.apiToken)}`);
  const response = await fetch(new URL(pathname, connection.origin), {...init, headers, redirect: "error"});
  const data: unknown = await response.json();
  if (!response.ok) {
    const decoded = failureSchema.safeParse(data);
    if (decoded.success && decoded.data.error.code === "CAPABILITY_UNAVAILABLE") {
      throw new Error(capabilityUnavailableExplanation);
    }
    throw new Error(decoded.success
      ? `${decoded.data.error.code}: ${decoded.data.error.message}`
      : `The folder link request failed (HTTP ${response.status}).`);
  }
  return jsonSchema.parse(data);
}
