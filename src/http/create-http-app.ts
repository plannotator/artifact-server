import { Redacted } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  type ApplicationRuntime,
  runApplicationEffect,
} from "../application/application-runtime.js";
import { PublishArtifactService } from "../application/publish-artifact.js";
import { StagedUploadService } from "../application/staged-upload.js";
import { AuthenticationService } from "../application/authentication.js";
import {
  type ArtifactDetails,
  ArtifactManagementService,
} from "../application/artifact-management.js";
import {
  type ArtifactComparison,
  CompareArtifactService,
} from "../application/compare-artifact.js";
import { ContentAccessService } from "../application/content-access.js";
import {
  AuthenticationRequired,
  type ArtifactServerFailure,
  ContentBootstrapRejected,
  errorCodes,
  type ErrorCode,
  InlineContentTooLarge,
  InvalidPagination,
  isArtifactServerFailure,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type ArtifactActionPage,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactState,
  type ArtifactVersion,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type VersionRecord,
} from "../core/model.js";
import type { BlobStore } from "../core/ports.js";
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
const artifactTagsSchema = z.array(z.string()).default([]);
const publishNewSchema = z.object({
  accessSetting: accessSettingSchema.default(accessSettings.accountRequired),
  file: inlineFileSchema,
  name: z.string().min(1).max(200),
  tags: artifactTagsSchema,
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
      accessSetting: accessSettingSchema.default(accessSettings.accountRequired),
      kind: z.literal("new_artifact"),
      name: z.string().min(1).max(200),
      tags: artifactTagsSchema,
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
const contentSessionTokenSchema = z
  .string()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u);
const contentBootstrapQueryParameter = "__artifact_bootstrap";
const contentSessionCookieName = "__Host-artifact_content";
const restoreVersionSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
});
const changeAccessSchema = z.object({
  accessSetting: accessSettingSchema,
  expectedCurrentVersionId: z.string().min(1).max(200),
});
const changeTagsSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  tags: artifactTagsSchema,
});
const comparisonQuerySchema = z.object({
  fromVersionId: z.string().min(1).max(200),
  toVersionId: z.string().min(1).max(200),
});
const deleteArtifactSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
});
const pageQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: z.string().max(200).optional(),
});
const pageCursorSchema = z.object({
  createdAt: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
}).strict();
const pageCursorTokenSchema = z.string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

interface HttpEnvironment {
  readonly Variables: {
    readonly principal: Principal;
  };
}

export interface HttpAppDependencies {
  readonly applicationRuntime: ApplicationRuntime;
  readonly blobs: BlobStore;
  readonly contentDomain: string;
}

export function createHttpApp(
  dependencies: HttpAppDependencies,
): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>();
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
      if (isContentBootstrapRequest(requestUrl)) {
        return exchangeContentBootstrap(
          context.req.method,
          requestUrl,
          contentToken,
          dependencies,
        );
      }
      return serveVersionContent(
        context.req.method,
        requestUrl,
        contentToken,
        context.req.header("cookie"),
        dependencies,
      );
    }
    return next();
  });

  app.use("/api/*", async (context, next) => {
    const parsed = bearerSchema.safeParse(context.req.header("authorization"));
    if (!parsed.success) {
      throw new AuthenticationRequired({
        message: "A valid local API token is required.",
      });
    }
    const principal = await runApplicationEffect(
      dependencies.applicationRuntime,
      AuthenticationService.use((authentication) =>
        authentication.authenticateBearer(
          Redacted.make(parsed.data, {label: "bearer-credential"}),
        )
      ),
    );
    context.set("principal", principal);
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
          principal: context.get("principal"),
          tags: body.tags,
        })
      ),
    );
    return context.json(
      publishResponse(new URL(context.req.url), dependencies.contentDomain, result),
      result.replayed ? 200 : 201,
    );
  });

  app.get("/api/v1/artifacts", async (context) => {
    const query = pageQuerySchema.parse(context.req.query());
    const page = await runApplicationEffect(
      dependencies.applicationRuntime,
      ArtifactManagementService.use((management) =>
        management.listArtifacts({
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
          tag: query.tag ?? null,
        })
      ),
    );
    return context.json(artifactPageResponse(
      new URL(context.req.url),
      page,
    ));
  });

  app.get("/api/v1/artifacts/:artifactId", async (context) => {
    const details = await runApplicationEffect(
      dependencies.applicationRuntime,
      ArtifactManagementService.use((management) =>
        management.getArtifact({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
        })
      ),
    );
    return context.json(artifactDetailsResponse(
      new URL(context.req.url),
      dependencies.contentDomain,
      details,
    ));
  });

  app.get("/api/v1/artifacts/:artifactId/versions", async (context) => {
    const versions = await runApplicationEffect(
      dependencies.applicationRuntime,
      ArtifactManagementService.use((management) =>
        management.listVersions({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
        })
      ),
    );
    const requestUrl = new URL(context.req.url);
    return context.json({
      artifactId: context.req.param("artifactId"),
      versions: versions.map((version) => versionResponse(
        requestUrl,
        dependencies.contentDomain,
        version,
      )),
    });
  });

  app.get("/api/v1/artifacts/:artifactId/actions", async (context) => {
    const query = pageQuerySchema.parse(context.req.query());
    const page = await runApplicationEffect(
      dependencies.applicationRuntime,
      ArtifactManagementService.use((management) =>
        management.listArtifactActions({
          artifactId: context.req.param("artifactId"),
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          principal: context.get("principal"),
        })
      ),
    );
    return context.json(artifactActionPageResponse(page));
  });

  app.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId",
    async (context) => {
      const saved = await runApplicationEffect(
        dependencies.applicationRuntime,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json(artifactVersionResponse(
        new URL(context.req.url),
        dependencies.contentDomain,
        saved,
      ));
    },
  );

  app.get("/api/v1/artifacts/:artifactId/comparisons", async (context) => {
    const query = comparisonQuerySchema.parse(context.req.query());
    const comparison = await runApplicationEffect(
      dependencies.applicationRuntime,
      CompareArtifactService.use((comparisons) =>
        comparisons.compareVersions({
          artifactId: context.req.param("artifactId"),
          fromVersionId: query.fromVersionId,
          principal: context.get("principal"),
          toVersionId: query.toVersionId,
        })
      ),
    );
    return context.json(comparisonResponse(
      new URL(context.req.url),
      dependencies.contentDomain,
      comparison,
    ));
  });

  app.post(
    "/api/v1/artifacts/:artifactId/restore",
    boundedJsonBody,
    async (context) => {
      const body = restoreVersionSchema.parse(await context.req.json());
      const state = await runApplicationEffect(
        dependencies.applicationRuntime,
        ArtifactManagementService.use((management) =>
          management.restoreVersion({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            versionId: body.versionId,
          })
        ),
      );
      return context.json(artifactStateResponse(
        new URL(context.req.url),
        dependencies.contentDomain,
        state,
      ));
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/access",
    boundedJsonBody,
    async (context) => {
      const body = changeAccessSchema.parse(await context.req.json());
      const state = await runApplicationEffect(
        dependencies.applicationRuntime,
        ArtifactManagementService.use((management) =>
          management.changeAccess({
            accessSetting: body.accessSetting,
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
          })
        ),
      );
      return context.json({
        ...artifactStateResponse(
          new URL(context.req.url),
          dependencies.contentDomain,
          state,
        ),
        warning: body.accessSetting === accessSettings.accountRequired
          ? "New public requests are blocked. Copies already downloaded or cached outside Artifact Server cannot be recalled."
          : null,
      });
    },
  );

  app.patch(
    "/api/v1/artifacts/:artifactId/tags",
    boundedJsonBody,
    async (context) => {
      const body = changeTagsSchema.parse(await context.req.json());
      const state = await runApplicationEffect(
        dependencies.applicationRuntime,
        ArtifactManagementService.use((management) =>
          management.changeTags({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
            tags: body.tags,
          })
        ),
      );
      return context.json(artifactStateResponse(
        new URL(context.req.url),
        dependencies.contentDomain,
        state,
      ));
    },
  );

  app.delete(
    "/api/v1/artifacts/:artifactId",
    boundedJsonBody,
    async (context) => {
      const body = deleteArtifactSchema.parse(await context.req.json());
      const deletion = await runApplicationEffect(
        dependencies.applicationRuntime,
        ArtifactManagementService.use((management) =>
          management.deleteArtifact({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            principal: context.get("principal"),
          })
        ),
      );
      return context.json(deletionResponse(deletion));
    },
  );

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
          principal: context.get("principal"),
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
          principal: context.get("principal"),
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
          principal: context.get("principal"),
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
            principal: context.get("principal"),
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

  app.post("/api/v1/artifacts/:artifactId/content-sessions", async (context) => {
    const issued = await runApplicationEffect(
      dependencies.applicationRuntime,
      ContentAccessService.use((contentAccess) =>
        contentAccess.issueContentBootstrap({
          artifactId: context.req.param("artifactId"),
          principal: context.get("principal"),
          target: {kind: "current"},
        })
      ),
    );
    return context.json({
      bootstrapUrl: buildContentBootstrapUrl(
        new URL(context.req.url),
        dependencies.contentDomain,
        issued.contentToken,
        Redacted.value(issued.token),
      ),
      expiresAt: issued.expiresAt,
      versionId: issued.versionId,
    }, 201);
  });

  app.post(
    "/api/v1/artifacts/:artifactId/versions/:versionId/content-sessions",
    async (context) => {
      const issued = await runApplicationEffect(
        dependencies.applicationRuntime,
        ContentAccessService.use((contentAccess) =>
          contentAccess.issueContentBootstrap({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            target: {
              kind: "version",
              versionId: context.req.param("versionId"),
            },
          })
        ),
      );
      return context.json({
        bootstrapUrl: buildContentBootstrapUrl(
          new URL(context.req.url),
          dependencies.contentDomain,
          issued.contentToken,
          Redacted.value(issued.token),
        ),
        expiresAt: issued.expiresAt,
        versionId: issued.versionId,
      }, 201);
    },
  );

  app.get("/artifacts/:artifactId", async (context) => {
    const current = await runApplicationEffect(
      dependencies.applicationRuntime,
      ContentAccessService.use((contentAccess) =>
        contentAccess.resolvePublicArtifact(context.req.param("artifactId"))
      ),
    );
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
      const headers = new Headers();
      if (response.status === 401) {
        headers.set("Cache-Control", "private, no-store");
      }
      if (error._tag === "AuthenticationRequired") {
        headers.set("WWW-Authenticate", "Bearer");
      }
      return Response.json(
        {error: {code: response.code, message: response.message}},
        {
          headers,
          status: response.status,
        },
      );
    }
    if (error instanceof z.ZodError) {
      return context.json(
        {
          error: {
            code: errorCodes.invalidInput,
            message: "The request does not match the API contract.",
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
    case "ArtifactMutationConflict":
      return {
        code: errorCodes.artifactMutationConflict,
        message: failure.message,
        status: 409,
      };
    case "AuthenticationRequired":
      return {
        code: errorCodes.authenticationRequired,
        message: failure.message,
        status: 401,
      };
    case "AuthorizationDenied":
      return {
        code: errorCodes.authorizationDenied,
        message: failure.message,
        status: 403,
      };
    case "ContentBootstrapRejected":
      return {
        code: errorCodes.contentBootstrapRejected,
        message: failure.message,
        status: 401,
      };
    case "ContentSessionRequired":
      return {
        code: errorCodes.contentNotPublic,
        message: failure.message,
        status: 401,
      };
    case "InvalidArtifactName":
    case "InvalidArtifactTags":
    case "InvalidIdempotencyKey":
    case "InvalidPagination":
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
    case "VersionNotFound":
      return {
        code: errorCodes.versionNotFound,
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

function artifactDetailsResponse(
  requestUrl: URL,
  contentDomain: string,
  details: ArtifactDetails,
) {
  return {
    artifact: details.artifact,
    current: artifactVersionResponse(requestUrl, contentDomain, details.current),
    links: {
      artifact: new URL(`/artifacts/${details.artifact.id}`, requestUrl).toString(),
      management: new URL(
        `/api/v1/artifacts/${details.artifact.id}`,
        requestUrl,
      ).toString(),
    },
  };
}

function artifactPageResponse(
  requestUrl: URL,
  page: ArtifactPage,
) {
  return {
    artifacts: page.items.map((artifact) => ({
      artifact,
      links: {
        artifact: new URL(`/artifacts/${artifact.id}`, requestUrl).toString(),
        management: new URL(
          `/api/v1/artifacts/${artifact.id}`,
          requestUrl,
        ).toString(),
      },
    })),
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function artifactActionPageResponse(page: ArtifactActionPage) {
  return {
    actions: page.items,
    nextCursor: encodePageCursor(page.nextCursor),
  };
}

function deletionResponse(deletion: ArtifactDeletion) {
  return {
    artifact: deletion.artifact,
    replayed: deletion.replayed,
    retainedVersionCount: deletion.retainedVersionCount,
  };
}

function decodePageCursor(token: string | undefined): PageCursor | null {
  if (token === undefined) return null;
  const parsedToken = pageCursorTokenSchema.safeParse(token);
  if (!parsedToken.success) return invalidPageCursor();
  try {
    const decoded = JSON.parse(
      Buffer.from(parsedToken.data, "base64url").toString("utf8"),
    );
    const cursor = pageCursorSchema.safeParse(decoded);
    if (cursor.success) return cursor.data;
  } catch {
    return invalidPageCursor();
  }
  return invalidPageCursor();
}

function encodePageCursor(cursor: PageCursor | null): string | null {
  return cursor === null
    ? null
    : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function invalidPageCursor(): never {
  throw new InvalidPagination({
    message: "The page cursor is invalid or no longer supported.",
  });
}

function artifactVersionResponse(
  requestUrl: URL,
  contentDomain: string,
  saved: ArtifactVersion,
) {
  return {
    manifest: {
      digest: saved.manifest.digest,
      entries: saved.manifest.entries,
      entryPath: saved.manifest.entryPath,
      routingMode: saved.manifest.routingMode,
    },
    ...versionResponse(requestUrl, contentDomain, saved.version),
  };
}

function versionResponse(
  requestUrl: URL,
  contentDomain: string,
  version: VersionRecord,
) {
  return {
    links: {
      version: buildVersionUrl(
        requestUrl,
        contentDomain,
        version.contentToken,
      ),
    },
    version,
  };
}

function artifactStateResponse(
  requestUrl: URL,
  contentDomain: string,
  state: ArtifactState,
) {
  return {
    artifact: state.artifact,
    links: {
      artifact: new URL(`/artifacts/${state.artifact.id}`, requestUrl).toString(),
      version: buildVersionUrl(
        requestUrl,
        contentDomain,
        state.version.contentToken,
      ),
    },
    replayed: state.replayed,
    version: state.version,
  };
}

function comparisonResponse(
  requestUrl: URL,
  contentDomain: string,
  comparison: ArtifactComparison,
) {
  return {
    ...comparison,
    changed: comparison.changed.map((change) => ({
      ...change,
      links: {
        after: buildVersionFileUrl(
          requestUrl,
          contentDomain,
          comparison.to.contentToken,
          change.after.path,
        ),
        before: buildVersionFileUrl(
          requestUrl,
          contentDomain,
          comparison.from.contentToken,
          change.before.path,
        ),
      },
    })),
    links: {
      from: buildVersionUrl(
        requestUrl,
        contentDomain,
        comparison.from.contentToken,
      ),
      to: buildVersionUrl(
        requestUrl,
        contentDomain,
        comparison.to.contentToken,
      ),
    },
  };
}

async function serveVersionContent(
  method: string,
  requestUrl: URL,
  contentToken: string,
  cookieHeader: string | undefined,
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
  const content = await runApplicationEffect(
    dependencies.applicationRuntime,
    ContentAccessService.use((contentAccess) =>
      contentAccess.authorizeVersionContent({
        contentToken,
        path: requestedPath,
        sessionToken: contentSessionToken(cookieHeader),
      })
    ),
  );
  if (content === null) {
    return versionNotFoundResponse();
  }
  const publiclyCacheable = content.accessSetting === accessSettings.publicLink &&
    content.isCurrent;

  if (method === "HEAD") {
    const blob = await dependencies.blobs.inspect(content.entry.sha256);
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
    return new Response(null, {
      headers: contentHeaders(content.entry, blob.size, publiclyCacheable),
      status: 200,
    });
  }

  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  return new Response(blob.body, {
    headers: contentHeaders(content.entry, blob.size, publiclyCacheable),
    status: 200,
  });
}

function contentHeaders(
  entry: ManifestEntry,
  size: number,
  publiclyCacheable: boolean,
): Headers {
  return new Headers({
    "Cache-Control": publiclyCacheable
      ? "public, max-age=31536000, immutable"
      : "private, no-store",
    "Content-Disposition": entry.disposition,
    "Content-Length": String(size),
    "Content-Type": entry.mediaType,
    ETag: `"${entry.sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
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

function requiredIdempotencyKey(header: string | undefined): string {
  return z.string().min(16).max(200).parse(header);
}

async function exchangeContentBootstrap(
  method: string,
  requestUrl: URL,
  contentToken: string,
  dependencies: HttpAppDependencies,
): Promise<Response> {
  if (method !== "GET") {
    return Response.json(
      {error: {code: errorCodes.methodNotAllowed, message: "Only GET is supported."}},
      {status: 405, headers: {Allow: "GET"}},
    );
  }
  const parsed = contentSessionTokenSchema.safeParse(
    requestUrl.searchParams.get(contentBootstrapQueryParameter),
  );
  if (!parsed.success) {
    throw new ContentBootstrapRejected({
      message: "The private-content bootstrap is invalid or no longer available.",
    });
  }
  const issued = await runApplicationEffect(
    dependencies.applicationRuntime,
    ContentAccessService.use((contentAccess) =>
      contentAccess.exchangeContentBootstrap({
        contentToken,
        token: Redacted.make(parsed.data, {label: "content-bootstrap-token"}),
      })
    ),
  );
  const cleanUrl = new URL(requestUrl);
  cleanUrl.pathname = "/";
  cleanUrl.search = "";
  cleanUrl.hash = "";
  return new Response(null, {
    headers: {
      "Cache-Control": "private, no-store",
      Location: cleanUrl.toString(),
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": contentSessionCookie(
        Redacted.value(issued.token),
        issued.expiresAt,
      ),
    },
    status: 303,
  });
}

function contentSessionCookie(token: string, expiresAt: string): string {
  return `${contentSessionCookieName}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

function contentSessionToken(
  cookieHeader: string | undefined,
): Redacted.Redacted | null {
  if (cookieHeader === undefined) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== contentSessionCookieName) continue;
    const parsed = contentSessionTokenSchema.safeParse(
      pair.slice(separator + 1).trim(),
    );
    return parsed.success
      ? Redacted.make(parsed.data, {label: "content-session-token"})
      : null;
  }
  return null;
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

function buildVersionFileUrl(
  requestUrl: URL,
  contentDomain: string,
  contentToken: string,
  manifestPath: string,
): string {
  const versionUrl = new URL(
    buildVersionUrl(requestUrl, contentDomain, contentToken),
  );
  versionUrl.pathname = `/${manifestPath.split("/").map(encodeURIComponent).join("/")}`;
  return versionUrl.toString();
}

function buildContentBootstrapUrl(
  requestUrl: URL,
  contentDomain: string,
  contentToken: string,
  bootstrapToken: string,
): string {
  const bootstrapUrl = new URL(requestUrl);
  bootstrapUrl.hostname = `${contentToken}.${contentDomain}`;
  bootstrapUrl.pathname = "/";
  bootstrapUrl.search = new URLSearchParams({
    [contentBootstrapQueryParameter]: bootstrapToken,
  }).toString();
  bootstrapUrl.hash = "";
  return bootstrapUrl.toString();
}

function isContentBootstrapRequest(requestUrl: URL): boolean {
  return requestUrl.pathname === "/" &&
    requestUrl.searchParams.has(contentBootstrapQueryParameter);
}

function casesHandled(value: never): never {
  throw new Error(`Unhandled Artifact Server failure: ${String(value)}`);
}
