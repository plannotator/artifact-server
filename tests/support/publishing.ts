import { z } from "zod";
import { createHash } from "node:crypto";

import type {
  RunningTestServer,
  TestInstallation,
} from "./runtime-harness.js";
import { apiHeaders } from "./runtime-harness.js";

const publishResponseSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    createdAt: z.string(),
    currentVersionId: z.string(),
    deletedAt: z.string().nullable(),
    id: z.string(),
    name: z.string(),
    ownerPrincipalId: z.string(),
  }),
  links: z.object({artifact: z.url(), version: z.url()}),
  replayed: z.boolean(),
  version: z.object({
    artifactId: z.string(),
    contentToken: z.string(),
    createdAt: z.string(),
    entryPath: z.string(),
    id: z.string(),
    manifestDigest: z.string(),
    number: z.number().int().positive(),
    publisherPrincipalId: z.string(),
    routingMode: z.literal("static"),
  }),
});

export type PublishResponse = z.infer<typeof publishResponseSchema>;

const createUploadResponseSchema = z.object({
  commitUrl: z.url(),
  expiresAt: z.string(),
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    uploadUrl: z.url(),
  })),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  uploadId: z.string(),
});

export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

export interface TestSiteFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
}

export function parsePublishResponse(value: z.input<typeof publishResponseSchema>): PublishResponse {
  return publishResponseSchema.parse(value);
}

export interface PublishNewInput {
  readonly accessSetting: "account_required" | "public_link";
  readonly content: string;
  readonly idempotencyKey: string;
  readonly mediaType?: string;
  readonly name?: string;
  readonly path?: string;
}

export interface PublishVersionInput {
  readonly artifactId: string;
  readonly content: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly mediaType?: string;
  readonly path?: string;
}

export async function publishNew(
  server: RunningTestServer,
  installation: TestInstallation,
  input: PublishNewInput,
): Promise<{readonly body: PublishResponse; readonly response: Response}> {
  const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
    body: JSON.stringify({
      accessSetting: input.accessSetting,
      file: {
        contentBase64: Buffer.from(input.content).toString("base64"),
        mediaType: input.mediaType ?? "text/html; charset=utf-8",
        path: input.path ?? "index.html",
      },
      name: input.name ?? "Test artifact",
    }),
    headers: apiHeaders(installation, input.idempotencyKey),
    method: "POST",
  });
  const body = publishResponseSchema.parse(await response.json());
  return {body, response};
}

export async function publishVersion(
  server: RunningTestServer,
  installation: TestInstallation,
  input: PublishVersionInput,
): Promise<{readonly body: PublishResponse; readonly response: Response}> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${input.artifactId}/versions`,
    {
      body: JSON.stringify({
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        file: {
          contentBase64: Buffer.from(input.content).toString("base64"),
          mediaType: input.mediaType ?? "text/html; charset=utf-8",
          path: input.path ?? "index.html",
        },
      }),
      headers: apiHeaders(installation, input.idempotencyKey),
      method: "POST",
    },
  );
  const body = publishResponseSchema.parse(await response.json());
  return {body, response};
}

export async function createStagedUpload(
  server: RunningTestServer,
  installation: TestInstallation,
  entryPath: string,
  files: readonly TestSiteFile[],
): Promise<{readonly body: CreateUploadResponse; readonly response: Response}> {
  const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath,
      files: files.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        size: file.bytes.byteLength,
      })),
    }),
    headers: {
      Authorization: `Bearer ${installation.apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = createUploadResponseSchema.parse(await response.json());
  return {body, response};
}

export async function uploadStagedFile(
  installation: TestInstallation,
  file: CreateUploadResponse["files"][number],
  bytes: Uint8Array,
): Promise<Response> {
  return fetch(file.uploadUrl, {
    body: copiedArrayBuffer(bytes),
    headers: {Authorization: `Bearer ${installation.apiToken}`},
    method: "PUT",
  });
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function uploadEveryStagedFile(
  installation: TestInstallation,
  upload: CreateUploadResponse,
  files: readonly TestSiteFile[],
): Promise<readonly Response[]> {
  return Promise.all(upload.files.map((planned) => {
    const file = files.find((candidate) => candidate.path === planned.path);
    if (file === undefined) {
      throw new Error(`The test fixture does not contain ${planned.path}.`);
    }
    return uploadStagedFile(installation, planned, file.bytes);
  }));
}

export async function commitStagedUpload(
  installation: TestInstallation,
  upload: CreateUploadResponse,
  idempotencyKey: string,
  target: z.input<typeof commitTargetSchema>,
): Promise<{readonly body: PublishResponse; readonly response: Response}> {
  const response = await fetch(upload.commitUrl, {
    body: JSON.stringify({target}),
    headers: apiHeaders(installation, idempotencyKey),
    method: "POST",
  });
  const body = publishResponseSchema.parse(await response.json());
  return {body, response};
}

const commitTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    kind: z.literal("new_artifact"),
    name: z.string(),
  }),
  z.object({
    artifactId: z.string(),
    expectedCurrentVersionId: z.string(),
    kind: z.literal("new_version"),
  }),
]);
