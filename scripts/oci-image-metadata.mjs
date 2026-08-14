import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

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
const imageManifestSchema = z.object({
  config: descriptorSchema,
  layers: z.array(descriptorSchema),
});
const attestationManifestSchema = z.object({
  layers: z.array(z.object({
    annotations: z.record(z.string(), z.string()),
    digest: digestSchema,
    mediaType: z.literal("application/vnd.in-toto+json"),
  })),
});
const imageConfigSchema = z.object({
  config: z.object({
    Entrypoint: z.array(z.string()),
    Labels: z.record(z.string(), z.string()),
    User: z.string().min(1),
    WorkingDir: z.string().min(1),
  }),
});
const requiredPredicateTypes = [
  "https://spdx.dev/Document",
  "https://slsa.dev/provenance/v1",
];

const [
  archivePath,
  layoutPath,
  outputPath,
  expectedVersion,
  expectedRevision,
  expectedSourceTreeClean,
] = requireArgumentCount(process.argv.slice(2), 6);
if (expectedSourceTreeClean !== "true" && expectedSourceTreeClean !== "false") {
  throw new Error("Expected source-tree cleanliness to be true or false.");
}

const layoutIndex = indexSchema.parse(
  JSON.parse(await readFile(path.join(layoutPath, "index.json"), "utf8")),
);
const rootDescriptor = layoutIndex.manifests.find((descriptor) => {
  return descriptor.mediaType === "application/vnd.oci.image.index.v1+json" ||
    descriptor.mediaType === "application/vnd.docker.distribution.manifest.list.v2+json";
});
if (rootDescriptor === undefined) {
  throw new Error("The OCI archive does not contain a multi-platform image index.");
}
const imageIndex = indexSchema.parse(await readJsonBlob(
  layoutPath,
  rootDescriptor.digest,
));
const inspected = await Promise.all(imageIndex.manifests.map(async (descriptor) => {
  const platform = descriptor.platform;
  if (platform === undefined) {
    throw new Error("An OCI image descriptor is missing its platform.");
  }
  if (platform.os === "unknown" || platform.architecture === "unknown") {
    const attestedManifest = descriptor.annotations?.["vnd.docker.reference.digest"];
    if (attestedManifest === undefined) {
      throw new Error("An OCI attestation does not name its image manifest.");
    }
    const attestation = attestationManifestSchema.parse(
      await readJsonBlob(layoutPath, descriptor.digest),
    );
    await Promise.all(attestation.layers.map((layer) =>
      verifyBlob(layoutPath, layer.digest)
    ));
    const predicates = attestation.layers.map((layer) =>
      layer.annotations["in-toto.io/predicate-type"]
    ).toSorted((left, right) => (left ?? "").localeCompare(right ?? ""));
    const required = [...requiredPredicateTypes].toSorted((left, right) =>
      left.localeCompare(right)
    );
    if (JSON.stringify(predicates) !== JSON.stringify(required)) {
      throw new Error(
        `Attestation ${descriptor.digest} does not contain SPDX and SLSA predicates.`,
      );
    }
    return {attestedManifest, kind: "attestation", predicates};
  }
  if (platform.os !== "linux") {
    throw new Error(`The OCI image includes unsupported operating system ${platform.os}.`);
  }
  const architecture = platform.architecture;
  const manifest = imageManifestSchema.parse(
    await readJsonBlob(layoutPath, descriptor.digest),
  );
  const imageConfig = imageConfigSchema.parse(
    await readJsonBlob(layoutPath, manifest.config.digest),
  );
  await Promise.all(manifest.layers.map((layer) =>
    verifyBlob(layoutPath, layer.digest)
  ));
  const runtime = imageConfig.config;
  const labels = runtime.Labels;
  if (runtime.User !== "node:node") {
    throw new Error(`The ${architecture} image does not use the fixed node user.`);
  }
  if (runtime.WorkingDir !== "/opt/artifact-server") {
    throw new Error(`The ${architecture} image has the wrong working directory.`);
  }
  if (JSON.stringify(runtime.Entrypoint) !==
    JSON.stringify(["node", "dist/cli/main.js"])) {
    throw new Error(`The ${architecture} image has the wrong entrypoint.`);
  }
  if (labels["org.opencontainers.image.version"] !== expectedVersion) {
    throw new Error(`The ${architecture} image has the wrong product version label.`);
  }
  if (labels["org.opencontainers.image.revision"] !== expectedRevision) {
    throw new Error(`The ${architecture} image has the wrong source revision label.`);
  }
  if (labels["org.artifactserver.image.source-tree-clean"] !==
    expectedSourceTreeClean) {
    throw new Error(`The ${architecture} image has the wrong source-tree label.`);
  }
  return {
    architecture,
    configDigest: manifest.config.digest,
    kind: "image",
    manifestDigest: descriptor.digest,
    operatingSystem: platform.os,
  };
}));
const images = inspected.filter((item) => item.kind === "image");
const attestations = inspected.filter((item) => item.kind === "attestation");
const attestationCount = attestations.length;

const architectures = images.map(({architecture}) => architecture)
  .toSorted((left, right) => left.localeCompare(right));
if (JSON.stringify(architectures) !== JSON.stringify(["amd64", "arm64"])) {
  throw new Error(`Expected amd64 and arm64 images, received ${architectures.join(", ")}.`);
}
if (attestationCount < 2) {
  throw new Error("The OCI archive is missing per-platform build attestations.");
}
const imageManifestDigests = new Set(images.map(({manifestDigest}) => manifestDigest));
if (attestations.some(({attestedManifest}) =>
  !imageManifestDigests.has(attestedManifest)
)) {
  throw new Error("An OCI attestation does not point to a released image manifest.");
}

const [archiveSha256, archiveStatus] = await Promise.all([
  sha256File(archivePath),
  stat(archivePath),
]);
const manifest = {
  schemaVersion: 1,
  archive: path.basename(archivePath),
  archiveSha256,
  archiveSizeBytes: archiveStatus.size,
  attestations: attestationCount,
  attestationPredicates: [...requiredPredicateTypes],
  imageIndexDigest: rootDescriptor.digest,
  platforms: images.toSorted((left, right) =>
    left.architecture.localeCompare(right.architecture)
  ),
  product: "artifact-server",
  revision: expectedRevision,
  sourceTreeClean: expectedSourceTreeClean === "true",
  version: expectedVersion,
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

async function readJsonBlob(layoutPathToRead, digest) {
  return JSON.parse((await readVerifiedBlob(layoutPathToRead, digest)).toString("utf8"));
}

async function readVerifiedBlob(layoutPathToRead, digest) {
  const {fingerprint, location} = digestLocation(layoutPathToRead, digest);
  const blob = await readFile(location);
  const actual = createHash("sha256").update(blob).digest("hex");
  if (actual !== fingerprint) throw new Error(`OCI blob ${digest} failed verification.`);
  return blob;
}

async function verifyBlob(layoutPathToRead, digest) {
  const {fingerprint, location} = digestLocation(layoutPathToRead, digest);
  if (await sha256File(location) !== fingerprint) {
    throw new Error(`OCI blob ${digest} failed verification.`);
  }
}

function digestLocation(layoutPathToRead, digest) {
  const [algorithm, fingerprint] = digest.split(":");
  if (algorithm !== "sha256" || fingerprint === undefined) {
    throw new Error(`Unsupported OCI digest ${digest}.`);
  }
  return {
    fingerprint,
    location: path.join(layoutPathToRead, "blobs", algorithm, fingerprint),
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function requireArgumentCount(values, count) {
  if (values.length !== count || values.some((value) => value.length === 0)) {
    throw new Error(`Expected ${count} non-empty arguments.`);
  }
  return values;
}
