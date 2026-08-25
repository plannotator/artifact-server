import {createHash} from "node:crypto";

import type {
  GitCloneCredential,
  GitHistoryCommitRequest,
  GitHistoryProvider,
  GitRepositoryCoordinates,
} from "../../src/git-history/git-history-mirror.js";

interface StoredCommit {
  readonly commitId: string;
  readonly request: GitHistoryCommitRequest;
}

/** Deterministic test provider adapter with controllable provider failures. */
export class RecordingGitHistoryProvider implements GitHistoryProvider {
  readonly name = "cloudflare-artifacts" as const;
  readonly repositories = new Map<string, GitRepositoryCoordinates>();
  readonly commits = new Map<string, Map<string, StoredCommit>>();
  readonly commitRequests: GitHistoryCommitRequest[] = [];
  createCalls = 0;
  deleteCalls = 0;
  issueCredentialCalls = 0;
  commitCalls = 0;
  failCommits = 0;
  readonly failDeleteCalls = new Set<number>();

  async health(): Promise<{readonly detail: string; readonly healthy: boolean}> {
    return {detail: "test-provider", healthy: true};
  }

  async createRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates> {
    this.createCalls += 1;
    const existing = this.repositories.get(artifactId);
    if (existing !== undefined) return existing;
    const coordinates = {
      artifactId,
      defaultBranch: "main" as const,
      projectId,
      provider: this.name,
      remoteUrl: `https://git.example.test/${artifactId}`,
      repositoryName: artifactId,
      status: "provisioned" as const,
    };
    this.repositories.set(artifactId, coordinates);
    return coordinates;
  }

  async commitVersion(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string}> {
    this.commitCalls += 1;
    this.commitRequests.push(request);
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      throw new Error("test-provider-commit-failure");
    }
    const commitId = createHash("sha256").update(JSON.stringify({
      files: request.files.map((file) => ({
        bytes: Buffer.from(file.bytes).toString("base64"),
        path: file.path,
      })),
      metadata: request.metadata,
      pointers: request.pointers,
    })).digest("hex");
    const versions = this.commits.get(request.coordinates.artifactId) ?? new Map();
    versions.set(request.metadata.versionId, {commitId, request});
    this.commits.set(request.coordinates.artifactId, versions);
    return {commitId};
  }

  async lookupCommit(
    coordinates: GitRepositoryCoordinates,
    versionId: string,
  ): Promise<{readonly commitId: string} | null> {
    const stored = this.commits.get(coordinates.artifactId)?.get(versionId);
    return stored === undefined ? null : {commitId: stored.commitId};
  }

  async issueCredential(
    coordinates: GitRepositoryCoordinates,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<GitCloneCredential> {
    this.issueCredentialCalls += 1;
    return {
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
      token: `${scope}-${coordinates.repositoryName}-test-token`,
    };
  }

  async deleteRepository(coordinates: GitRepositoryCoordinates): Promise<void> {
    this.deleteCalls += 1;
    if (this.failDeleteCalls.delete(this.deleteCalls)) {
      throw new Error("test-provider-delete-failure");
    }
    this.repositories.delete(coordinates.artifactId);
    this.commits.delete(coordinates.artifactId);
  }
}
