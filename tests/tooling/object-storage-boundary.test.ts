import {glob, readFile} from "node:fs/promises";
import path from "node:path";

import {describe, expect, test} from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const providerImports = [
  {
    allowedPath: /^src\/storage\/s3-/u,
    specifier: "@aws-sdk/",
  },
  {
    allowedPath: /^src\/storage\/gcs-/u,
    specifier: "@google-cloud/storage",
  },
  {
    allowedPath: /^src\/storage\/azure-blob-/u,
    specifier: "@azure/storage-blob",
  },
] as const;

describe("object-storage provider boundary", () => {
  test("DEP-022-F: provider SDK imports stay inside their adapters", async () => {
    const violations: string[] = [];
    for await (const relativePath of glob("src/**/*.ts", {cwd: repositoryRoot})) {
      const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      violations.push(...providerBoundaryViolations(relativePath, source));
    }
    expect(violations).toEqual([]);
    expect(providerBoundaryViolations(
      "src/external-storage/provider.ts",
      'import {S3Client} from "@aws-sdk/client-s3";',
    )).toEqual([
      "src/external-storage/provider.ts: @aws-sdk/",
    ]);
    expect(providerBoundaryViolations(
      "src/storage/s3-provider.ts",
      'import {S3Client} from "@aws-sdk/client-s3";',
    )).toEqual([]);
  });
});

function providerBoundaryViolations(
  relativePath: string,
  source: string,
): readonly string[] {
  return providerImports.flatMap((providerImport) =>
    source.includes(providerImport.specifier) &&
      !providerImport.allowedPath.test(relativePath)
      ? [`${relativePath}: ${providerImport.specifier}`]
      : []
  );
}
