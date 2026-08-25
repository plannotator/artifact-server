import {
  commitGitHistoryVersion,
  lookupGitHistoryCommit,
} from "../../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import type {
  GitCloneCredential,
  GitHistoryCommitRequest,
  GitHistoryProvider,
  GitRepositoryCoordinates,
} from "../../../src/git-history/git-history-mirror.js";

export interface ArtifactsBindingToken {
  readonly expiresAt: string;
  readonly plaintext: string;
}

export interface ArtifactsBindingRepositoryInfo {
  readonly defaultBranch: string;
  readonly name: string;
  readonly remote: string;
}

export interface ArtifactsBindingRepository {
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsBindingToken>;
  info(): Promise<ArtifactsBindingRepositoryInfo | null>;
}

export interface ArtifactsBindingRepositoryPage {
  readonly cursor?: string;
}

export interface ArtifactsBinding {
  create(name: string, options?: {
    readonly description?: string;
    readonly readOnly?: boolean;
    readonly setDefaultBranch?: string;
  }): Promise<ArtifactsBindingRepositoryInfo & {readonly token: string}>;
  delete(name: string): Promise<boolean>;
  get(name: string): Promise<ArtifactsBindingRepository>;
  list(options?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ArtifactsBindingRepositoryPage>;
}

/** Cloudflare Worker binding control plane with the shared smart-HTTP data plane. */
export class ArtifactsBindingGitHistoryProvider implements GitHistoryProvider {
  readonly name = "cloudflare-artifacts" as const;
  private readonly artifacts: ArtifactsBinding;
  private readonly repositoryPrefix: string;

  constructor(
    artifacts: ArtifactsBinding,
    repositoryPrefix = "",
  ) {
    assertRepositoryPrefix(repositoryPrefix);
    this.artifacts = artifacts;
    this.repositoryPrefix = repositoryPrefix;
  }

  async health(): Promise<{readonly detail: string; readonly healthy: boolean}> {
    try {
      await this.artifacts.list({limit: 1});
      return {detail: "available", healthy: true};
    } catch {
      return {detail: "binding_unavailable", healthy: false};
    }
  }

  async createRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates> {
    const repositoryName = `${this.repositoryPrefix}${artifactId}`;
    let info: ArtifactsBindingRepositoryInfo;
    try {
      info = await this.artifacts.create(repositoryName, {
        description: "Derived Artifact Server version history",
        readOnly: false,
        setDefaultBranch: "main",
      });
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      const existing = await this.artifacts.get(repositoryName);
      const existingInfo = await existing.info();
      if (existingInfo === null) {
        throw new Error("cloudflare_repository_not_ready", {cause});
      }
      info = existingInfo;
    }
    validateRepository(info, repositoryName);
    return {
      artifactId,
      defaultBranch: "main",
      projectId,
      provider: this.name,
      remoteUrl: info.remote,
      repositoryName,
      status: "provisioned",
    };
  }

  async commitVersion(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string}> {
    const credential = await this.issueCredential(
      request.coordinates,
      "write",
      300,
    );
    return commitGitHistoryVersion(request, credential.token);
  }

  async lookupCommit(
    coordinates: GitRepositoryCoordinates,
    versionId: string,
  ): Promise<{readonly commitId: string} | null> {
    const credential = await this.issueCredential(coordinates, "write", 60);
    return lookupGitHistoryCommit(coordinates, versionId, credential.token);
  }

  async issueCredential(
    coordinates: GitRepositoryCoordinates,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<GitCloneCredential> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
      throw new Error("invalid_repository_token_ttl");
    }
    const repository = await this.artifacts.get(coordinates.repositoryName);
    const token = await repository.createToken(scope, ttlSeconds);
    return {expiresAt: token.expiresAt, token: token.plaintext};
  }

  async deleteRepository(coordinates: GitRepositoryCoordinates): Promise<void> {
    try {
      await this.artifacts.delete(coordinates.repositoryName);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
  }
}

function validateRepository(
  info: ArtifactsBindingRepositoryInfo,
  repositoryName: string,
): void {
  if (info.name !== repositoryName || info.defaultBranch !== "main") {
    throw new Error("cloudflare_repository_identity_mismatch");
  }
  const remote = new URL(info.remote);
  if (
    remote.protocol !== "https:" || remote.username !== "" ||
    remote.password !== ""
  ) {
    throw new Error("cloudflare_remote_is_not_credential_free_https");
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? `${cause.name} ${cause.message}` : "";
}

function isAlreadyExists(cause: unknown): boolean {
  return /already exists|conflict|\b409\b/iu.test(errorText(cause));
}

function isNotFound(cause: unknown): boolean {
  return /not found|\b404\b/iu.test(errorText(cause));
}

function assertRepositoryPrefix(prefix: string): void {
  if (prefix === "") return;
  if (!/^artifact-server-test-[a-z0-9-]{1,80}-$/u.test(prefix)) {
    throw new Error("A repository prefix must be a bounded live-suite prefix.");
  }
}
