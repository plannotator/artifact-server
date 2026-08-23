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

const commentThreadSchema = z.object({
  anchor: z.unknown(),
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
const updatedThreadSchema = z.object({thread: commentThreadSchema});
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

/** The documented anchor ceiling from `src/core/publishing-limits.ts`. */
const maximumAnchorBytes = 16_384;
const largestAnchorJson = JSON.stringify({
  pad: "a".repeat(maximumAnchorBytes - '{"pad":""}'.length),
});
const oversizeAnchorJson = JSON.stringify({
  pad: "a".repeat(maximumAnchorBytes - '{"pad":""}'.length + 1),
});

describe("comment anchors stay opaque within their documented bounds", () => {
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

  test("CMT-003-B: anchors of several shapes are stored and read back byte for byte", async () => {
    expect.hasAssertions();
    expect(Buffer.byteLength(largestAnchorJson, "utf8"))
      .toBe(maximumAnchorBytes);
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>anchored</h1>",
      idempotencyKey: "cmt-003-behavior-publish",
      name: "Anchor storage target",
    });
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;

    const storedCases: readonly {
      readonly anchorJson: string;
      readonly idempotencyKey: string;
    }[] = [
      {
        anchorJson: JSON.stringify({kind: "page"}),
        idempotencyKey: "cmt-003-behavior-anchor-page",
      },
      {
        anchorJson: JSON.stringify({kind: "element", point: {x: 0, y: 1}}),
        idempotencyKey: "cmt-003-behavior-anchor-bounds",
      },
      {
        anchorJson: JSON.stringify({
          htmlAdditionalTargets: [],
          htmlAnchor: {
            point: {x: 0.421_5, y: 0.13},
            selector: "main > section:nth-of-type(2) > p",
            text: "Total revenue",
          },
          originalText: "Total revenue",
          point: {x: 0.421_5, y: 0.13},
        }),
        idempotencyKey: "cmt-003-behavior-anchor-html",
      },
      {
        anchorJson: JSON.stringify([
          "selection",
          12,
          {deep: {point: {x: 42, y: -7}}},
        ]),
        idempotencyKey: "cmt-003-behavior-anchor-array",
      },
      {
        anchorJson: JSON.stringify({
          note: "π ünïcode \"quoted\" ✅",
          tab: "a\tb\\c",
        }),
        idempotencyKey: "cmt-003-behavior-anchor-unicode",
      },
      {
        anchorJson: largestAnchorJson,
        idempotencyKey: "cmt-003-behavior-anchor-largest",
      },
      {
        anchorJson: "null",
        idempotencyKey: "cmt-003-behavior-anchor-null",
      },
    ];

    const stored = await Promise.all(storedCases.map(async (storedCase) => {
      const created = await createThread(
        server,
        installation,
        artifactId,
        versionId,
        storedCase.idempotencyKey,
        `{"anchor":${storedCase.anchorJson},"body":"Anchored comment."}`,
      );
      const createdStatus = created.status;
      const thread = createdThreadSchema.parse(await created.json()).thread;
      const detail = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${thread.id}`,
        {headers: readHeaders(installation)},
      );
      const reread = threadDetailsSchema.parse(await detail.json()).thread;
      return {
        createdAnchorJson: JSON.stringify(thread.anchor),
        createdStatus,
        detailStatus: detail.status,
        rereadAnchorJson: JSON.stringify(reread.anchor),
      };
    }));
    expect(stored.map((outcome) => outcome.createdStatus))
      .toEqual(storedCases.map(() => 201));
    expect(stored.map((outcome) => outcome.detailStatus))
      .toEqual(storedCases.map(() => 200));
    expect(stored.map((outcome) => outcome.createdAnchorJson))
      .toEqual(storedCases.map((storedCase) => storedCase.anchorJson));
    expect(stored.map((outcome) => outcome.rereadAnchorJson))
      .toEqual(storedCases.map((storedCase) => storedCase.anchorJson));

    const omitted = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-003-behavior-anchor-omitted",
      JSON.stringify({body: "No anchor at all."}),
    );
    expect(omitted.status).toBe(201);
    expect(createdThreadSchema.parse(await omitted.json()).thread.anchor)
      .toBeNull();

    const replaceable = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-003-behavior-anchor-replaced",
      `{"anchor":${JSON.stringify({kind: "page"})},"body":"Anchor to replace."}`,
    );
    expect(replaceable.status).toBe(201);
    const replaceableThread =
      createdThreadSchema.parse(await replaceable.json()).thread;
    const replacementAnchorJson = JSON.stringify({
      kind: "element",
      point: {x: 0.5, y: 0.5},
    });
    const replaced = await patchThread(
      server,
      installation,
      artifactId,
      replaceableThread.id,
      `{"anchor":${replacementAnchorJson}}`,
    );
    expect(replaced.status).toBe(200);
    expect(JSON.stringify(
      updatedThreadSchema.parse(await replaced.json()).thread.anchor,
    )).toBe(replacementAnchorJson);
  });

  test("CMT-003-F: oversize anchors and out-of-range points are refused while a valid anchor stays unchanged", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>anchored</h1>",
      idempotencyKey: "cmt-003-failure-publish",
      name: "Anchor refusal target",
    });
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;

    const keptAnchorJson = JSON.stringify({
      kind: "element",
      point: {x: 0.25, y: 0.75},
      selector: "#summary",
    });
    const kept = await createThread(
      server,
      installation,
      artifactId,
      versionId,
      "cmt-003-failure-anchor-kept",
      `{"anchor":${keptAnchorJson},"body":"This anchor must survive."}`,
    );
    expect(kept.status).toBe(201);
    const keptThread = createdThreadSchema.parse(await kept.json()).thread;

    const refusedCases: readonly {
      readonly anchorJson: string;
      readonly idempotencyKey: string;
    }[] = [
      {
        anchorJson: oversizeAnchorJson,
        idempotencyKey: "cmt-003-failure-anchor-oversize",
      },
      {
        anchorJson: JSON.stringify({point: {x: 1.5, y: 0.5}}),
        idempotencyKey: "cmt-003-failure-anchor-above-range",
      },
      {
        anchorJson: JSON.stringify({point: {x: -0.01, y: 0.5}}),
        idempotencyKey: "cmt-003-failure-anchor-below-range",
      },
      {
        anchorJson: JSON.stringify({point: {x: "0.5", y: 0.5}}),
        idempotencyKey: "cmt-003-failure-anchor-text-point",
      },
      {
        anchorJson: JSON.stringify({point: {x: 0.5}}),
        idempotencyKey: "cmt-003-failure-anchor-partial-point",
      },
    ];
    const refused = await Promise.all(refusedCases.map((refusedCase) =>
      createThread(
        server,
        installation,
        artifactId,
        versionId,
        refusedCase.idempotencyKey,
        `{"anchor":${refusedCase.anchorJson},"body":"Refused anchor."}`,
      )
    ));
    expect(refused.map((response) => response.status))
      .toEqual([422, 422, 422, 422, 422]);
    const refusedBodies = await Promise.all(
      refused.map((response) => response.json()),
    );
    for (const refusedBody of refusedBodies) {
      expect(failureSchema.parse(refusedBody).error.code).toBe("INVALID_COMMENT");
    }

    const refusedUpdate = await patchThread(
      server,
      installation,
      artifactId,
      keptThread.id,
      `{"anchor":${JSON.stringify({point: {x: 0.5, y: 12}})}}`,
    );
    expect(refusedUpdate.status).toBe(422);
    expect(failureSchema.parse(await refusedUpdate.json()).error.code)
      .toBe("INVALID_COMMENT");

    const listed = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments`,
      {headers: readHeaders(installation)},
    );
    expect(listed.status).toBe(200);
    const page = threadPageSchema.parse(await listed.json());
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page.items[0]?.anchor)).toBe(keptAnchorJson);
  });
});

function readHeaders(installation: TestInstallation): Headers {
  return new Headers({Authorization: `Bearer ${installation.apiToken}`});
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

async function patchThread(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  threadId: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}`,
    {
      body,
      headers: new Headers({
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      }),
      method: "PATCH",
    },
  );
}
