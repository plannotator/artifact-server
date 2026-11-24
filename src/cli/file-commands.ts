import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";

import {type Command, Option} from "commander";
import {z} from "zod";

import {batchOperations} from "../core/batch.js";
import {fileKinds, fileLinkFilters, fileSorts} from "../core/file-catalog.js";
import {type CliServerConnectionOptions, resolveCliServerConnection} from "./cli-server-connection.js";
import {printRequest} from "./folder-commands.js";

interface FilesOptions extends CliServerConnectionOptions {
  readonly project: readonly string[];
  readonly folder?: string;
  readonly recursive: boolean;
  readonly kind: readonly string[];
  readonly tag: readonly string[];
  readonly linked?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly search?: string;
  readonly sort?: string;
  readonly direction?: string;
  readonly cursor?: string;
  readonly limit?: string;
  readonly facets?: boolean;
}

interface BatchOptions extends CliServerConnectionOptions {
  readonly items: string;
  readonly toFolder?: string;
  readonly toProject?: string;
  readonly tag: readonly string[];
  readonly confirm?: string;
  readonly idempotencyKey?: string;
}

/** Batch parameters the CLI sends; omitted fields keep the server defaults. */
interface BatchRequestParameters {
  toFolderId?: string | null;
  toProjectId?: string;
  tags?: readonly string[];
}

/** The batch request body, matching `POST /api/v1/batch`. */
interface BatchRequestBody {
  operation: string;
  items: readonly z.infer<ReturnType<typeof z.json>>[];
  params: BatchRequestParameters;
  idempotencyKey: string;
  confirm?: string;
}

const collect = (value: string, previous: readonly string[]) => [...previous, value];

/** `artifactserver files` and `artifactserver batch`: the overview and batch surfaces of FOV-001 and FLD-005. */
export function configureFileCommands(program: Command, profileDirectory: string): void {
  const connectionOptions = (command: Command) => command
    .addOption(new Option("--server <origin>", "Artifact Server origin").env("ARTIFACT_SERVER_URL"))
    .option("--data <directory>", "local Artifact Server data directory", ".artifact-server")
    .option("--token-file <path>", "file containing an Artifact Server API token")
    .option("--profile <name>", "saved Artifact Server profile")
    .addOption(new Option("--profile-data <directory>", "CLI profile directory")
      .default(profileDirectory).env("ARTIFACT_SERVER_HOME"));

  connectionOptions(program.command("files")
    .description("List files across projects with filters; repeat --project, --kind, and --tag to match any value.")
    .option("--project <id>", "limit to this project (repeatable)", collect, [])
    .option("--folder <folder-id>", "limit to this folder and, by default, its subfolders")
    .option("--no-recursive", "with --folder, list only that folder's direct files")
    .option("--kind <kind>", `file kind: ${fileKinds.join(", ")} (repeatable)`, collect, [])
    .option("--tag <tag>", "exact tag (repeatable)", collect, [])
    .addOption(new Option("--linked <state>", "linked-file state").choices(fileLinkFilters))
    .option("--created-after <instant>", "ISO 8601 instant")
    .option("--created-before <instant>", "ISO 8601 instant")
    .option("--updated-after <instant>", "ISO 8601 instant")
    .option("--updated-before <instant>", "ISO 8601 instant")
    .option("--search <text>", "name or exact tag")
    .addOption(new Option("--sort <field>", "sort field").choices(fileSorts))
    .addOption(new Option("--direction <direction>", "sort direction").choices(["asc", "desc"]))
    .option("--cursor <cursor>", "continue a paged listing")
    .option("--limit <count>", "page size, 1..100")
    .option("--facets", "print the facet counts for these filters instead of a page"))
    .action(async (options: FilesOptions) => {
      const connection = await resolveCliServerConnection(options, "folders");
      const query = new URLSearchParams();
      for (const projectId of options.project) query.append("projectId", projectId);
      for (const kind of options.kind) query.append("kind", kind);
      for (const tag of options.tag) query.append("tag", tag);
      const single = {
        folderId: options.folder,
        recursive: options.folder === undefined ? undefined : String(options.recursive),
        linked: options.linked,
        createdAfter: options.createdAfter,
        createdBefore: options.createdBefore,
        updatedAfter: options.updatedAfter,
        updatedBefore: options.updatedBefore,
        search: options.search,
        sort: options.sort,
        direction: options.direction,
        cursor: options.cursor,
        limit: options.limit,
      };
      for (const [name, value] of Object.entries(single)) if (value !== undefined) query.set(name, value);
      await printRequest(connection, `/api/v1/files${options.facets === true ? "/facets" : ""}?${query}`);
    });

  connectionOptions(program.command("batch")
    .description("Apply one operation to up to 100 artifacts or folders; each item succeeds or fails on its own.")
    .addArgument(program.createArgument("<operation>", "batch operation").choices(batchOperations))
    .requiredOption("--items <path>", "JSON file holding the item array, or - for standard input")
    .option("--to-folder <folder-id>", "move destination folder ID, or root")
    .option("--to-project <id>", "move into this project")
    .option("--tag <tag>", "tag to add or remove (repeatable)", collect, [])
    .option("--confirm <text>", "for purge: exactly \"purge <n> items\"")
    .option("--idempotency-key <key>", "reuse this key to replay the same batch"))
    .action(async (operation: string, options: BatchOptions) => {
      const connection = await resolveCliServerConnection(options, "folders");
      const raw = options.items === "-" ? await readStandardInput() : await readFile(options.items, "utf8");
      const items = z.array(z.json()).parse(JSON.parse(raw));
      const params: BatchRequestParameters = {};
      if (options.toFolder !== undefined) params.toFolderId = options.toFolder === "root" ? null : options.toFolder;
      if (options.toProject !== undefined) params.toProjectId = options.toProject;
      if (options.tag.length > 0) params.tags = options.tag;
      const body: BatchRequestBody = {operation, items, params, idempotencyKey: options.idempotencyKey ?? randomUUID()};
      if (options.confirm !== undefined) body.confirm = options.confirm;
      await printRequest(connection, "/api/v1/batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
      });
    });
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
