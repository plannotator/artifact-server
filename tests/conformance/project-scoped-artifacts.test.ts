import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  uploadStagedFile,
} from "../support/publishing.js";

const projectSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  name: z.string(),
});
const projectResponseSchema = z.object({project: projectSchema});
const projectListSchema = z.object({projects: z.array(projectSchema)});
const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), projectId: z.string()}),
  })),
  nextCursor: z.string().nullable(),
});

describe("project-scoped artifacts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("default use stays simple while project boundaries stay isolated", async () => {
    const initialProjects = projectListSchema.parse(await (await apiFetch(
      "/api/v1/projects",
    )).json());
    expect(initialProjects.projects).toEqual([
      expect.objectContaining({
        archivedAt: null,
        id: defaultProjectId,
        name: "Default",
      }),
    ]);

    const defaultArtifact = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "default project artifact",
      idempotencyKey: "same-key-in-different-projects",
      name: "Default artifact",
    });
    expect(defaultArtifact.body.artifact.projectId).toBe(defaultProjectId);

    const createdResponse = await apiFetch("/api/v1/projects", {
      body: JSON.stringify({name: "Product launch"}),
      headers: apiHeaders(installation, "unused-project-create-key"),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = projectResponseSchema.parse(await createdResponse.json()).project;

    const otherInstallation = await createTestInstallation();
    const otherServer = await startTestServer(otherInstallation);
    try {
      const foreignResponse = await fetch(`${otherServer.baseUrl}/api/v1/projects`, {
        body: JSON.stringify({name: "Other installation project"}),
        headers: apiHeaders(otherInstallation, "unused-foreign-project-key"),
        method: "POST",
      });
      const foreignProject = projectResponseSchema.parse(
        await foreignResponse.json(),
      ).project;
      const crossInstallationSelection = await apiFetch(
        `/api/v1/projects/${foreignProject.id}`,
      );
      expect(crossInstallationSelection.status).toBe(404);
      await expect(crossInstallationSelection.json()).resolves.toMatchObject({
        error: {code: "PROJECT_NOT_FOUND"},
      });
    } finally {
      await otherServer.stop();
      await removeTestInstallation(otherInstallation);
    }

    const isolatedBytes = new TextEncoder().encode("project-bound upload");
    const isolatedFile = {
      bytes: isolatedBytes,
      mediaType: "text/plain",
      path: "project-bound.txt",
    };
    const isolatedUpload = await createStagedUpload(
      server,
      installation,
      isolatedFile.path,
      [isolatedFile],
      created.id,
    );
    const plannedUpload = isolatedUpload.body.files[0] ?? failMissingUploadFile();
    const tamperedUploadUrl = new URL(plannedUpload.uploadUrl);
    tamperedUploadUrl.searchParams.set("projectId", defaultProjectId);
    const crossProjectUpload = await fetch(tamperedUploadUrl, {
      body: isolatedBytes,
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: "PUT",
    });
    expect(crossProjectUpload.status).toBe(404);
    expect((await uploadStagedFile(
      installation,
      plannedUpload,
      isolatedBytes,
    )).status).toBe(200);

    const ambiguous = await apiFetch("/api/v1/artifacts");
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: {
        code: "PROJECT_SELECTION_REQUIRED",
        message: expect.stringContaining(`Product launch (${created.id})`),
      },
    });

    const projectArtifact = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "product project artifact",
      idempotencyKey: "same-key-in-different-projects",
      name: "Launch artifact",
      projectId: created.id,
    });
    expect(projectArtifact.body.artifact.projectId).toBe(created.id);
    expect(projectArtifact.body.artifact.id).not.toBe(defaultArtifact.body.artifact.id);

    const [defaultPage, projectPage] = await Promise.all([
      apiFetch(`/api/v1/artifacts?projectId=${defaultProjectId}`),
      apiFetch(`/api/v1/artifacts?projectId=${created.id}`),
    ]);
    expect(artifactListSchema.parse(await defaultPage.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: defaultArtifact.body.artifact.id}),
      })]);
    expect(artifactListSchema.parse(await projectPage.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: projectArtifact.body.artifact.id}),
      })]);

    const crossProjectRead = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${defaultProjectId}`,
    );
    expect(crossProjectRead.status).toBe(404);
    await expect(crossProjectRead.json()).resolves.toMatchObject({
      error: {code: "ARTIFACT_NOT_FOUND"},
    });

    const second = await publishVersion(server, installation, {
      artifactId: projectArtifact.body.artifact.id,
      content: "second product project version",
      expectedCurrentVersionId: projectArtifact.body.version.id,
      idempotencyKey: "project-scope-second-version",
      projectId: created.id,
    });
    const crossProjectComparison = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/comparisons?` +
        `projectId=${defaultProjectId}&fromVersionId=${projectArtifact.body.version.id}` +
        `&toVersionId=${second.body.version.id}`,
    );
    expect(crossProjectComparison.status).toBe(404);
    const crossProjectMutation = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/access?` +
        `projectId=${defaultProjectId}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: second.body.version.id,
        }),
        headers: apiHeaders(installation, "cross-project-access-change"),
        method: "PATCH",
      },
    );
    expect(crossProjectMutation.status).toBe(404);
    const actions = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/actions?` +
        `projectId=${created.id}`,
    );
    await expect(actions.json()).resolves.toMatchObject({
      actions: [
        expect.objectContaining({projectId: created.id}),
        expect.objectContaining({projectId: created.id}),
      ],
    });
  });

  test("archive blocks writes but preserves exact history", async () => {
    const created = projectResponseSchema.parse(await (await apiFetch(
      "/api/v1/projects",
      {
        body: JSON.stringify({name: "Archive proof"}),
        headers: apiHeaders(installation, "unused-project-create-key"),
        method: "POST",
      },
    )).json()).project;
    const firstBytes = new TextEncoder().encode("first archived-project version");
    const firstFile = {
      bytes: firstBytes,
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    };
    const firstUpload = await createStagedUpload(
      server,
      installation,
      firstFile.path,
      [firstFile],
      created.id,
    );
    const firstPlannedFile = firstUpload.body.files[0] ?? failMissingUploadFile();
    expect((await uploadStagedFile(
      installation,
      firstPlannedFile,
      firstBytes,
    )).status).toBe(200);
    const firstTarget = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Archive proof artifact",
    };
    const first = await commitStagedUpload(
      installation,
      firstUpload.body,
      "archive-proof-first",
      firstTarget,
    );

    const archiveResponse = await apiFetch(
      `/api/v1/projects/${created.id}/archive`,
      {headers: apiHeaders(installation, "unused-project-archive-key"), method: "POST"},
    );
    expect(archiveResponse.status).toBe(200);
    const firstArchivedAt = projectResponseSchema.parse(
      await archiveResponse.json(),
    ).project.archivedAt;
    expect(firstArchivedAt).not.toBeNull();
    const repeatedArchivedAt = projectResponseSchema.parse(
      await (await apiFetch(
        `/api/v1/projects/${created.id}/archive`,
        {headers: apiHeaders(installation, "unused-project-archive-retry"), method: "POST"},
      )).json(),
    ).project.archivedAt;
    expect(repeatedArchivedAt).toBe(firstArchivedAt);

    const replay = await commitStagedUpload(
      installation,
      firstUpload.body,
      "archive-proof-first",
      firstTarget,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({
      artifact: {id: first.body.artifact.id, projectId: created.id},
      replayed: true,
      version: {id: first.body.version.id, projectId: created.id},
    });

    const rejected = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        projectId: created.id,
      }),
      headers: apiHeaders(installation, "unused-archived-upload-key"),
      method: "POST",
    });
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {code: "PROJECT_ARCHIVED"},
    });

    const details = await apiFetch(
      `/api/v1/artifacts/${first.body.artifact.id}?projectId=${created.id}`,
    );
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({
      artifact: {id: first.body.artifact.id, projectId: created.id},
      current: {version: {id: first.body.version.id, projectId: created.id}},
    });
    expect((await fetchLoopbackContent(first.body.links.version)).status).toBe(200);

    const unarchived = await apiFetch(
      `/api/v1/projects/${created.id}/unarchive`,
      {headers: apiHeaders(installation, "unused-project-unarchive-key"), method: "POST"},
    );
    expect(unarchived.status).toBe(200);
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "second version after unarchive",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "archive-proof-second",
      projectId: created.id,
    });
    expect(second.body.version).toMatchObject({number: 2, projectId: created.id});

    const renamed = await apiFetch(`/api/v1/projects/${created.id}`, {
      body: JSON.stringify({name: "Renamed without moving artifacts"}),
      headers: apiHeaders(installation, "unused-project-rename-key"),
      method: "PATCH",
    });
    expect(projectResponseSchema.parse(await renamed.json()).project.name)
      .toBe("Renamed without moving artifacts");
    expect((await apiFetch(
      `/api/v1/artifacts/${first.body.artifact.id}?projectId=${created.id}`,
    )).status).toBe(200);
  });

  function apiFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
  }
});

function failMissingUploadFile(): never {
  throw new Error("The project upload plan omitted its declared file.");
}
