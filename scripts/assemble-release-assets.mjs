import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [inputDirectory, outputDirectory, version] = process.argv.slice(2);
if (inputDirectory === undefined || outputDirectory === undefined || version === undefined) {
  throw new Error(
    "Usage: assemble-release-assets.mjs <input-directory> <output-directory> <version>.",
  );
}

const expectedFiles = [
  `artifact-server-${version}-node.tar.gz`,
  `artifact-server-${version}-node.tar.gz.manifest.json`,
  `artifact-server-${version}-node.spdx.json`,
  `artifact-server-${version}-oci.manifest.json`,
  `artifact-server-${version}-oci-linux-amd64.spdx.json`,
  `artifact-server-${version}-oci-linux-arm64.spdx.json`,
  "image-reference.txt",
  `plannotator-artifact-server-claude-channel-${version}.spdx.json`,
  `plannotator-artifact-server-claude-channel-${version}.tgz`,
  `plannotator-artifact-server-opencode-${version}.spdx.json`,
  `plannotator-artifact-server-opencode-${version}.tgz`,
  `plannotator-artifact-server-pi-${version}.spdx.json`,
  `plannotator-artifact-server-pi-${version}.tgz`,
];

await mkdir(outputDirectory, {recursive: true});
const discoveredFiles = await findFiles(inputDirectory);
const copyOperations = expectedFiles.map((expectedFile) => {
  const candidates = discoveredFiles.filter((candidate) =>
    path.basename(candidate) === expectedFile
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one ${expectedFile} input, found ${candidates.length}.`,
    );
  }
  return copyFile(candidates[0], path.join(outputDirectory, expectedFile));
});
await Promise.all(copyOperations);

const unexpectedPublicFiles = (await readdir(outputDirectory))
  .filter((file) => file !== "SHA256SUMS" && !expectedFiles.includes(file));
if (unexpectedPublicFiles.length > 0) {
  throw new Error(
    `Release output contains unexpected files: ${unexpectedPublicFiles.join(", ")}.`,
  );
}

const checksumLines = await Promise.all(
  expectedFiles.toSorted((left, right) => left.localeCompare(right)).map(
    async (file) => `${await sha256(path.join(outputDirectory, file))}  ${file}`,
  ),
);
await writeFile(
  path.join(outputDirectory, "SHA256SUMS"),
  `${checksumLines.join("\n")}\n`,
);

const imageReference = await readFile(
  path.join(outputDirectory, "image-reference.txt"),
  "utf8",
);
if (!imageReference.includes(`ghcr.io/plannotator/artifact-server@sha256:`)) {
  throw new Error("The image reference does not contain the immutable GHCR digest.");
}

process.stdout.write(
  `Assembled ${expectedFiles.length} release assets plus SHA256SUMS.\n`,
);

async function findFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findFiles(entryPath);
    }
    return entry.isFile() ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
