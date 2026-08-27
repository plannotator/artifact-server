import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {z} from "zod";

const imageRepository = "ghcr.io/plannotator/artifact-server";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const semanticVersion = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  "must be a semantic version",
);
const packageSchema = z.object({
  bin: z.record(z.string(), z.string()).optional(),
  license: z.string().optional(),
  name: z.string().min(1),
  private: z.boolean().optional(),
  publishConfig: z.object({access: z.string()}).optional(),
  version: semanticVersion,
});

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readPackage(relativePath) {
  return packageSchema.parse(JSON.parse(await readText(relativePath)));
}

function fail(message) {
  throw new Error(`Release version check failed: ${message}`);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}

function yamlValue(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, "mu"));
  if (match?.[1] === undefined) fail(`could not read ${key} from YAML.`);
  return match[1];
}

function parseTagArgument() {
  const cliArguments = process.argv.slice(2);
  if (cliArguments.length === 0) return null;
  if (cliArguments.length !== 2 || cliArguments[0] !== "--tag") {
    fail("usage is check-release-version.mjs [--tag vX.Y.Z].");
  }
  return cliArguments[1] ?? null;
}

const rootPackage = await readPackage("package.json");
if (rootPackage.version === "0.0.0") fail("root package version is still a placeholder.");
expectEqual(rootPackage.private, true, "root package private flag");
expectEqual(rootPackage.license, "AGPL-3.0-only", "root package license");
expectEqual(rootPackage.bin?.artifactserver, "./dist/cli/main.js", "root CLI entry");

const publicPackages = [
  ["integrations/pi/package.json", "@plannotator/artifact-server-pi"],
  ["integrations/opencode/package.json", "@plannotator/artifact-server-opencode"],
  [
    "integrations/claude-channel/package.json",
    "@plannotator/artifact-server-claude-channel",
  ],
];
for (const [relativePath, expectedName] of publicPackages) {
  // Sequential reads keep failure output in the declared release-surface order.
  // eslint-disable-next-line no-await-in-loop
  const packageMetadata = await readPackage(relativePath);
  expectEqual(packageMetadata.name, expectedName, `${relativePath} name`);
  expectEqual(packageMetadata.version, rootPackage.version, `${relativePath} version`);
  expectEqual(packageMetadata.license, "MIT", `${relativePath} license`);
  expectEqual(packageMetadata.publishConfig?.access, "public", `${relativePath} access`);
  if (packageMetadata.private === true) fail(`${relativePath} must be publishable.`);
}

const piPackage = JSON.parse(await readText("integrations/pi/package.json"));
expectEqual(
  piPackage.peerDependencies?.typebox,
  "^1.3.7",
  "Pi typebox peer range",
);

const chart = await readText("packaging/helm/artifact-server/Chart.yaml");
const parsedChartVersion = semanticVersion.parse(yamlValue(chart, "version"));
if (parsedChartVersion === "0.0.0") fail("Helm chart version is still a placeholder.");
expectEqual(yamlValue(chart, "appVersion"), rootPackage.version, "Helm appVersion");

const values = await readText("packaging/helm/artifact-server/values.yaml");
const imageBlock = values.match(/^image:\s*\n(?<body>(?:^  .+\n?)+)/mu)?.groups?.body;
if (imageBlock === undefined) fail("could not read the Helm image block.");
expectEqual(yamlValue(imageBlock, "  repository"), imageRepository, "Helm image repository");
expectEqual(yamlValue(imageBlock, "  tag"), rootPackage.version, "Helm image tag");

const mcpSource = await readText("src/mcp/artifact-mcp-server.ts");
expectEqual(
  mcpSource.match(/const serverVersion = "([^"]+)";/u)?.[1],
  rootPackage.version,
  "MCP server version",
);

const channelSource = await readText("integrations/claude-channel/index.ts");
expectEqual(
  channelSource.match(/const channelVersion = "([^"]+)";/u)?.[1],
  rootPackage.version,
  "Claude channel protocol version",
);

const imageBuilder = await readText("scripts/build-oci-image.sh");
if (!imageBuilder.includes(`${imageRepository}:$artifactserver_version`)) {
  fail("the OCI builder does not default to the release GHCR repository.");
}

const explicitTag = parseTagArgument();
const environmentTag = process.env["GITHUB_REF_TYPE"] === "tag"
  ? process.env["GITHUB_REF_NAME"] ?? null
  : null;
const tag = explicitTag ?? environmentTag;
if (tag !== null) expectEqual(tag, `v${rootPackage.version}`, "release tag");

process.stdout.write(`Release metadata is consistent for v${rootPackage.version}.\n`);
