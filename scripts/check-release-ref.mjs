import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {z} from "zod";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  throw new Error(`Release reference check failed: ${message}`);
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} requires a value.`);
  }
  return value;
}

const dryRun = process.argv.includes("--dry-run");
const tag = argumentValue("--tag");
const mainReference = argumentValue("--main-ref") ?? "origin/main";
const expectedArguments = new Set([
  "--dry-run",
  "--tag",
  "--main-ref",
  tag,
  mainReference,
]);
for (const argument of process.argv.slice(2)) {
  if (!expectedArguments.has(argument)) fail(`unknown argument ${argument}.`);
}
if (dryRun === (tag !== null)) {
  fail("choose exactly one of --dry-run or --tag vX.Y.Z.");
}

const packageMetadata = z.object({version: z.string().min(1)}).parse(JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
));
const expectedTag = `v${packageMetadata.version}`;

if (dryRun) {
  process.stdout.write(`${git("rev-parse", "HEAD")}\n`);
  process.stdout.write(`Dry run uses the v${packageMetadata.version} release contract.\n`);
} else {
  if (tag !== expectedTag) {
    fail(`tag ${tag} does not match package version ${packageMetadata.version}.`);
  }
  if (git("cat-file", "-t", tag) !== "tag") {
    fail(`${tag} is not an annotated tag.`);
  }

  const taggedCommit = git("rev-parse", `${tag}^{commit}`);
  const firstParentCommits = new Set(
    git("rev-list", "--first-parent", mainReference).split("\n"),
  );
  if (!firstParentCommits.has(taggedCommit)) {
    fail(`${tag} does not belong to ${mainReference}'s first-parent history.`);
  }

  process.stdout.write(`${taggedCommit}\n`);
  process.stdout.write(`${tag} is annotated and belongs to ${mainReference}.\n`);
}
