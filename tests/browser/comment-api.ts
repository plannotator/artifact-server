import {expect} from "@playwright/test";
import {z} from "zod";

import {apiHeaders} from "../support/runtime-harness.js";
import type {BrowserFixture} from "./browser-fixture.js";

/**
 * The comment shapes these browser tests read, mirroring the response shaping
 * in `src/http/create-http-app.ts` rather than the specification example.
 */
const threadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: z.object({
    displayName: z.string(),
    principalId: z.string(),
    principalKind: z.string(),
  }),
  body: z.string(),
  id: z.string(),
  path: z.string().nullable(),
  replyCount: z.number(),
  state: z.enum(["open", "resolved"]),
  versionId: z.string(),
});

const threadPageSchema = z.object({
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: threadSchema,
});

export type CommentThread = z.infer<typeof threadSchema>;

/**
 * Seed one thread the way an agent does: over the API, with a service token,
 * before anybody opens the browser.
 */
export async function createThreadOverApi(
  fixture: BrowserFixture,
  input: {
    readonly anchor?: unknown;
    readonly artifactId: string;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly path?: string;
    readonly projectId?: string;
    readonly versionId: string;
  },
): Promise<CommentThread> {
  const projectId = input.projectId ?? "prj_default";
  const draft = input.path === undefined
    ? {anchor: input.anchor ?? {kind: "page"}, body: input.body}
    : {anchor: input.anchor ?? {kind: "page"}, body: input.body, path: input.path};
  const response = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${input.artifactId}/versions/${input.versionId}/comments?projectId=${projectId}`,
    {
      body: JSON.stringify(draft),
      headers: apiHeaders(fixture.installation, input.idempotencyKey),
      method: "POST",
    },
  );
  expect(response.status).toBe(201);
  return createdThreadSchema.parse(await response.json()).thread;
}

/** Read the stored threads for one artifact straight from the API. */
export async function listThreadsOverApi(
  fixture: BrowserFixture,
  artifactId: string,
  projectId = "prj_default",
): Promise<readonly CommentThread[]> {
  const response = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/comments?projectId=${projectId}`,
    {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
  );
  expect(response.status).toBe(200);
  return threadPageSchema.parse(await response.json()).items;
}
