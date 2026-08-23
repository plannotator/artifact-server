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
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const maximumBodyCharacters = 8_192;
const commentThreadSchema = z.object({
  artifactId: z.string(),
  body: z.string(),
  id: z.string(),
  path: z.string().nullable(),
  state: z.enum(["open", "resolved"]),
  versionId: z.string(),
});
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()})),
  thread: commentThreadSchema,
});
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

const firstVersionFiles: readonly TestSiteFile[] = [
  {
    bytes: new TextEncoder().encode("<h1>report</h1>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: new TextEncoder().encode("body {color: rebeccapurple;}"),
    mediaType: "text/css; charset=utf-8",
    path: "assets/app.css",
  },
];
const secondVersionFiles: readonly TestSiteFile[] = [
  {
    bytes: new TextEncoder().encode("<h1>report two</h1>"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: new TextEncoder().encode("body {color: teal;}"),
    mediaType: "text/css; charset=utf-8",
    path: "assets/theme.css",
  },
];

describe("comment paths are validated against the version manifest", () => {
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

  test("CMT-002-B: a thread names one manifest entry path inside its version and reads that path back", async () => {
    expect.hasAssertions();
    const published = await publishFiles(
      server,
      installation,
      firstVersionFiles,
      "cmt-002-behavior-publish-first",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Manifest path comment target",
      },
    );
    const artifactId = published.artifact.id;
    const versionId = published.version.id;

    const nested = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-002-behavior-thread-nested",
      JSON.stringify({body: "This rule is unused.", path: "assets/app.css"}),
    );
    expect(nested.status).toBe(201);
    const nestedThread = createdThreadSchema.parse(await nested.json()).thread;
    expect(nestedThread.path).toBe("assets/app.css");

    const entry = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-002-behavior-thread-entry",
      JSON.stringify({body: "The heading is too quiet.", path: "index.html"}),
    );
    expect(entry.status).toBe(201);
    expect(createdThreadSchema.parse(await entry.json()).thread.path)
      .toBe("index.html");

    const wholeVersion = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-002-behavior-thread-whole",
      JSON.stringify({body: "The whole version needs a summary."}),
    );
    expect(wholeVersion.status).toBe(201);
    expect(createdThreadSchema.parse(await wholeVersion.json()).thread.path)
      .toBeNull();

    const detail = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${nestedThread.id}`,
      {headers: readHeaders(installation)},
    );
    expect(detail.status).toBe(200);
    expect(threadDetailsSchema.parse(await detail.json()).thread.path)
      .toBe("assets/app.css");

    const listed = await listThreads(server, installation, artifactId);
    expect(listed.items).toHaveLength(3);
    expect(listed.items.map((thread) => thread.path))
      .toEqual(expect.arrayContaining([null, "assets/app.css", "index.html"]));
  });

  test("CMT-002-F: a path outside that version's manifest is refused as an invalid comment and stores nothing", async () => {
    expect.hasAssertions();
    const first = await publishFiles(
      server,
      installation,
      firstVersionFiles,
      "cmt-002-failure-publish-first",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Manifest path refusal target",
      },
    );
    const artifactId = first.artifact.id;
    const firstVersionId = first.version.id;
    const second = await publishFiles(
      server,
      installation,
      secondVersionFiles,
      "cmt-002-failure-publish-second",
      {
        artifactId,
        expectedCurrentVersionId: firstVersionId,
        kind: "new_version",
      },
    );

    const refusedCases: readonly {
      readonly idempotencyKey: string;
      readonly path: string;
      readonly versionId: string;
    }[] = [
      {
        idempotencyKey: "cmt-002-failure-path-missing",
        path: "assets/missing.css",
        versionId: firstVersionId,
      },
      {
        idempotencyKey: "cmt-002-failure-path-directory",
        path: "assets",
        versionId: firstVersionId,
      },
      {
        idempotencyKey: "cmt-002-failure-path-later-version",
        path: "assets/theme.css",
        versionId: firstVersionId,
      },
      {
        idempotencyKey: "cmt-002-failure-path-earlier-version",
        path: "assets/app.css",
        versionId: second.version.id,
      },
    ];
    const refused = await Promise.all(refusedCases.map((refusedCase) =>
      createThread(
        server,
        installation,
        artifactId,
        refusedCase.versionId,
        refusedCase.idempotencyKey,
        JSON.stringify({body: "Refused path.", path: refusedCase.path}),
      )
    ));
    expect(refused.map((response) => response.status))
      .toEqual([422, 422, 422, 422]);
    const refusedBodies = await Promise.all(
      refused.map((response) => response.json()),
    );
    for (const refusedBody of refusedBodies) {
      expect(failureSchema.parse(refusedBody).error.code).toBe("INVALID_COMMENT");
    }

    expect((await listThreads(server, installation, artifactId)).items)
      .toEqual([]);

    const accepted = await createThread(
      server,
      installation,
      artifactId,
      firstVersionId,
      "cmt-002-failure-path-accepted",
      JSON.stringify({body: "This path exists.", path: "assets/app.css"}),
    );
    expect(accepted.status).toBe(201);
    expect((await listThreads(server, installation, artifactId)).items)
      .toHaveLength(1);

    // The body limit counts characters after trim and answers INVALID_COMMENT.
    const padded = await createThread(
      server,
      installation,
      artifactId,
      firstVersionId,
      "cmt-002-failure-body-padded",
      JSON.stringify({body: `  ${"a".repeat(maximumBodyCharacters)}  `}),
    );
    expect(padded.status).toBe(201);
    const overLength = await createThread(
      server,
      installation,
      artifactId,
      firstVersionId,
      "cmt-002-failure-body-over-length",
      JSON.stringify({body: "a".repeat(maximumBodyCharacters + 1)}),
    );
    expect(overLength.status).toBe(422);
    expect(failureSchema.parse(await overLength.json()).error.code)
      .toBe("INVALID_COMMENT");
  });
});

function readHeaders(installation: TestInstallation): Headers {
  return new Headers({Authorization: `Bearer ${installation.apiToken}`});
}

async function publishFiles(
  server: RunningTestServer,
  installation: TestInstallation,
  files: readonly TestSiteFile[],
  idempotencyKey: string,
  target: Parameters<typeof commitStagedUpload>[3],
): Promise<PublishResponse> {
  const upload = await createStagedUpload(
    server,
    installation,
    "index.html",
    files,
  );
  const uploads = await uploadEveryStagedFile(installation, upload.body, files);
  const failed = uploads.find((response) => !response.ok);
  if (failed !== undefined) {
    throw new Error(`A staged comment fixture upload failed with ${failed.status}.`);
  }
  const committed = await commitStagedUpload(
    installation,
    upload.body,
    idempotencyKey,
    target,
  );
  return committed.body;
}

async function createThread(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  versionId: string,
  idempotencyKey: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/comments`,
    {body, headers: apiHeaders(installation, idempotencyKey), method: "POST"},
  );
}

async function listThreads(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
): Promise<z.infer<typeof threadPageSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments`,
    {headers: readHeaders(installation)},
  );
  if (response.status !== 200) {
    throw new Error(`Listing comment threads failed with ${response.status}.`);
  }
  return threadPageSchema.parse(await response.json());
}
