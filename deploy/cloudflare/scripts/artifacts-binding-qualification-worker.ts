import {
  ArtifactsBindingGitHistoryProvider,
  type ArtifactsBinding,
} from "../src/artifacts-binding-git-history-provider.js";
import {readGitHistoryCommit} from
  "../../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import type {GitHistoryCommitRequest} from
  "../../../src/git-history/git-history-mirror.js";

interface QualificationEnvironment {
  readonly ARTIFACTS: ArtifactsBinding;
  readonly QUALIFICATION_KEY: string;
}

const utf8 = new TextEncoder();

export default {
  async fetch(
    request: Request,
    environment: QualificationEnvironment,
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("Authorization") !==
        `Bearer ${environment.QUALIFICATION_KEY}`
    ) {
      return new Response(null, {status: 404});
    }
    const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const provider = new ArtifactsBindingGitHistoryProvider(
      environment.ARTIFACTS,
      `artifact-server-test-${runId}-`,
    );
    const projectId = `prj_binding_${runId}`;
    const artifactId = `art_binding_${runId}`;
    const coordinates = await provider.createRepository(projectId, artifactId);
    try {
      const health = await provider.health();
      if (!health.healthy) throw new Error("binding_health_failed");
      const requestOne = commitRequest(
        coordinates,
        1,
        `ver_binding_${runId}_1`,
        "Workers binding qualification one",
      );
      const first = await provider.commitVersion(requestOne);
      const adopted = await provider.lookupCommit(
        coordinates,
        requestOne.metadata.versionId,
      );
      if (adopted?.commitId !== first.commitId) {
        throw new Error("binding_exact_version_lookup_failed");
      }
      const requestTwo = commitRequest(
        coordinates,
        2,
        `ver_binding_${runId}_2`,
        "Workers binding qualification two",
      );
      const second = await provider.commitVersion(requestTwo);
      if (first.commitId === second.commitId) {
        throw new Error("binding_deterministic_commits_collided");
      }
      const readCredential = await provider.issueCredential(coordinates, "read", 60);
      const exact = await readGitHistoryCommit(
        coordinates,
        requestTwo.metadata.versionId,
        readCredential.token,
      );
      if (exact?.commitId !== second.commitId) {
        throw new Error("binding_read_token_lookup_failed");
      }
      return Response.json({
        checks: {
          bindingControlPlane: "pass",
          deterministicCommits: "pass",
          exactReadTokenLookup: "pass",
          smartHttpDataPlane: "pass",
        },
        repositoryName: coordinates.repositoryName,
        runId,
      });
    } finally {
      await provider.deleteRepository(coordinates);
    }
  },
};

function commitRequest(
  coordinates: GitHistoryCommitRequest["coordinates"],
  versionNumber: number,
  versionId: string,
  content: string,
): GitHistoryCommitRequest {
  return {
    coordinates,
    files: [{bytes: utf8.encode(content), path: "index.html"}],
    metadata: {
      artifactId: coordinates.artifactId,
      createdAt: new Date(Date.UTC(2026, 7, 25, 12, versionNumber)).toISOString(),
      entryPath: "index.html",
      installationId: "ins_cloudflare_binding_qualification",
      manifestDigest: `sha256:binding-${versionNumber}`,
      projectId: coordinates.projectId,
      publisherPrincipalId: "principal_cloudflare_binding_qualification",
      versionId,
      versionNumber,
    },
    pointers: [],
  };
}
