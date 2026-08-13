import {createHash} from "node:crypto";
import {readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const sourcePackageSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  description: z.string(),
  engines: z.object({node: z.string()}),
  name: z.string(),
  private: z.boolean(),
  type: z.literal("module"),
  version: z.string(),
});
const releasePackageSchema = sourcePackageSchema.omit({private: true}).extend({
  bin: z.object({artifactserver: z.string()}),
  private: z.boolean(),
});

const [operation, ...arguments_] = process.argv.slice(2);

if (operation === "prepare") {
  const [sourcePath, destinationPath] = requireArgumentCount(arguments_, 2);
  const sourcePackage = sourcePackageSchema.parse(
    JSON.parse(await readFile(sourcePath, "utf8")),
  );
  const releasePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: sourcePackage.private,
    description: sourcePackage.description,
    type: sourcePackage.type,
    bin: {artifactserver: "./bin/artifactserver"},
    engines: sourcePackage.engines,
    dependencies: sourcePackage.dependencies,
  };
  await writeFile(destinationPath, `${JSON.stringify(releasePackage, null, 2)}\n`);
} else if (operation === "manifest") {
  const [archivePath, packagePath, manifestPath] = requireArgumentCount(arguments_, 3);
  const [archive, archiveStatus, packageMetadata] = await Promise.all([
    readFile(archivePath),
    stat(archivePath),
    readFile(packagePath, "utf8").then((value) =>
      releasePackageSchema.parse(JSON.parse(value))
    ),
  ]);
  const manifest = {
    schemaVersion: 1,
    archive: path.basename(archivePath),
    sha256: createHash("sha256").update(archive).digest("hex"),
    sizeBytes: archiveStatus.size,
    package: {
      name: packageMetadata.name,
      version: packageMetadata.version,
    },
    runtime: {
      nativeNodeExtensions: false,
      node: packageMetadata.engines.node,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  throw new Error("Usage: local-package-metadata.mjs prepare|manifest <paths...>");
}

function requireArgumentCount(values, count) {
  if (values.length !== count || values.some((value) => value.length === 0)) {
    throw new Error(`Expected ${count} non-empty path arguments.`);
  }
  return values;
}
