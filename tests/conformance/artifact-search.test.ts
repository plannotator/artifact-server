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
import {publishNew} from "../support/publishing.js";

const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string(), tags: z.array(z.string())}),
  })),
  nextCursor: z.string().nullable(),
});

describe("project-wide artifact search", () => {
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

  test("ART-009-B ART-009-F: search matches normalized name substrings and exact tags before pagination", async () => {
    const otherProjectId = await createProject(server, installation, "Other search project");
    const named = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "named search result",
      idempotencyKey: "artifact-search-named",
      name: "Release Design Review",
      projectId: "prj_default",
      tags: ["roadmap"],
    });
    const tagged = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "tagged search result",
      idempotencyKey: "artifact-search-tagged",
      name: "Completely unrelated title",
      projectId: "prj_default",
      tags: ["Find Me"],
    });
    const unicodeNamed = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "unicode normalized search result",
      idempotencyKey: "artifact-search-unicode-name",
      name: "Straße Ｒｅｖｉｅｗ",
      projectId: "prj_default",
    });
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "partial tag decoy",
      idempotencyKey: "artifact-search-partial-tag",
      name: "Unrelated decoy",
      projectId: "prj_default",
      tags: ["find-me-later"],
    });
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "foreign project result",
      idempotencyKey: "artifact-search-foreign-project",
      name: "Release Design Review in another project",
      projectId: otherProjectId,
      tags: ["find me"],
    });

    const byName = await search(server, installation, "  DESIGN   REVIEW ");
    expect(byName.artifacts.map(({artifact}) => artifact.id)).toEqual([
      named.body.artifact.id,
    ]);

    const byExactTag = await search(server, installation, " FIND ME ");
    expect(byExactTag.artifacts.map(({artifact}) => artifact.id)).toEqual([
      tagged.body.artifact.id,
    ]);

    const partialTag = await search(server, installation, "find me lat");
    expect(partialTag.artifacts).toEqual([]);

    const byUnicodeName = await search(server, installation, "STRASSE review");
    expect(byUnicodeName.artifacts.map(({artifact}) => artifact.id)).toEqual([
      unicodeNamed.body.artifact.id,
    ]);
  });
});

async function search(
  server: RunningTestServer,
  installation: TestInstallation,
  query: string,
): Promise<z.infer<typeof artifactPageSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts?${new URLSearchParams({
      limit: "1",
      projectId: "prj_default",
      search: query,
    })}`,
    {headers: {Authorization: `Bearer ${installation.apiToken}`}},
  );
  expect(response.status).toBe(200);
  return artifactPageSchema.parse(await response.json());
}

async function createProject(
  server: RunningTestServer,
  installation: TestInstallation,
  name: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(installation, "artifact-search-create-project"),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({project: z.object({id: z.string()})})
    .parse(await response.json()).project.id;
}
