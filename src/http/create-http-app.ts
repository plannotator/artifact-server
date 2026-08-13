import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  type ApplicationRuntime,
  runApplicationEffect,
} from "../application/application-runtime.js";
import { PublishArtifactService } from "../application/publish-artifact.js";
import { StagedUploadService } from "../application/staged-upload.js";
import {
  ArtifactNotFound,
  type ArtifactServerFailure,
  ContentNotPublic,
  errorCodes,
  type ErrorCode,
  InlineContentTooLarge,
  isArtifactServerFailure,
} from "../core/errors.js";
import {
  accessSettings,
  type ManifestEntry,
  type PublishedVersion,
} from "../core/model.js";
import type { ArtifactRepository, BlobStore } from "../core/ports.js";
import { manifestPathFromUrl } from "../manifest/create-manifest.js";

const maximumInlineBytes = 1_048_576;
const maximumInlineRequestBytes = 1_500_000;
const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const inlineFileSchema = z.object({
  contentBase64: z.base64(),
  mediaType: z.string().trim().min(1).max(200),
  path: z.string().min(1).max(1_024),
});
const publishNewSchema = z.object({
  accessSetting: accessSettingSchema,
  file: inlineFileSchema,
  name: z.string().min(1).max(200),
});
const publishVersionSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  file: inlineFileSchema,
});
const declaredFileSchema = z.object({
  mediaType: z.string().trim().min(1).max(200),
  path: z.string().min(1).max(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const createUploadSchema = z.object({
  entryPath: z.string().min(1).max(1_024),
  files: z.array(declaredFileSchema).min(1).max(10_000),
});
const commitUploadSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({
      accessSetting: accessSettingSchema,
      kind: z.literal("new_artifact"),
      name: z.string().min(1).max(200),
    }),
    z.object({
      artifactId: z.string().min(1).max(200),
      expectedCurrentVersionId: z.string().min(1).max(200),
      kind: z.literal("new_version"),
    }),
  ]),
});
const contentTokenSchema = z
  .string()
  .min(16)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/u);
const bearerSchema = z
  .string()
  .regex(/^Bearer [A-Za-z0-9._~-]+$/u)
  .transform((value) => value.slice("Bearer ".length));

export interface HttpAppDependencies {
  readonly apiToken: string;
  readonly applicationRuntime: ApplicationRuntime;
  readonly blobs: BlobStore;
  readonly contentDomain: string;
  readonly repository: ArtifactRepository;
}

export function createHttpApp(dependencies: HttpAppDependencies): Hono {
  const app = new Hono();
  const boundedJsonBody = bodyLimit({
    maxSize: maximumInlineRequestBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The JSON request body exceeds the local API limit.",
          },
        },
        413,
      ),
  });

  app.use("*", async (context, next) => {
    const requestUrl = new URL(context.req.url);
    const contentToken = tokenFromContentHost(
      requestUrl.hostname,
      dependencies.contentDomain,
    );
    if (contentToken !== null) {
      return serveVersionContent(
        context.req.method,
        requestUrl,
        contentToken,
        dependencies,
      );
    }
    return next();
  });

  app.use("/api/*", async (context, next) => {
    if (!authorized(context.req.header("authorization"), dependencies.apiToken)) {
      return context.json(
        {
          error: {
            code: errorCodes.authenticationRequired,
            message: "A valid local API token is required.",
          },
        },
        401,
        {"WWW-Authenticate": "Bearer"},
      );
    }
    return next();
  });

  app.get("/health", (context) =>
    context.json({status: "ok" as const}),
  );

  app.post("/api/v1/artifacts", boundedJsonBody, async (context) => {
    const body = publishNewSchema.parse(await context.req.json());
    const bytes = decodeInlineBytes(body.file.contentBase64);
    const result = await runApplicationEffect(
      dependencies.applicationRuntime,
      PublishArtifactService.use((publish) =>
        publish.publishNew({
          accessSetting: body.accessSetting,
          bytes,
          idempotencyKey: requiredIdempotencyKey(
            context.req.header("idempotency-key"),
          ),
          mediaType: body.file.mediaType,
          name: body.name,
          path: body.file.path,
        })
      ),
    );
    return context.json(
      publishResponse(new URL(context.req.url), dependencies.contentDomain, result),
      result.replayed ? 200 : 201,
    );
  });

  app.post("/api/v1/artifacts/:artifactId/versions", boundedJsonBody, async (context) => {
    const body = publishVersionSchema.parse(await context.req.json());
    const bytes = decodeInlineBytes(body.file.contentBase64);
    const result = await runApplicationEffect(
      dependencies.applicationRuntime,
      PublishArtifactService.use((publish) =>
        publish.publishVersion({
          artifactId: context.req.param("artifactId"),
          bytes,
          expectedCurrentVersionId: body.expectedCurrentVersionId,
          idempotencyKey: requiredIdempotencyKey(
            context.req.header("idempotency-key"),
          ),
          mediaType: body.file.mediaType,
          path: body.file.path,
        })
      ),
    );
    return context.json(
      publishResponse(new URL(context.req.url), dependencies.contentDomain, result),
      result.replayed ? 200 : 201,
    );
  });

  app.post("/api/v1/uploads", boundedJsonBody, async (context) => {
    const body = createUploadSchema.parse(await context.req.json());
    const upload = await runApplicationEffect(
      dependencies.applicationRuntime,
      StagedUploadService.use((stagedUploads) =>
        stagedUploads.createUpload({
          entryPath: body.entryPath,
          files: body.files,
          principalId: "local-api-token",
        })
      ),
    );
    const requestUrl = new URL(context.req.url);
    return context.json({
      commitUrl: new URL(`/api/v1/uploads/${upload.id}/commit`, requestUrl).toString(),
      expiresAt: upload.expiresAt,
      files: upload.files.map((file) => ({
        method: "PUT" as const,
        path: file.entry.path,
        size: file.entry.size,
        uploadUrl: new URL(
          `/api/v1/uploads/${upload.id}/files/${file.storageToken}`,
          requestUrl,
        ).toString(),
      })),
      manifestDigest: upload.manifest.digest,
      uploadId: upload.id,
    }, 201);
  });

  app.put("/api/v1/uploads/:uploadId/files/:storageToken", async (context) => {
    const body = context.req.raw.body ?? emptyByteStream();
    const upload = await runApplicationEffect(
      dependencies.applicationRuntime,
      StagedUploadService.use((stagedUploads) =>
        stagedUploads.uploadFile({
          body,
          principalId: "local-api-token",
          storageToken: context.req.param("storageToken"),
          uploadId: context.req.param("uploadId"),
        })
      ),
    );
    const file = upload.files.find(
      (candidate) => candidate.storageToken === context.req.param("storageToken"),
    );
    if (file === undefined) {
      throw new Error("A staged file disappeared after it was marked as uploaded.");
    }
    return context.json({
      path: file.entry.path,
      status: "verified" as const,
      uploadId: upload.id,
    });
  });

  app.post(
    "/api/v1/uploads/:uploadId/commit",
    boundedJsonBody,
    async (context) => {
      const body = commitUploadSchema.parse(await context.req.json());
      const result = await runApplicationEffect(
        dependencies.applicationRuntime,
        StagedUploadService.use((stagedUploads) =>
          stagedUploads.commitUpload({
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principalId: "local-api-token",
            target: body.target,
            uploadId: context.req.param("uploadId"),
          })
        ),
      );
      return context.json(
        publishResponse(
          new URL(context.req.url),
          dependencies.contentDomain,
          result,
        ),
        result.replayed ? 200 : 201,
      );
    },
  );

  app.get("/artifacts/:artifactId", async (context) => {
    const current = await dependencies.repository.findCurrentVersion(
      context.req.param("artifactId"),
    );
    if (current === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    if (current.artifact.accessSetting !== accessSettings.publicLink) {
      throw new ContentNotPublic({
        message: "This first implementation slice opens public-link artifacts only.",
      });
    }
    const versionUrl = buildVersionUrl(
      new URL(context.req.url),
      dependencies.contentDomain,
      current.version.contentToken,
    );
    return context.redirect(versionUrl, 302);
  });

  app.notFound((context) =>
    context.json(
      {error: {code: "NOT_FOUND", message: "The requested route does not exist."}},
      404,
    ),
  );

  app.onError((error, context) => {
    if (isArtifactServerFailure(error)) {
      const response = httpFailure(error);
      return Response.json(
        {error: {code: response.code, message: response.message}},
        {status: response.status},
      );
    }
    if (error instanceof z.ZodError) {
      return context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The request body does not match the publishing contract.",
          },
        },
        422,
      );
    }
    if (error instanceof SyntaxError) {
      return context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The request body is not valid JSON.",
          },
        },
        400,
      );
    }
    console.error("Unhandled Artifact Server error:", error.name);
    return context.json(
      {error: {code: "INTERNAL_ERROR", message: "The server could not complete the request."}},
      500,
    );
  });

  return app;
}

interface PublishResponse {
  readonly artifact: PublishedVersion["artifact"];
  readonly links: {
    readonly artifact: string;
    readonly version: string;
  };
  readonly replayed: boolean;
  readonly version: PublishedVersion["version"];
}

interface HttpFailure {
  readonly code: ErrorCode | "INTERNAL_ERROR";
  readonly message: string;
  readonly status: number;
}

function httpFailure(failure: ArtifactServerFailure): HttpFailure {
  switch (failure._tag) {
    case "ArtifactNotFound":
      return {
        code: errorCodes.artifactNotFound,
        message: failure.message,
        status: 404,
      };
    case "InvalidArtifactName":
    case "InvalidIdempotencyKey":
    case "EmptyManifest":
    case "MissingManifestEntry":
    case "InvalidManifestFile":
    case "UploadedFileMismatch":
      return {
        code: errorCodes.invalidInput,
        message: failure.message,
        status: 422,
      };
    case "InvalidManifestPath":
      return {
        code: errorCodes.invalidManifestPath,
        message: failure.message,
        status: 422,
      };
    case "InlineContentTooLarge":
      return {
        code: errorCodes.invalidInput,
        message: failure.message,
        status: 413,
      };
    case "IdempotencyConflict":
      return {
        code: errorCodes.idempotencyConflict,
        message: failure.message,
        status: 409,
      };
    case "PublishConflict":
      return {
        code: errorCodes.publishConflict,
        message: failure.message,
        status: 409,
      };
    case "UploadClosed":
      return {
        code: errorCodes.uploadClosed,
        message: failure.message,
        status: 409,
      };
    case "UploadExpired":
      return {
        code: errorCodes.uploadExpired,
        message: failure.message,
        status: 410,
      };
    case "UploadFileNotFound":
      return {
        code: errorCodes.uploadFileNotFound,
        message: failure.message,
        status: 404,
      };
    case "UploadIncomplete":
      return {
        code: errorCodes.uploadIncomplete,
        message: failure.message,
        status: 409,
      };
    case "UploadNotFound":
      return {
        code: errorCodes.uploadNotFound,
        message: failure.message,
        status: 404,
      };
    case "ContentNotPublic":
      return {
        code: errorCodes.contentNotPublic,
        message: failure.message,
        status: 401,
      };
    case "ArtifactRepositoryFailure":
    case "BlobStorageFailure":
    case "StagingStorageFailure":
      console.error("Artifact Server adapter failure:", failure._tag);
      return {
        code: "INTERNAL_ERROR",
        message: "The server could not complete the request.",
        status: 500,
      };
  }
  return casesHandled(failure);
}

function publishResponse(
  requestUrl: URL,
  contentDomain: string,
  published: PublishedVersion,
): PublishResponse {
  const artifactUrl = new URL(`/artifacts/${published.artifact.id}`, requestUrl);
  const versionUrl = buildVersionUrl(
    requestUrl,
    contentDomain,
    published.version.contentToken,
  );
  return {
    artifact: published.artifact,
    links: {
      artifact: artifactUrl.toString(),
      version: versionUrl,
    },
    replayed: published.replayed,
    version: published.version,
  };
}

async function serveVersionContent(
  method: string,
  requestUrl: URL,
  contentToken: string,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return Response.json(
      {error: {code: errorCodes.methodNotAllowed, message: "Only GET and HEAD are supported."}},
      {status: 405, headers: {Allow: "GET, HEAD"}},
    );
  }

  const requestedPath = manifestPathFromUrl(requestUrl.pathname);
  if (requestedPath === null) {
    return versionNotFoundResponse();
  }
  const content = await dependencies.repository.findVersionContent(
    contentToken,
    requestedPath,
  );
  if (content === null) {
    return versionNotFoundResponse();
  }
  if (
    content.accessSetting !== accessSettings.publicLink ||
    !content.isCurrent
  ) {
    return Response.json(
      {
        error: {
          code: errorCodes.contentNotPublic,
          message: "This artifact version requires an authorized content session.",
        },
      },
      {status: 401, headers: {"Cache-Control": "private, no-store"}},
    );
  }

  if (method === "HEAD") {
    const blob = await dependencies.blobs.inspect(content.entry.sha256);
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
    return new Response(null, {
      headers: contentHeaders(content.entry, blob.size),
      status: 200,
    });
  }

  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  return new Response(blob.body, {
    headers: contentHeaders(content.entry, blob.size),
    status: 200,
  });
}

function contentHeaders(
  entry: ManifestEntry,
  size: number,
): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": entry.disposition,
    "Content-Length": String(size),
    "Content-Type": entry.mediaType,
    ETag: `"${entry.sha256}"`,
    "X-Content-Type-Options": "nosniff",
  });
}

function assertBlobSize(actual: number, expected: number, digest: string): void {
  if (actual !== expected) {
    throw new Error(
      `Stored blob ${digest} is ${actual} bytes but its manifest records ${expected}.`,
    );
  }
}

function versionNotFoundResponse(): Response {
  return Response.json(
    {error: {code: errorCodes.versionNotFound, message: "The version file does not exist."}},
    {status: 404},
  );
}

function authorized(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const parsed = bearerSchema.safeParse(authorizationHeader);
  if (!parsed.success) return false;
  const actual = Buffer.from(parsed.data);
  const expected = Buffer.from(expectedToken);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function requiredIdempotencyKey(header: string | undefined): string {
  return z.string().min(16).max(200).parse(header);
}

function decodeInlineBytes(contentBase64: string): Uint8Array {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength > maximumInlineBytes) {
    throw new InlineContentTooLarge({
      message: `Inline content is limited to ${maximumInlineBytes} bytes.`,
    });
  }
  return bytes;
}

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function tokenFromContentHost(
  hostname: string,
  contentDomain: string,
): string | null {
  const suffix = `.${contentDomain.toLocaleLowerCase("en-US")}`;
  const normalizedHostname = hostname.toLocaleLowerCase("en-US");
  if (!normalizedHostname.endsWith(suffix)) return null;
  const candidate = normalizedHostname.slice(0, -suffix.length);
  const parsed = contentTokenSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function buildVersionUrl(
  requestUrl: URL,
  contentDomain: string,
  contentToken: string,
): string {
  const versionUrl = new URL(requestUrl);
  versionUrl.hostname = `${contentToken}.${contentDomain}`;
  versionUrl.pathname = "/";
  versionUrl.search = "";
  versionUrl.hash = "";
  return versionUrl.toString();
}

function casesHandled(value: never): never {
  throw new Error(`Unhandled Artifact Server failure: ${String(value)}`);
}
