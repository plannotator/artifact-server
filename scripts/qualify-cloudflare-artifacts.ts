import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {homedir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {mkdir, readFile, writeFile} from "node:fs/promises";

import {Redacted} from "effect";
import {z} from "zod";

import {
  CloudflareArtifactsGitHistoryProvider,
  readGitHistoryCommit,
} from
  "../src/git-history/cloudflare-artifacts-git-history-provider.js";
import type {GitHistoryCommitRequest, GitRepositoryCoordinates} from
  "../src/git-history/git-history-mirror.js";

const execute = promisify(execFile);
const qualificationNamespace = "artifact-server-test-qualification";
const maximumRepositories = 8;
const maximumOperations = 200;
const maximumCopiedBytes = 16 * 1024 * 1024;
const defaultManifestPath = path.resolve(
  ".artifact-server-qualification/cloudflare-artifacts-run.json",
);
const evidencePath = path.resolve(
  "project/evidence/cloudflare-artifacts-live-qualification.json",
);
const argumentsSchema = z.tuple([
  z.enum(["qualify", "cleanup"]),
]).rest(z.string());
const environmentSchema = z.object({
  ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE: z.literal("1").optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  HOME: z.string().min(1).optional(),
}).passthrough();
const manifestSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/u),
  createdAt: z.string(),
  namespace: z.literal(qualificationNamespace),
  operations: z.number().int().nonnegative().max(maximumOperations),
  repositories: z.array(z.object({
    artifactId: z.string(),
    deleted: z.boolean(),
    name: z.string().startsWith("artifact-server-test-"),
    projectId: z.string(),
  }).strict()).max(maximumRepositories),
  runId: z.string().regex(/^[a-z0-9-]{1,40}$/u),
  schemaVersion: z.literal(1),
}).strict();
type QualificationManifest = z.infer<typeof manifestSchema>;

const [action, ...rest] = argumentsSchema.parse(process.argv.slice(2));
const manifestArgumentIndex = rest.indexOf("--manifest");
const manifestPath = manifestArgumentIndex === -1
  ? defaultManifestPath
  : path.resolve(z.string().min(1).parse(rest[manifestArgumentIndex + 1]));

if (action === "cleanup") {
  await cleanManifest(manifestPath);
} else {
  await qualify(manifestPath);
}

async function qualify(manifestFile: string): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  if (environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE !== "1") {
    throw new Error(
      "Set ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE=1 to authorize the bounded live suite.",
    );
  }
  const auth = await wranglerAuthentication(
    environment.CLOUDFLARE_ACCOUNT_ID,
    environment.CLOUDFLARE_API_TOKEN,
  );
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const repositoryPrefix = `artifact-server-test-${runId}-`;
  let manifest: QualificationManifest = {
    accountId: auth.accountId,
    createdAt: new Date().toISOString(),
    namespace: qualificationNamespace,
    operations: 0,
    repositories: [],
    runId,
    schemaVersion: 1,
  };
  await persistManifest(manifestFile, manifest);
  const provider = new CloudflareArtifactsGitHistoryProvider({
    apiToken: Redacted.make(auth.token),
    identity: {
      accountId: auth.accountId,
      namespace: qualificationNamespace,
      provider: "cloudflare-artifacts",
    },
    repositoryPrefix,
  });
  try {
    const health = await provider.health();
    manifest = incrementOperations(manifest);
    requireCondition(health.healthy, "The dedicated namespace is unavailable.");

    const artifactId = `art_${randomUUID()}`;
    const projectId = `prj_${randomUUID()}`;
    manifest = {
      ...manifest,
      repositories: [{
        artifactId,
        deleted: false,
        name: `${repositoryPrefix}${artifactId}`,
        projectId,
      }],
    };
    await persistManifest(manifestFile, manifest);
    const coordinates = await provider.createRepository(projectId, artifactId);
    manifest = incrementOperations(manifest);
    await persistManifest(manifestFile, manifest);
    assertCoordinates(coordinates, repositoryPrefix, artifactId, projectId);

    const adopted = await provider.createRepository(projectId, artifactId);
    manifest = incrementOperations(manifest);
    requireCondition(
      adopted.repositoryName === coordinates.repositoryName &&
        adopted.remoteUrl === coordinates.remoteUrl,
      "An idempotent repository create did not adopt the same coordinates.",
    );

    const first = commitRequest(coordinates, 1, "ver_live_1", "first");
    const firstCommit = await provider.commitVersion(first);
    manifest = incrementOperations(manifest, 3);
    const firstLookup = await provider.lookupCommit(coordinates, first.metadata.versionId);
    manifest = incrementOperations(manifest, 2);
    requireCondition(
      firstLookup?.commitId === firstCommit.commitId,
      "The exact version tag did not resolve to its committed ID.",
    );

    const second = commitRequest(coordinates, 2, "ver_live_2", "second");
    const secondCommit = await provider.commitVersion(second);
    manifest = incrementOperations(manifest, 3);
    requireCondition(
      secondCommit.commitId !== firstCommit.commitId,
      "Two versions unexpectedly resolved to one commit.",
    );
    const readCredential = await provider.issueCredential(coordinates, "read", 60);
    manifest = incrementOperations(manifest);
    requireCondition(
      Date.parse(readCredential.expiresAt) > Date.now(),
      "The short-lived read credential is already expired.",
    );
    const readLookup = await readGitHistoryCommit(
      coordinates,
      second.metadata.versionId,
      readCredential.token,
    );
    manifest = incrementOperations(manifest);
    requireCondition(
      readLookup?.commitId === secondCommit.commitId,
      "A repository-scoped token could not read the exact second version.",
    );

    await provider.deleteRepository(coordinates);
    manifest = markDeleted(incrementOperations(manifest), coordinates.repositoryName);
    await persistManifest(manifestFile, manifest);
    await provider.deleteRepository(coordinates);
    manifest = incrementOperations(manifest);
    await writeFile(evidencePath, `${JSON.stringify({
      accountId: auth.accountId,
      checks: {
        deterministicExactVersionLookup: "pass",
        idempotentDeletion: "pass",
        namespaceHealth: "pass",
        repositoryAdoption: "pass",
        repositoryCreation: "pass",
        shortLivedRepositoryToken: "pass",
        smartHttpPushAndRead: "pass",
      },
      completedAt: new Date().toISOString(),
      limits: {
        maximumCopiedBytes,
        maximumOperations,
        maximumRepositories,
      },
      namespace: qualificationNamespace,
      repositoriesCreated: manifest.repositories.length,
      runId,
      schemaVersion: 1,
    }, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
    process.stdout.write(
      `Cloudflare Artifacts live qualification passed in ${qualificationNamespace}.\n`,
    );
  } finally {
    await cleanManifest(manifestFile);
  }
}

async function cleanManifest(manifestFile: string): Promise<void> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(manifestFile, "utf8")),
  );
  const environment = environmentSchema.parse(process.env);
  const auth = await wranglerAuthentication(
    manifest.accountId,
    environment.CLOUDFLARE_API_TOKEN,
  );
  let current = manifest;
  const provider = new CloudflareArtifactsGitHistoryProvider({
    apiToken: Redacted.make(auth.token),
    identity: {
      accountId: manifest.accountId,
      namespace: qualificationNamespace,
      provider: "cloudflare-artifacts",
    },
    repositoryPrefix: `artifact-server-test-${manifest.runId}-`,
  });
  current = await deleteManifestRepositories(
    provider,
    manifestFile,
    current,
    current.repositories.toReversed(),
  );
  manifestSchema.parse(current);
}

async function deleteManifestRepositories(
  provider: CloudflareArtifactsGitHistoryProvider,
  manifestFile: string,
  manifest: QualificationManifest,
  repositories: QualificationManifest["repositories"],
  index = 0,
): Promise<QualificationManifest> {
  const repository = repositories[index];
  if (repository === undefined) return manifest;
  if (repository.deleted) {
    return deleteManifestRepositories(
      provider,
      manifestFile,
      manifest,
      repositories,
      index + 1,
    );
  }
  assertManifestRepository(manifest, repository.name);
  await provider.deleteRepository({
    artifactId: repository.artifactId,
    defaultBranch: "main",
    projectId: repository.projectId,
    provider: "cloudflare-artifacts",
    remoteUrl: `https://invalid.example/${repository.name}`,
    repositoryName: repository.name,
    status: "deleting",
  });
  const updated = markDeleted(incrementOperations(manifest), repository.name);
  await persistManifest(manifestFile, updated);
  return deleteManifestRepositories(
    provider,
    manifestFile,
    updated,
    repositories,
    index + 1,
  );
}

async function wranglerAuthentication(
  requestedAccountId: string | undefined,
  apiToken: string | undefined,
): Promise<{readonly accountId: string; readonly token: string}> {
  const {stdout} = await execute("pnpm", [
    "--dir", "deploy/cloudflare", "exec", "wrangler", "whoami", "--json",
  ], {maxBuffer: 1024 * 1024});
  const whoami = z.object({
    accounts: z.array(z.object({id: z.string().regex(/^[a-f0-9]{32}$/u)}).passthrough()),
  }).passthrough().parse(JSON.parse(stdout));
  const accountId = requestedAccountId ?? whoami.accounts[0]?.id;
  if (accountId === undefined || !whoami.accounts.some((account) => account.id === accountId)) {
    throw new Error("Wrangler is not authenticated to the requested Cloudflare account.");
  }
  if (apiToken !== undefined) return {accountId, token: apiToken};
  const configCandidates = [
    path.join(homedir(), ".wrangler/config/default.toml"),
    path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    path.join(homedir(), ".config/.wrangler/config/default.toml"),
  ];
  const wranglerToken = await readWranglerToken(configCandidates);
  if (wranglerToken !== null) return {accountId, token: wranglerToken};
  throw new Error(
    "Wrangler authentication is stored in an unsupported location. Set CLOUDFLARE_API_TOKEN for the live suite.",
  );
}

async function readWranglerToken(
  candidates: readonly string[],
  index = 0,
): Promise<string | null> {
  const candidate = candidates[index];
  if (candidate === undefined) return null;
  try {
    const config = await readFile(candidate, "utf8");
    const match = /^oauth_token\s*=\s*"([^"]+)"\s*$/mu.exec(config);
    return match?.[1] ?? readWranglerToken(candidates, index + 1);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return readWranglerToken(candidates, index + 1);
    }
    throw cause;
  }
}

function commitRequest(
  coordinates: GitRepositoryCoordinates,
  versionNumber: number,
  versionId: string,
  marker: string,
): GitHistoryCommitRequest {
  const createdAt = new Date(Date.UTC(2026, 7, 25, 12, versionNumber)).toISOString();
  const bytes = new TextEncoder().encode(`<!doctype html><title>${marker}</title>`);
  requireCondition(bytes.byteLength <= maximumCopiedBytes, "Fixture exceeds the live byte bound.");
  return {
    coordinates,
    files: [{bytes, path: "index.html"}],
    metadata: {
      artifactId: coordinates.artifactId,
      createdAt,
      entryPath: "index.html",
      installationId: "qualification",
      manifestDigest: marker.padEnd(64, "0").slice(0, 64),
      projectId: coordinates.projectId,
      publisherPrincipalId: "qualification-operator",
      versionId,
      versionNumber,
    },
    pointers: [{
      mediaType: "video/mp4",
      path: "large-video.mp4",
      sha256: marker.padEnd(64, "1").slice(0, 64),
      size: 64 * 1024 * 1024,
    }],
  };
}

function incrementOperations(
  manifest: QualificationManifest,
  by = 1,
): QualificationManifest {
  return manifestSchema.parse({...manifest, operations: manifest.operations + by});
}

function markDeleted(
  manifest: QualificationManifest,
  name: string,
): QualificationManifest {
  return manifestSchema.parse({
    ...manifest,
    repositories: manifest.repositories.map((repository) =>
      repository.name === name ? {...repository, deleted: true} : repository),
  });
}

async function persistManifest(
  manifestFile: string,
  manifest: QualificationManifest,
): Promise<void> {
  await mkdir(path.dirname(manifestFile), {recursive: true, mode: 0o700});
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function assertCoordinates(
  coordinates: GitRepositoryCoordinates,
  repositoryPrefix: string,
  artifactId: string,
  projectId: string,
): void {
  requireCondition(coordinates.artifactId === artifactId, "Artifact identity changed.");
  requireCondition(coordinates.projectId === projectId, "Project identity changed.");
  requireCondition(
    coordinates.repositoryName === `${repositoryPrefix}${artifactId}`,
    "Repository identity escaped the bounded run prefix.",
  );
  requireCondition(!coordinates.remoteUrl.includes("@"), "Remote contains credentials.");
}

function assertManifestRepository(
  manifest: QualificationManifest,
  name: string,
): void {
  const expectedPrefix = `artifact-server-test-${manifest.runId}-`;
  if (!name.startsWith(expectedPrefix)) {
    throw new Error("Cleanup refused a repository outside this run manifest.");
  }
}

function requireCondition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
