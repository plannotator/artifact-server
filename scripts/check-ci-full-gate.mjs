import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {z} from "zod";

const packageDocument = z.object({
  scripts: z.record(z.string(), z.string()),
}).parse(JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
)));
const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

const iterationScript = packageDocument.scripts?.["verify:iteration"];
assert.ok(iterationScript, "package.json must define scripts.verify:iteration.");

const expectedCommands = iterationScript.split(" && ").map((command) =>
  command.trim()
);
assert.ok(
  expectedCommands.every((command) => /^pnpm [a-z][a-z0-9:-]*$/u.test(command)),
  "verify:iteration must remain an ordered list of direct pnpm commands.",
);

const workflowLines = workflow.split("\n");
const markerPrefix = "# full-gate-command: ";
const markedCommands = [];
for (const [index, line] of workflowLines.entries()) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(markerPrefix)) continue;
  const command = trimmed.slice(markerPrefix.length);
  markedCommands.push(command);
  const block = workflowLines.slice(index + 1, index + 5).map((entry) =>
    entry.trim()
  );
  assert.ok(
    block.includes(`run: ${command}`),
    `The full-gate marker for ${command} is not followed by its exact run step.`,
  );
}

assert.deepEqual(
  markedCommands,
  expectedCommands,
  "The CI full-gate command list drifted from scripts.verify:iteration.",
);

process.stdout.write(
  `Verified ${markedCommands.length} ordered full-gate commands against pnpm verify:iteration.\n`,
);
