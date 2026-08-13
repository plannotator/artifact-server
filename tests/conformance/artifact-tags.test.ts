import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

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
  uploadEveryStagedFile,
} from "../support/publishing.js";

const artifactSchema = z.object({
  currentVersionId: z.string(),
  id: z.string(),
  tags: z.array(z.string()),
});
const artifactStateSchema = z.object({
  artifact: artifactSchema,
  replayed: z.boolean(),
  version: z.object({id: z.string()}),
});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactSchema})),
});
const artifactDetailsSchema = z.object({artifact: artifactSchema});
const actionPageSchema = z.object({
  actions: z.array(z.object({action: z.string(), idempotencyKey: z.string()})),
});

describe("artifact tags", () => {
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

  test("ART-008-B ART-008-F: tags normalize, filter exactly, persist with the artifact, and reject invalid sets atomically", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "tagged artifact",
      idempotencyKey: "artifact-tags-inline-create",
      tags: [" Prototype ", "Q3", "prototype"],
    });
    expect(published.body.artifact.tags).toEqual(["prototype", "q3"]);

    const stagedFile = {
      bytes: new TextEncoder().encode("<h1>staged</h1>"),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    };
    const staged = await createStagedUpload(
      server,
      installation,
      stagedFile.path,
      [stagedFile],
    );
    const uploadResponses = await uploadEveryStagedFile(
      installation,
      staged.body,
      [stagedFile],
    );
    expect(uploadResponses.map((response) => response.status)).toEqual([200]);
    const stagedPublished = await commitStagedUpload(
      installation,
      staged.body,
      "artifact-tags-staged-create",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Staged tagged artifact",
        tags: ["Design", "Staged"],
      },
    );
    expect(stagedPublished.body.artifact.tags).toEqual(["design", "staged"]);

    const filtered = await fetch(
      `${server.baseUrl}/api/v1/artifacts?tag=PROTOTYPE`,
      {headers: readHeaders(installation)},
    );
    expect(filtered.status).toBe(200);
    const filteredBody = artifactPageSchema.parse(await filtered.json());
    expect(filteredBody.artifacts.map((item) => item.artifact.id)).toEqual([
      published.body.artifact.id,
    ]);
    const partialFilter = await fetch(
      `${server.baseUrl}/api/v1/artifacts?tag=proto`,
      {headers: readHeaders(installation)},
    );
    expect(partialFilter.status).toBe(200);
    expect(artifactPageSchema.parse(await partialFilter.json()).artifacts)
      .toEqual([]);

    const updateKey = "artifact-tags-replace-first";
    const changed = await replaceTags(
      server,
      installation,
      published.body.artifact.id,
      published.body.version.id,
      updateKey,
      ["Design System", "Ready"],
    );
    expect(changed.status).toBe(200);
    const changedBody = artifactStateSchema.parse(await changed.json());
    expect(changedBody).toMatchObject({
      artifact: {tags: ["design system", "ready"]},
      replayed: false,
    });

    const replayed = await replaceTags(
      server,
      installation,
      published.body.artifact.id,
      published.body.version.id,
      updateKey,
      ["Design System", "Ready"],
    );
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      artifact: {tags: ["design system", "ready"]},
      replayed: true,
    });

    const secondChange = await replaceTags(
      server,
      installation,
      published.body.artifact.id,
      published.body.version.id,
      "artifact-tags-replace-second",
      ["Released"],
    );
    expect(secondChange.status).toBe(200);
    const originalReplayAfterChange = await replaceTags(
      server,
      installation,
      published.body.artifact.id,
      published.body.version.id,
      updateKey,
      ["Design System", "Ready"],
    );
    await expect(originalReplayAfterChange.json()).resolves.toMatchObject({
      artifact: {tags: ["design system", "ready"]},
      replayed: true,
    });

    const nextVersion = await publishVersion(server, installation, {
      artifactId: published.body.artifact.id,
      content: "tagged artifact v2",
      expectedCurrentVersionId: published.body.version.id,
      idempotencyKey: "artifact-tags-publish-version",
    });
    expect(nextVersion.body.artifact.tags).toEqual(["released"]);

    const restore = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/restore`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: nextVersion.body.version.id,
          versionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "artifact-tags-restore-version"),
        method: "POST",
      },
    );
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({
      artifact: {tags: ["released"]},
    });

    const actions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/actions`,
      {headers: readHeaders(installation)},
    );
    const actionBody = actionPageSchema.parse(await actions.json());
    expect(actionBody.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({action: "change_tags", idempotencyKey: updateKey}),
    ]));
    expect(actionBody.actions.filter((action) => action.action === "change_tags"))
      .toHaveLength(2);

    const actionCount = actionBody.actions.length;
    const invalidCases: readonly {
      readonly idempotencyKey: string;
      readonly tags: readonly string[];
    }[] = [
      {idempotencyKey: "artifact-tags-invalid-empty", tags: [""]},
      {idempotencyKey: "artifact-tags-invalid-length", tags: ["x".repeat(41)]},
      {idempotencyKey: "artifact-tags-invalid-control", tags: ["bad\u0007tag"]},
    ];
    const invalidResponses = await Promise.all(invalidCases.map((invalidCase) =>
      replaceTags(
        server,
        installation,
        published.body.artifact.id,
        published.body.version.id,
        invalidCase.idempotencyKey,
        invalidCase.tags,
      )
    ));
    expect(invalidResponses.map((response) => response.status))
      .toEqual([422, 422, 422]);
    const invalidBodies = await Promise.all(
      invalidResponses.map((invalidResponse) => invalidResponse.json()),
    );
    for (const invalidBody of invalidBodies) {
      expect(invalidBody).toMatchObject({
        error: {code: "INVALID_INPUT"},
      });
    }

    const conflict = await replaceTags(
      server,
      installation,
      published.body.artifact.id,
      published.body.version.id,
      updateKey,
      ["different"],
    );
    expect(conflict.status).toBe(409);

    const details = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`,
      {headers: readHeaders(installation)},
    );
    expect(details.status).toBe(200);
    expect(artifactDetailsSchema.parse(await details.json()).artifact.tags)
      .toEqual(["released"]);
    const actionsAfterFailure = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/actions`,
      {headers: readHeaders(installation)},
    );
    expect(actionPageSchema.parse(await actionsAfterFailure.json()).actions)
      .toHaveLength(actionCount);

    const tooManyTags = await publishNewWithTags(
      server,
      installation,
      Array.from({length: 21}, (_, index) => `tag-${index}`),
    );
    expect(tooManyTags.status).toBe(422);
    const activeArtifacts = await fetch(
      `${server.baseUrl}/api/v1/artifacts?limit=100`,
      {headers: readHeaders(installation)},
    );
    expect(artifactPageSchema.parse(await activeArtifacts.json()).artifacts)
      .toHaveLength(2);

    const deleted = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "artifact-tags-delete-artifact"),
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      artifact: {tags: ["released"]},
    });
  });
});

function replaceTags(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  expectedCurrentVersionId: string,
  idempotencyKey: string,
  tags: readonly string[],
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/tags`, {
    body: JSON.stringify({expectedCurrentVersionId, tags}),
    headers: apiHeaders(installation, idempotencyKey),
    method: "PATCH",
  });
}

function readHeaders(installation: TestInstallation): Headers {
  return new Headers({Authorization: `Bearer ${installation.apiToken}`});
}

async function publishNewWithTags(
  server: RunningTestServer,
  installation: TestInstallation,
  tags: readonly string[],
): Promise<Response> {
  const file = {
    bytes: new TextEncoder().encode("invalid tags"),
    mediaType: "text/plain",
    path: "invalid.txt",
  };
  const upload = await createStagedUpload(
    server,
    installation,
    file.path,
    [file],
  );
  await uploadEveryStagedFile(installation, upload.body, [file]);
  return fetch(upload.body.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Invalid tags",
      tags,
    }}),
    headers: apiHeaders(installation, "artifact-tags-invalid-create"),
    method: "POST",
  });
}
