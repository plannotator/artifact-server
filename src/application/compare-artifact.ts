import { Context, Effect, Layer } from "effect";

import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  type BlobStorageFailure,
  VersionNotFound,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import type {
  ArtifactRecord,
  ArtifactVersion,
  ManifestEntry,
  VersionRecord,
} from "../core/model.js";
import {
  compareManifests,
  type ManifestChange,
  type ManifestRename,
} from "../comparison/compare-manifests.js";

const maximumTextDiffBytes = 256 * 1_024;

/** Input for comparing two saved versions of one artifact. */
export interface CompareArtifactVersionsCommand {
  readonly artifactId: string;
  readonly fromVersionId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly toVersionId: string;
}

/** One bounded line-level replacement region. */
export interface TextLineChange {
  readonly after: readonly string[];
  readonly afterStartLine: number;
  readonly before: readonly string[];
  readonly beforeStartLine: number;
}

/** Safe comparison detail for one changed same-path file. */
export type FileComparisonDetail =
  | {
    readonly afterLineCount: number;
    readonly beforeLineCount: number;
    readonly change: TextLineChange | null;
    readonly kind: "text";
  }
  | {
    readonly kind: "binary";
    readonly reason: "binary_or_invalid_utf8" | "text_limit_exceeded";
  };

/** One changed file and its bounded comparison detail. */
export interface ComparedFileChange extends ManifestChange {
  readonly detail: FileComparisonDetail;
}

/** Authenticated comparison of two immutable saved versions. */
export interface ArtifactComparison {
  readonly added: readonly ManifestEntry[];
  readonly artifact: ArtifactRecord;
  readonly changed: readonly ComparedFileChange[];
  readonly from: VersionRecord;
  readonly removed: readonly ManifestEntry[];
  readonly renamed: readonly ManifestRename[];
  readonly to: VersionRecord;
  readonly unchangedCount: number;
}

/** Persistence required to obtain comparison inputs. */
export interface CompareArtifactRepository {
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findArtifactVersion: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
}

/** Immutable byte reads required for bounded text comparison. */
export interface ComparisonBlobStorage {
  readonly readBytes: (
    entry: ManifestEntry,
  ) => Effect.Effect<Uint8Array, BlobStorageFailure>;
}

/** Dependencies used to construct comparison operations. */
export interface CompareArtifactDependencies {
  readonly blobs: ComparisonBlobStorage;
  readonly repository: CompareArtifactRepository;
}

/** Expected failures produced by version comparison. */
export type CompareArtifactFailure =
  | ArtifactNotFound
  | VersionNotFound
  | AuthorizationDenied
  | ArtifactRepositoryFailure
  | BlobStorageFailure
  | ProjectManagementFailure;

interface CompareArtifactOperations {
  readonly compareVersions: (
    command: CompareArtifactVersionsCommand,
  ) => Effect.Effect<ArtifactComparison, CompareArtifactFailure>;
}

/** Compares primary manifests and bounded text without requiring Git. */
export class CompareArtifactService extends Context.Service<
  CompareArtifactService,
  CompareArtifactOperations
>()("artifact-server/application/CompareArtifactService") {
  /** Construct comparison from deployment-neutral records and blob reads. */
  static readonly layer = (
    dependencies: CompareArtifactDependencies,
  ): Layer.Layer<
    CompareArtifactService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      CompareArtifactService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeCompareArtifactService(dependencies, authorization, projects);
      }),
    );
}

function makeCompareArtifactService(
  dependencies: CompareArtifactDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): CompareArtifactOperations {
  const requireVersion = Effect.fn("CompareArtifactService.requireVersion")(
    function*(projectId: string, artifactId: string, versionId: string) {
      const version = yield* dependencies.repository.findArtifactVersion(
        projectId,
        artifactId,
        versionId,
      );
      if (version !== null) return version;
      return yield* new VersionNotFound({
        message: "The saved version does not exist on this artifact.",
      });
    },
  );

  const compareChangedFile = Effect.fn("CompareArtifactService.compareChangedFile")(
    function*(change: ManifestChange) {
      if (!isTextMediaType(change.before.mediaType) ||
        !isTextMediaType(change.after.mediaType)) {
        return comparedBinary(change, "binary_or_invalid_utf8");
      }
      if (
        change.before.size > maximumTextDiffBytes ||
        change.after.size > maximumTextDiffBytes
      ) {
        return comparedBinary(change, "text_limit_exceeded");
      }
      const [beforeBytes, afterBytes] = yield* Effect.all([
        dependencies.blobs.readBytes(change.before),
        dependencies.blobs.readBytes(change.after),
      ], {concurrency: 2});
      const beforeText = decodeUtf8(beforeBytes);
      const afterText = decodeUtf8(afterBytes);
      if (beforeText === null || afterText === null) {
        return comparedBinary(change, "binary_or_invalid_utf8");
      }
      const beforeLines = splitLines(beforeText);
      const afterLines = splitLines(afterText);
      return {
        ...change,
        detail: {
          afterLineCount: afterLines.length,
          beforeLineCount: beforeLines.length,
          change: changedLineRegion(beforeLines, afterLines),
          kind: "text" as const,
        },
      };
    },
  );

  const compareVersions = Effect.fn("CompareArtifactService.compareVersions")(
    function*(command: CompareArtifactVersionsCommand) {
      const project = command.projectId === null
        ? yield* projects.resolveActiveProject({
          principal: command.principal,
          projectId: null,
        })
        : yield* projects.getProject({
          principal: command.principal,
          projectId: command.projectId,
        });
      const artifact = yield* dependencies.repository.findArtifact(
        project.id,
        command.artifactId,
      );
      if (artifact === null) {
        return yield* new ArtifactNotFound({
          message: "The artifact does not exist.",
        });
      }
      yield* authorization.requireArtifactRead(command.principal, artifact);
      const [from, to] = yield* Effect.all([
        requireVersion(project.id, artifact.id, command.fromVersionId),
        requireVersion(project.id, artifact.id, command.toVersionId),
      ], {concurrency: 2});
      const structural = compareManifests(from.manifest, to.manifest);
      const changed = yield* Effect.forEach(
        structural.changed,
        compareChangedFile,
        {concurrency: 1},
      );
      return {
        added: structural.added,
        artifact,
        changed,
        from: from.version,
        removed: structural.removed,
        renamed: structural.renamed,
        to: to.version,
        unchangedCount: structural.unchanged.length,
      };
    },
  );

  return CompareArtifactService.of({compareVersions});
}

function comparedBinary(
  change: ManifestChange,
  reason: Extract<FileComparisonDetail, {readonly kind: "binary"}>["reason"],
): ComparedFileChange {
  return {...change, detail: {kind: "binary", reason}};
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
}

function isTextMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  return essence?.startsWith("text/") === true ||
    essence === "application/javascript" ||
    essence === "application/json" ||
    essence === "application/xml" ||
    essence === "application/xhtml+xml" ||
    essence === "image/svg+xml";
}

function splitLines(text: string): readonly string[] {
  return text.split("\n");
}

function changedLineRegion(
  before: readonly string[],
  after: readonly string[],
): TextLineChange | null {
  let prefix = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (prefix < sharedLength && before[prefix] === after[prefix]) prefix += 1;
  if (prefix === before.length && prefix === after.length) return null;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    after: after.slice(prefix, after.length - suffix),
    afterStartLine: prefix + 1,
    before: before.slice(prefix, before.length - suffix),
    beforeStartLine: prefix + 1,
  };
}
