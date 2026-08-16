import { z } from "zod";

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const membershipRoleSchema = z.enum(["administrator", "member"]);
const principalKindSchema = z.enum(["human", "service"]);
const capabilitySchema = z.enum([
  "artifact:create",
  "content-session:issue",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "project:manage",
]);

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  id: z.string(),
  installationId: z.string(),
  kind: principalKindSchema,
  membershipRole: membershipRoleSchema,
});

const sessionSchema = z.object({
  authenticationMethod: z.enum(["bearer", "session"]),
  principal: principalSchema,
});

const projectSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});

const artifactSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
});

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const versionSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: z.enum(["static", "spa"]),
});

const manifestSchema = z.object({
  digest: z.string(),
  entries: z.array(manifestEntrySchema),
  entryPath: z.string(),
  routingMode: z.enum(["static", "spa"]),
});

const artifactVersionSchema = z.object({
  links: z.object({ version: z.url() }),
  manifest: manifestSchema,
  version: versionSchema,
});

const artifactStateSchema = z.object({
  artifact: artifactSchema,
  links: z.object({ artifact: z.url(), version: z.url() }),
  replayed: z.boolean(),
  version: versionSchema,
});

const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const noContentStatuses = new Set([204, 205]);

export type AccessSetting = z.infer<typeof accessSettingSchema>;
export type PrincipalCapability = z.infer<typeof capabilitySchema>;
export type Principal = z.infer<typeof principalSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Version = z.infer<typeof versionSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export interface ArtifactPage {
  readonly artifacts: readonly {
    readonly artifact: Artifact;
    readonly links: {
      readonly artifact: string;
      readonly management: string;
    };
  }[];
  readonly nextCursor: string | null;
}

export interface ArtifactDetails {
  readonly artifact: Artifact;
  readonly current: ArtifactVersion;
  readonly links: {
    readonly artifact: string;
    readonly management: string;
  };
}

export interface ArtifactAction {
  readonly action: "change_access" | "change_tags" | "delete" | "publish" | "restore";
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

export interface ArtifactComparison {
  readonly added: readonly ManifestEntry[];
  readonly artifact: Artifact;
  readonly changed: readonly ComparedFile[];
  readonly from: Version;
  readonly links: { readonly from: string; readonly to: string };
  readonly removed: readonly ManifestEntry[];
  readonly renamed: readonly {
    readonly from: ManifestEntry;
    readonly to: ManifestEntry;
  }[];
  readonly to: Version;
  readonly unchangedCount: number;
}

export interface ComparedFile {
  readonly after: ManifestEntry;
  readonly before: ManifestEntry;
  readonly detail:
    | {
      readonly afterLineCount: number;
      readonly beforeLineCount: number;
      readonly change: {
        readonly after: readonly string[];
        readonly afterStartLine: number;
        readonly before: readonly string[];
        readonly beforeStartLine: number;
      } | null;
      readonly kind: "text";
    }
    | {
      readonly kind: "binary";
      readonly reason: "binary_or_invalid_utf8" | "text_limit_exceeded";
    };
  readonly links: { readonly after: string; readonly before: string };
}

const artifactPageSchema: z.ZodType<ArtifactPage> = z.object({
  artifacts: z.array(z.object({
    artifact: artifactSchema,
    links: z.object({ artifact: z.url(), management: z.url() }),
  })),
  nextCursor: z.string().nullable(),
});

const artifactDetailsSchema: z.ZodType<ArtifactDetails> = z.object({
  artifact: artifactSchema,
  current: artifactVersionSchema,
  links: z.object({ artifact: z.url(), management: z.url() }),
});

const actionSchema: z.ZodType<ArtifactAction> = z.object({
  action: z.enum(["change_access", "change_tags", "delete", "publish", "restore"]),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});

const comparedFileSchema: z.ZodType<ComparedFile> = z.object({
  after: manifestEntrySchema,
  before: manifestEntrySchema,
  detail: z.discriminatedUnion("kind", [
    z.object({
      afterLineCount: z.number(),
      beforeLineCount: z.number(),
      change: z.object({
        after: z.array(z.string()),
        afterStartLine: z.number(),
        before: z.array(z.string()),
        beforeStartLine: z.number(),
      }).nullable(),
      kind: z.literal("text"),
    }),
    z.object({
      kind: z.literal("binary"),
      reason: z.enum(["binary_or_invalid_utf8", "text_limit_exceeded"]),
    }),
  ]),
  links: z.object({ after: z.url(), before: z.url() }),
});

const comparisonSchema: z.ZodType<ArtifactComparison> = z.object({
  added: z.array(manifestEntrySchema),
  artifact: artifactSchema,
  changed: z.array(comparedFileSchema),
  from: versionSchema,
  links: z.object({ from: z.url(), to: z.url() }),
  removed: z.array(manifestEntrySchema),
  renamed: z.array(z.object({
    from: manifestEntrySchema,
    to: manifestEntrySchema,
  })),
  to: versionSchema,
  unchangedCount: z.number(),
});

const memberSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: z.enum(["active", "inactive"]),
  updatedAt: z.string(),
});

const apiKeySchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilities: z.array(capabilitySchema),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
});

export type InstallationMember = z.infer<typeof memberSchema>;
export type ManagedApiKey = z.infer<typeof apiKeySchema>;

const issuedKeySchema = z.object({
  apiKey: apiKeySchema,
  token: z.string(),
});

export type IssuedApiKey = z.infer<typeof issuedKeySchema>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function readCsrfToken(): string {
  for (const candidate of document.cookie.split(";")) {
    const [rawName, ...rawValue] = candidate.trim().split("=");
    if (
      rawName === "artifact_csrf"
      || rawName === "__Host-artifact_csrf"
    ) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  throw new ApiError(
    "CSRF_TOKEN_MISSING",
    "Your browser session cannot authorize changes. Sign in again.",
    403,
  );
}

async function parseFailure(response: Response): Promise<ApiError> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await response.json());
    if (parsed.success) {
      return new ApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
      );
    }
  } catch {
    return new ApiError(
      "INVALID_ERROR_RESPONSE",
      "Artifact Server returned an unreadable error response.",
      response.status,
    );
  }
  return new ApiError(
    "UNEXPECTED_ERROR_RESPONSE",
    "Artifact Server could not complete the request.",
    response.status,
  );
}

function mutationHeaders(idempotencyKey?: string): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-CSRF-Token": readCsrfToken(),
  });
  if (idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  return headers;
}

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  if (!response.ok) throw await parseFailure(response);
  if (noContentStatuses.has(response.status)) {
    throw new ApiError(
      "EMPTY_RESPONSE",
      "Artifact Server returned no response data.",
      response.status,
    );
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      "INVALID_SUCCESS_RESPONSE",
      "Artifact Server returned data that does not match the expected contract.",
      response.status,
    );
  }
  return parsed.data;
}

async function requestNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  if (!response.ok) throw await parseFailure(response);
  if (!noContentStatuses.has(response.status)) {
    throw new ApiError(
      "UNEXPECTED_RESPONSE",
      "Artifact Server returned unexpected response data.",
      response.status,
    );
  }
}

function projectQuery(projectId: string): string {
  return `projectId=${encodeURIComponent(projectId)}`;
}

export const api = {
  session: () => request(sessionSchema, "/api/v1/session"),
  logout: () => requestNoContent("/api/v1/session/logout", {
    headers: mutationHeaders(),
    method: "POST",
  }),
  projects: () => request(
    z.object({ projects: z.array(projectSchema) }),
    "/api/v1/projects",
  ).then(({ projects }) => projects),
  createProject: (name: string) => request(
    z.object({ project: projectSchema }),
    "/api/v1/projects",
    {
      body: JSON.stringify({ name }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ).then(({ project }) => project),
  renameProject: (projectId: string, name: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}`,
    {
      body: JSON.stringify({ name }),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ project }) => project),
  archiveProject: (projectId: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}/archive`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ project }) => project),
  unarchiveProject: (projectId: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}/unarchive`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ project }) => project),
  artifacts: (projectId: string, cursor: string | null, tag: string) => {
    const query = new URLSearchParams({ limit: "25", projectId });
    if (cursor !== null) query.set("cursor", cursor);
    if (tag.trim() !== "") query.set("tag", tag.trim());
    return request(artifactPageSchema, `/api/v1/artifacts?${query}`);
  },
  artifact: (projectId: string, artifactId: string) => request(
    artifactDetailsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${projectQuery(projectId)}`,
  ),
  versions: (projectId: string, artifactId: string) => request(
    z.object({
      artifactId: z.string(),
      versions: z.array(z.object({
        links: z.object({ version: z.url() }),
        version: versionSchema,
      })),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions?${projectQuery(projectId)}`,
  ).then(({ versions }) => versions),
  version: (projectId: string, artifactId: string, versionId: string) => request(
    artifactVersionSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}?${projectQuery(projectId)}`,
  ),
  actions: (projectId: string, artifactId: string, cursor: string | null) => {
    const query = new URLSearchParams({ limit: "50", projectId });
    if (cursor !== null) query.set("cursor", cursor);
    return request(
      z.object({
        actions: z.array(actionSchema),
        nextCursor: z.string().nullable(),
      }),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/actions?${query}`,
    );
  },
  comparison: (
    projectId: string,
    artifactId: string,
    fromVersionId: string,
    toVersionId: string,
  ) => request(
    comparisonSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comparisons?${new URLSearchParams({
      fromVersionId,
      projectId,
      toVersionId,
    })}`,
  ),
  restore: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    versionId: string,
    idempotencyKey: string,
  ) => request(
    artifactStateSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/restore?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId, versionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  changeAccess: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    accessSetting: AccessSetting,
    idempotencyKey: string,
  ) => request(
    artifactStateSchema.extend({ warning: z.string().nullable() }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/access?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ accessSetting, expectedCurrentVersionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "PATCH",
    },
  ),
  changeTags: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    tags: readonly string[],
    idempotencyKey: string,
  ) => request(
    artifactStateSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/tags?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId, tags }),
      headers: mutationHeaders(idempotencyKey),
      method: "PATCH",
    },
  ),
  deleteArtifact: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ) => request(
    z.object({
      artifact: artifactSchema.extend({ deletedAt: z.string() }),
      replayed: z.boolean(),
      retainedVersionCount: z.number(),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "DELETE",
    },
  ),
  contentSession: (projectId: string, artifactId: string, versionId?: string) => {
    const versionPath = versionId === undefined
      ? ""
      : `/versions/${encodeURIComponent(versionId)}`;
    return request(
      z.object({
        bootstrapUrl: z.url(),
        expiresAt: z.string(),
        versionId: z.string(),
      }),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}${versionPath}/content-sessions?${projectQuery(projectId)}`,
      { headers: mutationHeaders(), method: "POST" },
    );
  },
  members: () => request(
    z.object({ members: z.array(memberSchema) }),
    "/api/v1/members",
  ).then(({ members }) => members),
  admitMember: (
    displayName: string,
    email: string,
    role: "administrator" | "member",
  ) => request(
    z.object({ member: memberSchema }),
    "/api/v1/members",
    {
      body: JSON.stringify({ displayName, email, role }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ).then(({ member }) => member),
  deactivateMember: (memberId: string) => request(
    z.object({ member: memberSchema }),
    `/api/v1/members/${encodeURIComponent(memberId)}/deactivate`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ member }) => member),
  apiKeys: () => request(
    z.object({ apiKeys: z.array(apiKeySchema) }),
    "/api/v1/api-keys",
  ).then(({ apiKeys }) => apiKeys),
  issueApiKey: (
    name: string,
    expiresAt: string,
    capabilities: readonly PrincipalCapability[],
    memberId?: string,
  ) => request(
    issuedKeySchema,
    "/api/v1/api-keys",
    {
      body: JSON.stringify(
        memberId === undefined
          ? { capabilities, expiresAt, name }
          : { capabilities, expiresAt, memberId, name },
      ),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
  rotateApiKey: (keyId: string) => request(
    issuedKeySchema,
    `/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
    { headers: mutationHeaders(), method: "POST" },
  ),
  revokeApiKey: (keyId: string) => request(
    z.object({ apiKey: apiKeySchema }),
    `/api/v1/api-keys/${encodeURIComponent(keyId)}/revoke`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ apiKey }) => apiKey),
};
