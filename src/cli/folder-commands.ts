import {randomUUID} from "node:crypto";

import {type Command, Option} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {normalizeArtifactSearchText} from "../application/artifact-tags.js";
import {folderIdPattern} from "../application/folders.js";
import {
  type CliServerConnection, type CliServerConnectionOptions, resolveCliServerConnection,
} from "./cli-server-connection.js";

interface FolderOptions extends CliServerConnectionOptions {
  readonly project?: string;
  readonly idempotencyKey?: string;
}

interface PlacementOptions extends FolderOptions {
  readonly expectedRevision?: string;
  readonly expectedCurrentVersion?: string;
}

const projectsSchema = z.object({
  projects: z.array(z.object({id: z.string(), archivedAt: z.string().nullable()})),
});
const folderLookupPage = z.object({
  folders: z.array(z.object({id: z.string(), nameKey: z.string()})),
  nextCursor: z.string().nullable(),
});
const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()})});

export function configureFolderCommands(program: Command, profileDirectory: string): void {
  const configure = (name: string, description: string) => program.command(name)
    .description(description)
    .option("--project <id>", "project ID; defaults to the only active project")
    .addOption(new Option("--server <origin>", "Artifact Server origin").env("ARTIFACT_SERVER_URL"))
    .option("--data <directory>", "local Artifact Server data directory", ".artifact-server")
    .option("--token-file <path>", "file containing an Artifact Server API token")
    .option("--profile <name>", "saved Artifact Server profile")
    .addOption(new Option("--profile-data <directory>", "CLI profile directory")
      .default(profileDirectory).env("ARTIFACT_SERVER_HOME"));

  configure("ls", "List a project's root or the contents of one folder.")
    .argument("[path-or-id]", "project-relative folder names, folder ID, or root", "root")
    .option("--cursor <cursor>", "continue a paged listing")
    .action(async (target: string, options: FolderOptions & {readonly cursor?: string}) => {
      const {connection, projectId} = await folderConnection(options);
      const folderId = await resolveFolder(connection, projectId, target);
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      await printRequest(connection, `${folderPath(projectId, folderId)}?${query}`);
    });

  configure("mkdir", "Create a folder in a project.")
    .argument("<name>")
    .option("--parent <folder-id>", "parent folder ID or root", "root")
    .option("--id <folder-id>", "client-generated stable folder ID")
    .option("--idempotency-key <key>", "reuse this key when retrying")
    .action(async (name: string, options: FolderOptions & {readonly parent: string; readonly id?: string}) => {
      const {connection, projectId} = await folderConnection(options);
      await printRequest(connection, folderPath(projectId), mutation(options, "POST", {
        id: options.id, name, parentFolderId: rootAsNull(options.parent),
      }));
    });

  placementOptions(configure("mv", "Move an artifact or folder, optionally into another project."))
    .argument("<id>", "artifact or folder ID")
    .argument("<destination>", "destination folder ID or root, in the destination project")
    .option("--to-project <id>", "move into this project, keeping every ID, version, comment, and link")
    .action(async (id: string, destination: string, options: PlacementOptions & {readonly toProject?: string}) => {
      const {connection, projectId} = await folderConnection(options);
      const folderId = rootAsNull(destination);
      const toProjectId = options.toProject;
      if (folderIdPattern.test(id) && toProjectId !== undefined) {
        await printRequest(connection, `${folderPath(projectId, id)}/move-to-project`, mutation(options, "POST", {
          toProjectId, toParentFolderId: folderId, expectedRevision: revision(options),
        }));
      } else if (folderIdPattern.test(id)) {
        await printRequest(connection, folderPath(projectId, id), mutation(options, "PATCH", {
          parentFolderId: folderId, expectedRevision: revision(options),
        }));
      } else {
        const move = {toFolderId: folderId, expectedCurrentVersionId: currentVersion(options)};
        await printRequest(connection, artifactPath(projectId, id, "move"),
          mutation(options, "POST", toProjectId === undefined ? move : {...move, toProjectId}));
      }
    });

  placementOptions(configure("rename", "Rename an artifact or folder."))
    .argument("<id>", "artifact or folder ID")
    .argument("<name>")
    .action(async (id: string, name: string, options: PlacementOptions) => {
      const {connection, projectId} = await folderConnection(options);
      if (folderIdPattern.test(id)) {
        await printRequest(connection, folderPath(projectId, id), mutation(options, "PATCH", {
          name, expectedRevision: revision(options),
        }));
      } else {
        await printRequest(connection, artifactPath(projectId, id, "name"), mutation(options, "PATCH", {
          name, expectedCurrentVersionId: currentVersion(options),
        }));
      }
    });

  configure("rmdir", "Move a folder and its contents to the trash.")
    .argument("<folder-id>")
    .requiredOption("--expected-revision <number>", "revision returned by ls")
    .option("--idempotency-key <key>", "reuse this key when retrying")
    .action(async (id: string, options: PlacementOptions) => {
      const {connection, projectId} = await folderConnection(options);
      await printRequest(connection, `${folderPath(projectId, id)}?expectedRevision=${revision(options)}`,
        mutation(options, "DELETE"));
    });

  placementOptions(configure("rm", "Move an artifact, or with -r a folder and its contents, to the trash."))
    .argument("<id>", "artifact or folder ID")
    .option("-r, --recursive", "trash a folder and everything in it")
    .action(async (id: string, options: PlacementOptions & {readonly recursive?: boolean}) => {
      const {connection, projectId} = await folderConnection(options);
      if (folderIdPattern.test(id)) {
        if (options.recursive !== true) throw new Error("Pass -r to move a folder and its contents to the trash.");
        await printRequest(connection, `${folderPath(projectId, id)}?expectedRevision=${revision(options)}`,
          mutation(options, "DELETE"));
        return;
      }
      await printRequest(connection, `/api/v1/artifacts/${encodeURIComponent(id)}?${new URLSearchParams({projectId})}`,
        mutation(options, "DELETE", {expectedCurrentVersionId: currentVersion(options)}));
    });

  const trash = program.command("trash").description("List, recover, or purge trashed artifacts and folders.");
  const configureTrash = (name: string, description: string) => trash.command(name)
    .description(description)
    .option("--project <id>", "project ID; defaults to the only active project")
    .addOption(new Option("--server <origin>", "Artifact Server origin").env("ARTIFACT_SERVER_URL"))
    .option("--data <directory>", "local Artifact Server data directory", ".artifact-server")
    .option("--token-file <path>", "file containing an Artifact Server API token")
    .option("--profile <name>", "saved Artifact Server profile")
    .addOption(new Option("--profile-data <directory>", "CLI profile directory")
      .default(profileDirectory).env("ARTIFACT_SERVER_HOME"));

  configureTrash("ls", "List trashed items across readable projects, newest first.")
    .option("--cursor <cursor>", "continue a paged listing")
    .action(async (options: FolderOptions & {readonly cursor?: string}) => {
      const connection = await resolveCliServerConnection(options, "folders");
      const query = new URLSearchParams();
      if (options.project !== undefined) query.set("projectId", options.project);
      if (options.cursor !== undefined) query.set("cursor", options.cursor);
      await printRequest(connection, `/api/v1/trash?${query}`);
    });

  configureTrash("recover", "Recover a trashed artifact or folder group.")
    .argument("<id>", "artifact or folder ID")
    .option("--name <name>", "new folder name when a sibling now uses the old one")
    .option("--idempotency-key <key>", "reuse this key when retrying")
    .action(async (id: string, options: FolderOptions & {readonly name?: string}) => {
      const {connection, projectId} = await folderConnection(options);
      await printRequest(connection, trashPath(projectId, id, "recover"), folderIdPattern.test(id)
        ? mutation(options, "POST", options.name === undefined ? {} : {name: options.name})
        : mutation(options, "POST"));
    });

  configureTrash("purge", "Permanently end recoverability of a trashed item. Frees no disk space yet.")
    .argument("<id>", "artifact or folder ID")
    .requiredOption("--confirm <name>", "the item's exact name")
    .option("--idempotency-key <key>", "reuse this key when retrying")
    .action(async (id: string, options: FolderOptions & {readonly confirm: string}) => {
      const {connection, projectId} = await folderConnection(options);
      await printRequest(connection, trashPath(projectId, id, "purge"), mutation(options, "POST", {confirm: options.confirm}));
    });
}

function trashPath(projectId: string, id: string, operation: "recover" | "purge"): string {
  return folderIdPattern.test(id)
    ? `${folderPath(projectId, id)}/${operation}`
    : `/api/v1/artifacts/${encodeURIComponent(id)}/${operation}?${new URLSearchParams({projectId})}`;
}

function placementOptions(command: Command): Command {
  return command
    .option("--expected-revision <number>", "required for a folder")
    .option("--expected-current-version <id>", "required for an artifact")
    .option("--idempotency-key <key>", "reuse this key when retrying");
}

function revision(options: PlacementOptions): number {
  return z.coerce.number().int().positive().parse(options.expectedRevision);
}

function currentVersion(options: PlacementOptions): string {
  if (options.expectedCurrentVersion === undefined) {
    throw new Error("Artifact placement requires --expected-current-version.");
  }
  return options.expectedCurrentVersion;
}

function folderPath(projectId: string, folderId?: string): string {
  const collection = `/api/v1/projects/${encodeURIComponent(projectId)}/folders`;
  return folderId === undefined ? collection : `${collection}/${encodeURIComponent(folderId)}`;
}

function artifactPath(projectId: string, id: string, operation: "move" | "name"): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/${operation}?${new URLSearchParams({projectId})}`;
}

async function resolveFolder(connection: CliServerConnection, projectId: string, target: string): Promise<string> {
  if (target === "root" || target === "/" || folderIdPattern.test(target)) return target === "/" ? "root" : target;
  const labels = target.replace(/^\.\//u, "").split("/");
  if (labels.some((label) => label === "" || label === "." || label === "..")) {
    throw new Error("Use a folder ID or a project-relative series of folder names.");
  }
  return labels.reduce(async (parent, label) => {
    const parentId = await parent;
    return lookupChild(connection, projectId, parentId, normalizeArtifactSearchText(label), null);
  }, Promise.resolve("root"));
}

async function lookupChild(
  connection: CliServerConnection, projectId: string, parentId: string, nameKey: string, cursor: string | null,
): Promise<string> {
  const query = new URLSearchParams({foldersOnly: "true"});
  if (cursor !== null) query.set("cursor", cursor);
  const page = folderLookupPage.parse(await request(connection, `${folderPath(projectId, parentId)}?${query}`));
  const folder = page.folders.find((child) => child.nameKey === nameKey);
  if (folder !== undefined) return folder.id;
  if (page.nextCursor !== null) return lookupChild(connection, projectId, parentId, nameKey, page.nextCursor);
  throw new Error("FOLDER_NOT_FOUND: The folder does not exist.");
}

function rootAsNull(id: string): string | null {
  return id === "root" ? null : id;
}

async function folderConnection(options: FolderOptions) {
  const connection = await resolveCliServerConnection(options, "folders");
  if (options.project !== undefined) return {connection, projectId: options.project};
  const response = projectsSchema.parse(await request(connection, "/api/v1/projects"));
  const active = response.projects.filter(({archivedAt}) => archivedAt === null);
  const only = active.length === 1 ? active[0] : undefined;
  if (only === undefined) throw new Error("Pass --project to select a project.");
  return {connection, projectId: only.id};
}

type FolderRequest =
  | {readonly id: string | undefined; readonly name: string; readonly parentFolderId: string | null}
  | {readonly name: string; readonly expectedRevision: number}
  | {readonly parentFolderId: string | null; readonly expectedRevision: number}
  | {readonly toFolderId: string | null; readonly expectedCurrentVersionId: string; readonly toProjectId?: string}
  | {readonly toProjectId: string; readonly toParentFolderId: string | null; readonly expectedRevision: number}
  | {readonly name: string; readonly expectedCurrentVersionId: string}
  | {readonly expectedCurrentVersionId: string}
  | {readonly name?: string}
  | {readonly confirm: string};

function mutation(options: FolderOptions, method: string, body?: FolderRequest): RequestInit {
  const init = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": options.idempotencyKey ?? randomUUID(),
    },
  };
  return body === undefined ? init : {...init, body: JSON.stringify(body)};
}

export async function printRequest(connection: CliServerConnection, path: string, init?: RequestInit): Promise<void> {
  console.log(JSON.stringify(await request(connection, path, init), null, 2));
}

const jsonSchema = z.json();

async function request(connection: CliServerConnection, path: string, init?: RequestInit): Promise<z.infer<typeof jsonSchema>> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${Redacted.value(connection.apiToken)}`);
  const response = await fetch(new URL(path, connection.origin), {...init, headers, redirect: "error"});
  const data: unknown = await response.json();
  if (!response.ok) {
    const decoded = failureSchema.safeParse(data);
    throw new Error(decoded.success
      ? `${decoded.data.error.code}: ${decoded.data.error.message}`
      : `The placement request failed (HTTP ${response.status}).`);
  }
  return jsonSchema.parse(data);
}
