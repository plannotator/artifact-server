import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {z} from "zod";

const [layoutDirectory, outputDirectory, version] = process.argv.slice(2);
if (layoutDirectory === undefined || outputDirectory === undefined || version === undefined) {
  throw new Error(
    "Usage: extract-oci-sboms.mjs <layout-directory> <output-directory> <version>.",
  );
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const descriptorSchema = z.object({
  annotations: z.record(z.string(), z.string()).optional(),
  digest: digestSchema,
  mediaType: z.string().min(1),
  platform: z.object({
    architecture: z.string().min(1),
    os: z.string().min(1),
  }).optional(),
});
const indexSchema = z.object({manifests: z.array(descriptorSchema)});
const attestationManifestSchema = z.object({
  layers: z.array(z.object({
    annotations: z.record(z.string(), z.string()),
    digest: digestSchema,
  })),
});
const statementSchema = z.object({
  predicate: z.record(z.string(), z.unknown()),
  predicateType: z.literal("https://spdx.dev/Document"),
});

const layoutIndex = indexSchema.parse(JSON.parse(
  await readFile(path.join(layoutDirectory, "index.json"), "utf8"),
));
const rootDigests = new Set(layoutIndex.manifests
  .filter((descriptor) =>
    descriptor.mediaType === "application/vnd.oci.image.index.v1+json"
  )
  .map((descriptor) => descriptor.digest));
if (rootDigests.size !== 1) {
  throw new Error(`Expected one release image index, found ${rootDigests.size}.`);
}
const [rootDigest] = rootDigests;
if (rootDigest === undefined) throw new Error("The release image index is missing.");
const imageIndex = indexSchema.parse(await readJsonBlob(rootDigest));
const platformByManifest = new Map(imageIndex.manifests.flatMap((descriptor) => {
  const platform = descriptor.platform;
  if (platform === undefined || platform.os === "unknown") return [];
  return [[descriptor.digest, `${platform.os}-${platform.architecture}`]];
}));

const writtenPlatforms = (await Promise.all(imageIndex.manifests.map(
  async (descriptor) => {
    const referencedManifest = descriptor.annotations?.["vnd.docker.reference.digest"];
    if (referencedManifest === undefined) return null;
    const platform = platformByManifest.get(referencedManifest);
    if (platform === undefined) {
      throw new Error(
        `Attestation ${descriptor.digest} references an unknown image manifest.`,
      );
    }
    const attestationManifest = attestationManifestSchema.parse(
      await readJsonBlob(descriptor.digest),
    );
    const spdxLayers = attestationManifest.layers.filter((layer) =>
      layer.annotations["in-toto.io/predicate-type"] === "https://spdx.dev/Document"
    );
    if (spdxLayers.length !== 1) {
      throw new Error(
        `Expected one SPDX statement for ${platform}, found ${spdxLayers.length}.`,
      );
    }
    const statement = statementSchema.parse(await readJsonBlob(spdxLayers[0].digest));
    if (statement.predicate["spdxVersion"] !== "SPDX-2.3") {
      throw new Error(`The ${platform} image SBOM is not SPDX 2.3.`);
    }
    await writeFile(
      path.join(
        outputDirectory,
        `artifact-server-${version}-oci-${platform}.spdx.json`,
      ),
      `${JSON.stringify(statement.predicate, null, 2)}\n`,
    );
    return platform;
  },
))).filter((platform) => platform !== null)
  .toSorted((left, right) => left.localeCompare(right));

const expectedPlatforms = ["linux-amd64", "linux-arm64"];
if (JSON.stringify(writtenPlatforms) !== JSON.stringify(expectedPlatforms)) {
  throw new Error(
    `Expected image SBOMs for ${expectedPlatforms.join(", ")}; received ${writtenPlatforms.join(", ")}.`,
  );
}
process.stdout.write(`Extracted ${writtenPlatforms.length} verified image SBOMs.\n`);

async function readJsonBlob(digest) {
  const [algorithm, fingerprint] = digest.split(":");
  if (algorithm !== "sha256" || fingerprint === undefined) {
    throw new Error(`Unsupported OCI digest ${digest}.`);
  }
  const contents = await readFile(
    path.join(layoutDirectory, "blobs", algorithm, fingerprint),
  );
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== fingerprint) throw new Error(`OCI blob ${digest} failed verification.`);
  return JSON.parse(contents.toString("utf8"));
}
