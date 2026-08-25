import path from "node:path";

import {z} from "zod";

import {connectMcpClient} from "../../../src/cli/mcp-client-registrations.js";

const argumentsSchema = z.tuple([
  z.enum(["codex", "claude", "cursor", "vscode"]),
  z.string().min(1),
]);
const [client, dataDirectory] = argumentsSchema.parse(process.argv.slice(2));

await connectMcpClient(
  client,
  path.resolve(dataDirectory),
  {
    command: "/opt/artifact-server/node",
    prefixArguments: ["/opt/artifact-server/main.js"],
  },
);
