import { z } from "zod";

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const membershipRoleSchema = z.enum(["administrator", "member"]);
const principalKindSchema = z.enum(["human", "service"]);
const capabilitySchema = z.enum([
  "agent:connect",
  "artifact:create",
  "comment:write",
  "content-session:issue",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:purge",
  "artifact:read",
  "project:manage",
]);

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  displayName: z.string().optional(),
  id: z.string(),
  installationId: z.string(),
  kind: principalKindSchema,
  membershipRole: membershipRoleSchema,
});

const disabledGitHistoryCapability = {
  limits: {
    fileCopyBytes: 10 * 1024 * 1024,
    logicalCopiedBytes: 0,
    logicalReservedBytes: 0,
    storageBudgetBytes: null,
    versionCopyBytes: 50 * 1024 * 1024,
  },
  provider: null,
  providerState: "disabled" as const,
};
const gitHistoryCapabilitySchema = z.object({
  limits: z.object({
    fileCopyBytes: z.number().int().nonnegative(),
    logicalCopiedBytes: z.number().int().nonnegative(),
    logicalReservedBytes: z.number().int().nonnegative(),
    storageBudgetBytes: z.number().int().nonnegative().nullable(),
    versionCopyBytes: z.number().int().nonnegative(),
  }),
  provider: z.literal("cloudflare-artifacts").nullable(),
  providerState: z.enum([
    "disabled",
    "checking",
    "available",
    "degraded",
    "misconfigured",
    "migration-required",
  ]),
});

/**
 * What this deployment offers beyond the shared surface. A deployment that
 * never learned the field is a deployment without the capability, so the
 * default keeps every gated affordance hidden rather than guessed at.
 */
const deploymentCapabilitiesSchema = z.object({
  gitHistory: gitHistoryCapabilitySchema.default(disabledGitHistoryCapability),
  linkedArtifacts: z.boolean(),
  linkedFolders: z.boolean().default(false),
  folders: z.boolean().default(false),
  crossProjectMove: z.boolean().default(false),
  trash: z.boolean().default(false),
  fileOverview: z.boolean().default(false),
  batch: z.boolean().default(false),
}).default({
  gitHistory: disabledGitHistoryCapability,
  linkedArtifacts: false,
  linkedFolders: false,
  folders: false,
  crossProjectMove: false,
  trash: false,
  fileOverview: false,
  batch: false,
});

const sessionSchema = z.object({
  authenticationMethod: z.enum(["bearer", "session"]),
  capabilities: deploymentCapabilitiesSchema,
  principal: principalSchema,
});

const accessContextSchema = z.discriminatedUnion("accessMode", [
  z.object({
    accessMode: z.literal("local_owner"),
    login: z.object({kind: z.literal("local_owner")}),
  }),
  z.object({
    accessMode: z.literal("private_team"),
    login: z.object({kind: z.enum(["oidc", "workos"])}),
  }),
]);

const sourceFreshnessSchema = z.enum([
  "in-sync",
  "missing",
  "modified",
  "unreadable",
]);

/** The linked file behind an artifact, as the local deployment reports it. */
const sourceBindingSchema = z.object({
  lastVerifiedAt: z.string(),
  path: z.string(),
  status: sourceFreshnessSchema,
});

const projectSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
const projectGitHistorySettingSchema = z.object({
  enabled: z.boolean(),
  projectId: z.string(),
  state: z.enum([
    "backfilling",
    "budget-limited",
    "degraded",
    "disabled",
    "ready",
    "waiting",
  ]),
});
const projectGitHistoryEstimateSchema = z.object({
  estimatedCopiedBytes: z.number().int().nonnegative(),
  estimatedPointerBytes: z.number().int().nonnegative(),
  notice: z.string(),
  operations: z.number().int().nonnegative(),
  projectId: z.string(),
  repositories: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
});

const artifactSchema = z.object({
  folderId: z.string().nullable().optional(),
  fileKind: z.enum([
    "site", "html", "markdown", "pdf", "image", "video", "audio", "code", "text", "data", "archive", "other",
  ]).catch("other").optional(),
  currentVersionCreatedAt: z.string().optional(),
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
  links: z.object({ review: z.url(), version: z.url() }),
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
export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>;
export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type PrincipalCapability = z.infer<typeof capabilitySchema>;
export type Principal = z.infer<typeof principalSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type AccessContext = z.infer<typeof accessContextSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectGitHistorySetting = z.infer<typeof projectGitHistorySettingSchema>;
export type ProjectGitHistoryEstimate = z.infer<typeof projectGitHistoryEstimateSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Version = z.infer<typeof versionSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type ArtifactState = z.infer<typeof artifactStateSchema>;

const insightWindowSchema = z.enum(["7d", "30d", "90d", "all"]);
const insightDispatchStateSchema = z.enum([
  "queued",
  "claimed",
  "delivered",
  "addressed",
  "failed",
  "canceled",
]);
const insightCountSchema = z.number().int().nonnegative();
const insightArtifactRefSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  projectId: z.string(),
});
const insightsSchema = z.object({
  generatedAt: z.string(),
  overview: z.object({
    artifactCount: insightCountSchema,
    projects: z.array(z.object({
      archived: z.boolean(),
      artifactCount: insightCountSchema,
      latestVersionAt: z.string().nullable(),
      name: z.string(),
      projectId: z.string(),
      versionCount: insightCountSchema,
    })),
    publicLinkCount: insightCountSchema,
    recentArtifacts: z.array(insightArtifactRefSchema.extend({
      latestVersionAt: z.string(),
      latestVersionNumber: z.number().int().positive(),
    })),
    tags: z.array(z.object({artifactCount: insightCountSchema, tag: z.string()})),
    untaggedArtifactCount: insightCountSchema,
    versionCount: insightCountSchema,
    versionsInWindow: insightCountSchema,
  }),
  projectId: z.string().nullable(),
  review: z.object({
    dispatches: z.record(insightDispatchStateSchema, insightCountSchema),
    dispatchesInWindow: insightCountSchema,
    oldestOpenThreadAt: z.string().nullable(),
    openDispatchedThreads: insightCountSchema,
    openThreads: insightCountSchema,
    openThreadsByArtifact: z.array(insightArtifactRefSchema.extend({
      openThreads: insightCountSchema,
    })),
    repliesInWindow: insightCountSchema,
    resolvedThreads: insightCountSchema,
    threadsOpenedInWindow: insightCountSchema,
    threadsResolvedInWindow: insightCountSchema,
  }),
  since: z.string().nullable(),
  storage: z.object({
    distinctBlobCount: insightCountSchema,
    fileCount: insightCountSchema,
    gitHistory: z.object({
      committedBytes: insightCountSchema,
      failingJobs: insightCountSchema,
      pendingJobs: insightCountSchema,
      projects: z.array(z.object({
        budgetBytes: insightCountSchema.nullable(),
        committedBytes: insightCountSchema,
        enabled: z.boolean(),
        projectId: z.string(),
        reservedBytes: insightCountSchema,
      })),
      reservedBytes: insightCountSchema,
    }),
    growth: z.array(z.object({
      addedBytes: insightCountSchema,
      cumulativeBytes: insightCountSchema,
      day: z.string(),
      versions: insightCountSchema,
    })),
    growthBucket: z.enum(["day", "week"]),
    largestArtifacts: z.array(insightArtifactRefSchema.extend({
      logicalBytes: insightCountSchema,
    })),
    logicalBytes: insightCountSchema,
    storedBytes: insightCountSchema,
  }),
  window: insightWindowSchema,
});
const insightsResponseSchema = z.object({insights: insightsSchema});
const insightActivityKindSchema = z.enum([
  "artifact.published",
  "artifact.restored",
  "artifact.deleted",
  "artifact.captured",
  "artifact.linked",
  "artifact.relinked",
  "artifact.access_changed",
  "artifact.tags_changed",
  "comment.opened",
  "comment.replied",
  "comment.resolved",
  "comment.reopened",
  "comment.edited",
  "comment.deleted",
  "dispatch.sent",
  "dispatch.delivered",
  "dispatch.addressed",
  "dispatch.failed",
  "dispatch.canceled",
]);
const insightActivityPageSchema = z.object({
  items: z.array(z.object({
    actor: z.object({
      displayName: z.string().nullable(),
      kind: principalKindSchema.nullable(),
      principalId: z.string(),
    }).nullable(),
    artifactId: z.string().nullable(),
    artifactName: z.string().nullable(),
    id: z.string(),
    kind: insightActivityKindSchema,
    occurredAt: z.string(),
    projectId: z.string(),
    versionNumber: z.number().int().positive().nullable(),
  })),
  nextCursor: z.string().nullable(),
});

export type InsightWindow = z.infer<typeof insightWindowSchema>;
export type InsightDispatchState = z.infer<typeof insightDispatchStateSchema>;
export type Insights = z.infer<typeof insightsSchema>;
export type InsightActivityKind = z.infer<typeof insightActivityKindSchema>;
export type InsightActivityPage = z.infer<typeof insightActivityPageSchema>;
export type InsightActivityEvent = InsightActivityPage["items"][number];

const publicLinkItemSchema = z.object({
  artifact: artifactSchema,
  currentVersion: versionSchema,
  links: z.object({ public: z.url() }),
  project: projectSchema,
});

const publicLinkPageSchema = z.object({
  nextCursor: z.string().nullable(),
  publicLinks: z.array(publicLinkItemSchema),
});

const makePublicLinkPrivateItemSchema = z.object({
  artifactId: z.string(),
  expectedCurrentVersionId: z.string(),
  idempotencyKey: z.string(),
  projectId: z.string(),
});

const publicLinkMutationResultSchema = z.discriminatedUnion("status", [
  z.object({
    artifactId: z.string(),
    currentVersionId: z.string(),
    projectId: z.string(),
    replayed: z.boolean(),
    status: z.literal("made_private"),
  }),
  z.object({
    artifactId: z.string(),
    error: z.object({code: z.string(), message: z.string()}),
    expectedCurrentVersionId: z.string(),
    projectId: z.string(),
    retry: z.enum(["not_retryable", "refresh_current_version", "same_command"]),
    status: z.literal("failed"),
  }),
]);

const publicLinkMutationResponseSchema = z.object({
  results: z.array(publicLinkMutationResultSchema),
  summary: z.object({
    failed: z.number().int().nonnegative(),
    requested: z.number().int().positive(),
    succeeded: z.number().int().nonnegative(),
  }),
  warning: z.string(),
});

export type PublicLinkItem = z.infer<typeof publicLinkItemSchema>;
export type PublicLinkPage = z.infer<typeof publicLinkPageSchema>;
export type MakePublicLinkPrivateItem = z.infer<
  typeof makePublicLinkPrivateItemSchema
>;
export type PublicLinkMutationResult = z.infer<
  typeof publicLinkMutationResultSchema
>;
export type PublicLinkMutationResponse = z.infer<
  typeof publicLinkMutationResponseSchema
>;

export interface ArtifactPage {
  readonly artifacts: readonly {
    readonly artifact: Artifact;
    readonly commentCount: number;
    readonly links: {
      readonly artifact: string;
      readonly management: string;
    };
    readonly versionCount: number;
  }[];
  readonly nextCursor: string | null;
}

export interface ArtifactDetails {
  readonly artifact: Artifact;
  readonly current: ArtifactVersion;
  readonly links: {
    readonly artifact: string;
    /** The artifact's own live origin; present only for a linked artifact. */
    readonly live?: string | undefined;
    readonly management: string;
  };
  /** Present only on a local deployment that linked this artifact to a file. */
  readonly sourceBinding?: SourceBinding | undefined;
}

export interface ArtifactAction {
  readonly action:
    | "capture"
    | "change_access"
    | "change_tags"
    | "comment_create"
    | "comment_delete"
    | "comment_reopen"
    | "comment_reply"
    | "comment_resolve"
    | "comment_update"
    | "delete"
    | "link"
    | "move"
    | "purge"
    | "recover"
    | "rename"
    | "publish"
    | "relink"
    | "restore";
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
    commentCount: z.number().int().nonnegative(),
    links: z.object({ artifact: z.url(), management: z.url() }),
    versionCount: z.number().int().positive(),
  })),
  nextCursor: z.string().nullable(),
});

const folderSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentFolderId: z.string().nullable(),
  name: z.string(),
  revision: z.number().int().positive(),
});
export type Folder = z.infer<typeof folderSchema>;

const trashLocationSchema = z.object({
  projectId: z.string(),
  folderId: z.string().nullable(),
  path: z.array(z.object({id: z.string(), name: z.string()})),
});
const trashedItemFields = {
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  location: trashLocationSchema,
  trashedAt: z.string(),
  trashedBy: z.string().nullable(),
  trashGroupId: z.string().nullable(),
};
const trashedItemSchema = z.discriminatedUnion("kind", [
  z.object({...trashedItemFields, kind: z.literal("artifact"), fileKind: z.string().nullable()}),
  z.object({...trashedItemFields, kind: z.literal("folder"), artifactCount: z.number().int().nonnegative()}),
]);
export type TrashedItem = z.infer<typeof trashedItemSchema>;
export const fileKinds = [
  "site", "html", "markdown", "pdf", "image", "video", "audio", "data", "code", "archive", "text", "other",
] as const;
export type FileKind = (typeof fileKinds)[number];
const fileItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  folderId: z.string().nullable(),
  folderPath: z.array(z.object({id: z.string(), name: z.string()})),
  fileKind: z.enum(fileKinds).catch("other"),
  currentVersionId: z.string(),
  currentVersionNumber: z.number().int(),
  size: z.number().int().nonnegative(),
  entryMediaType: z.string(),
  tags: z.array(z.string()),
  commentCount: z.number().int().nonnegative(),
  versionCount: z.number().int().nonnegative(),
  accessSetting: accessSettingSchema,
  linked: sourceFreshnessSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FileItem = z.infer<typeof fileItemSchema>;
const filePageSchema = z.object({items: z.array(fileItemSchema), nextCursor: z.string().nullable()});
const countSchema = z.number().int().nonnegative();
const fileFacetsSchema = z.object({
  facets: z.object({
    total: countSchema,
    kinds: z.array(z.object({kind: z.enum(fileKinds).catch("other"), count: countSchema})),
    projects: z.array(z.object({projectId: z.string(), count: countSchema})),
    tags: z.array(z.object({tag: z.string(), count: countSchema})),
  }),
});
export type FileFacets = z.infer<typeof fileFacetsSchema>["facets"];

/** One batch item, guarded as if it were sent alone. */
export type BatchItem =
  | {readonly kind: "artifact"; readonly projectId: string; readonly artifactId: string; readonly expectedCurrentVersionId: string}
  | {readonly kind: "folder"; readonly projectId: string; readonly folderId: string; readonly expectedRevision: number};
export type BatchOperation = "move" | "trash" | "recover" | "purge" | "tag-add" | "tag-remove";
const batchResultSchema = z.object({
  operation: z.string(),
  results: z.array(z.object({
    index: z.number().int(),
    status: z.enum(["ok", "conflict", "not-found", "refused"]),
    error: z.object({code: z.string(), message: z.string(), currentVersionId: z.string().optional()}).loose().optional(),
  }).loose()),
});
export type BatchResult = z.infer<typeof batchResultSchema>;

const trashPageSchema = z.object({items: z.array(trashedItemSchema), nextCursor: z.string().nullable()});
const recoverySchema = z.object({
  placement: z.enum(["original", "root"]),
  previousAccessSetting: accessSettingSchema.optional(),
  previouslyPublicArtifactIds: z.array(z.string()).optional(),
});
export type Recovery = z.infer<typeof recoverySchema>;

const folderMutationSchema = z.object({folder: folderSchema});
const artifactLocationSchema = z.object({location: z.object({
  artifactId: z.string(),
  projectId: z.string(),
  folderId: z.string().nullable(),
})});
export type ArtifactLocation = z.infer<typeof artifactLocationSchema>["location"];
const placementMutationSchema = z.object({artifact: z.object({
  id: z.string(),
  projectId: z.string(),
  folderId: z.string().nullable(),
  name: z.string(),
  currentVersionId: z.string(),
})});
const folderPageSchema: z.ZodType<FolderPage> = z.intersection(artifactPageSchema, z.object({
  breadcrumbs: z.array(folderSchema),
  folders: z.array(folderSchema),
}));
export interface FolderPage extends ArtifactPage {
  readonly breadcrumbs: readonly Folder[];
  readonly folders: readonly Folder[];
}

const artifactDetailsSchema: z.ZodType<ArtifactDetails> = z.object({
  artifact: artifactSchema,
  current: artifactVersionSchema,
  links: z.object({
    artifact: z.url(),
    live: z.url().optional(),
    management: z.url(),
  }),
  sourceBinding: sourceBindingSchema.optional(),
});

/** The link and capture answer: a published version plus the binding it read. */
const linkedPublicationSchema = z.object({
  artifact: artifactSchema,
  links: z.object({
    artifact: z.url(),
    live: z.url().optional(),
    version: z.url(),
  }),
  replayed: z.boolean(),
  sourceBinding: sourceBindingSchema,
  version: versionSchema,
});

export type LinkedPublication = z.infer<typeof linkedPublicationSchema>;

const folderLinkSchema = z.object({
  createdAt: z.string(),
  entryCount: z.number().int(),
  folderId: z.string(),
  id: z.string(),
  ignore: z.array(z.string()),
  ignoredCount: z.number().int(),
  inTrash: z.boolean(),
  lastScanCompletedAt: z.string().nullable(),
  lastScanStartedAt: z.string().nullable(),
  overLimitReason: z.enum(["entries", "ignore-file"]).nullable(),
  path: z.string(),
  paused: z.boolean(),
  pendingCount: z.number().int(),
  projectId: z.string(),
  revision: z.number().int(),
  scanActivity: z.enum(["idle", "queued", "scanning"]),
  skippedCount: z.number().int(),
  state: z.enum(["active", "paused", "unavailable", "over-limit"]),
});
const folderLinkResultSchema = z.object({folderLink: folderLinkSchema});
const inventoryEntrySchema = z.object({
  artifactId: z.string().nullable(),
  freshness: sourceFreshnessSchema.nullable(),
  id: z.string(),
  observedAt: z.string(),
  pending: z.boolean(),
  relativePath: z.string(),
  size: z.number().int().nullable(),
  skipReason: z.string().nullable(),
  state: z.enum(["untracked", "tracked", "skipped"]),
});
const inventoryPageSchema = z.object({entries: z.array(inventoryEntrySchema), nextCursor: z.string().nullable()});
const captureResultSchema = z.object({
  artifactId: z.string().nullable(),
  code: z.string().nullable(),
  entryId: z.string(),
  message: z.string().nullable(),
  relativePath: z.string().nullable(),
  status: z.enum(["captured", "unchanged", "refused"]),
  versionId: z.string().nullable(),
});
const relinkSuggestionSchema = z.object({
  artifactId: z.string(),
  artifactName: z.string(),
  expectedSha256: z.string(),
  fromRelativePath: z.string(),
  toEntryId: z.string(),
  toRelativePath: z.string(),
});
export type FolderLink = z.infer<typeof folderLinkSchema>;
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
export type CaptureResult = z.infer<typeof captureResultSchema>;
export type RelinkSuggestion = z.infer<typeof relinkSuggestionSchema>;

function folderLinkUrl(folderLinkId: string, suffix = ""): string {
  return `/api/v1/folder-links/${encodeURIComponent(folderLinkId)}${suffix}`;
}

const actionSchema: z.ZodType<ArtifactAction> = z.object({
  action: z.enum([
    "capture",
    "change_access",
    "change_tags",
    "comment_create",
    "comment_delete",
    "comment_reopen",
    "comment_reply",
    "comment_resolve",
    "comment_update",
    "delete",
    "link",
    "move",
    "purge",
    "recover",
    "rename",
    "publish",
    "relink",
    "restore",
  ]),
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

const commentAnchorSchema = z.json();
const commentThreadStateSchema = z.enum(["open", "resolved"]);

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
});

const commentThreadSchema = z.object({
  anchor: commentAnchorSchema,
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  links: z.object({ self: z.url(), version: z.url() }),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number(),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: commentThreadStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
});

const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
});

const commentThreadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
});

const commentThreadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
});

const createdCommentThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});

const createdCommentReplySchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
});

/** Client-owned anchor JSON; Artifact Server stores and returns it unread. */
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentThreadState = z.infer<typeof commentThreadStateSchema>;
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
export type CommentReply = z.infer<typeof commentReplySchema>;
export type CommentThreadPage = z.infer<typeof commentThreadPageSchema>;
export type CommentThreadDetails = z.infer<typeof commentThreadDetailsSchema>;
export type CreatedCommentThread = z.infer<typeof createdCommentThreadSchema>;
export type CreatedCommentReply = z.infer<typeof createdCommentReplySchema>;

/** Every filter the comment listing route accepts, with null meaning unset. */
export interface CommentThreadQuery {
  readonly cursor: string | null;
  /** Dispatched-thread visibility; unset leaves the server's own exclusion. */
  readonly dispatched: DispatchedThreadFilter | null;
  readonly limit: number | null;
  readonly since: string | null;
  readonly state: CommentThreadState | null;
  readonly versionId: string | null;
}

/** One composed thread, ready to be created on one exact saved version. */
export interface CommentDraft {
  readonly anchor: CommentAnchor;
  readonly body: string;
  /** One manifest entry path, or null to anchor the whole version. */
  readonly path: string | null;
}

/** One thread edit; omit a field to leave that part of the thread unchanged. */
export interface CommentThreadEdit {
  readonly anchor?: CommentAnchor;
  readonly body?: string;
  readonly state?: CommentThreadState;
}

const registeredAgentSchema = z.object({
  agentSessionId: z.string().nullable(),
  /** Derived from the agent's own claim polling; the poll is the heartbeat. */
  connected: z.boolean(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  /** Open slug, matching the server (`registeredAgentKindPattern`): nothing branches on it. */
  kind: z.string(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
});

const agentDispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

const agentDispatchSchema = z.object({
  addressedAt: z.string().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  leaseExpiresAt: z.string().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  sender: commentAuthorSchema,
  state: agentDispatchStateSchema,
  threadIds: z.array(z.string()),
  updatedAt: z.string(),
});

const agentDispatchPageSchema = z.object({
  items: z.array(agentDispatchSchema),
  nextCursor: z.string().nullable(),
});

const createdAgentDispatchSchema = z.object({
  dispatch: agentDispatchSchema,
  replayed: z.boolean(),
});

export type RegisteredAgent = z.infer<typeof registeredAgentSchema>;
export type AgentDispatchState = z.infer<typeof agentDispatchStateSchema>;
export type AgentDispatch = z.infer<typeof agentDispatchSchema>;
export type AgentDispatchPage = z.infer<typeof agentDispatchPageSchema>;
export type CreatedAgentDispatch = z.infer<typeof createdAgentDispatchSchema>;

/**
 * Whether a comment listing hides, includes, or shows only the threads an
 * active dispatch carries. Leaving it unset keeps the server default, which
 * hides them: that is what makes a send consumptive.
 */
export type DispatchedThreadFilter = "exclude" | "include" | "only";

/** One bundle of comment threads, sent to one agent as a single message. */
export interface AgentDispatchDraft {
  readonly agentId: string;
  readonly note: string | null;
  /** Ordered thread ids, all open and undispatched at send time. */
  readonly threadIds: readonly string[];
}

/** Every filter the dispatch listing route accepts, with null meaning unset. */
export interface AgentDispatchQuery {
  readonly agentId: string | null;
  readonly cursor: string | null;
  readonly limit: number | null;
  readonly state: AgentDispatchState | null;
}

const agentActivitySchema = z.enum(["disconnected", "idle", "working"]);
const agentBeaconSchema = z.enum(["thinking", "replying"]);

/**
 * One registered agent with its derived presence. The activity fields ship
 * with the presence-capable server; they stay optional so a panel pointed at
 * an older deployment still renders liveness from `connected` alone.
 */
const agentPresenceSchema = z.object({
  activeDispatchId: z.string().nullable().optional(),
  activity: agentActivitySchema.optional(),
  agentSessionId: z.string().nullable(),
  beacon: agentBeaconSchema.nullable().optional(),
  capabilities: z.object({
    beacon: z.boolean(),
    evidence: z.enum(["channel", "mailbox", "native"]),
  }).optional(),
  /** Derived from the agent's own claim polling; the poll is the heartbeat. */
  connected: z.boolean(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  /** A validated slug; display metadata only, nothing branches on it. */
  kind: z.string(),
  lastActivityAt: z.string().optional(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
});

export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type AgentBeacon = z.infer<typeof agentBeaconSchema>;
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

/** What one bulk clear removed, and what an active send kept out of reach. */
const commentClearResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  skippedDispatched: z.number().int().nonnegative(),
});

export type CommentClearResult = z.infer<typeof commentClearResultSchema>;

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
  notifySessionExpiry(response);
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

async function requestText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "same-origin" });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  return await response.text();
}

/**
 * Read at most `byteLimit` leading bytes of one download-route entry. The
 * download route answers `application/octet-stream`, so these bytes are only
 * ever data to the application; a server that ignores the range is still
 * clipped to the limit here.
 */
async function requestBytes(
  path: string,
  byteLimit: number | null,
): Promise<Uint8Array> {
  const headers = new Headers();
  if (byteLimit !== null) headers.set("Range", `bytes=0-${byteLimit - 1}`);
  const response = await fetch(path, {credentials: "same-origin", headers});
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return byteLimit === null ? bytes : bytes.subarray(0, byteLimit);
}

async function requestHead(path: string): Promise<void> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: "HEAD",
  });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
}

async function requestNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  if (!noContentStatuses.has(response.status)) {
    throw new ApiError(
      "UNEXPECTED_RESPONSE",
      "Artifact Server returned unexpected response data.",
      response.status,
    );
  }
}

function folderUrl(projectId: string, folderId: string | null): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId ?? "root")}`;
}

function projectQuery(projectId: string): string {
  return `projectId=${encodeURIComponent(projectId)}`;
}

function versionAssetUrl(
  route: "file" | "media",
  projectId: string,
  artifactId: string,
  versionId: string,
  path: string,
): string {
  return `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/${route}?${new URLSearchParams({
    path,
    projectId,
  })}`;
}

function notifySessionExpiry(response: Response): void {
  if (response.status === 401) {
    window.dispatchEvent(new Event("artifact-session-expired"));
  }
}

export const api = {
  accessContext: () => request(accessContextSchema, "/auth/context"),
  localOwnerSession: () => requestNoContent("/auth/local-owner", {
    method: "POST",
  }),
  session: () => request(sessionSchema, "/api/v1/session"),
  logout: async () => {
    await requestNoContent("/api/v1/session/logout", {
      headers: mutationHeaders(),
      method: "POST",
    });
    // Drafts and other departing-principal state listen for this.
    window.dispatchEvent(new Event("artifact-session-logout"));
  },
  insights: async (projectId: string | null, window: InsightWindow) => {
    const query = new URLSearchParams({window});
    if (projectId !== null) query.set("projectId", projectId);
    return (await request(insightsResponseSchema, `/api/v1/insights?${query}`))
      .insights;
  },
  insightActivity: (
    projectId: string | null,
    window: InsightWindow,
    cursor: string | null,
  ) => {
    const query = new URLSearchParams({limit: "25", window});
    if (projectId !== null) query.set("projectId", projectId);
    if (cursor !== null) query.set("cursor", cursor);
    return request(insightActivityPageSchema, `/api/v1/insights/activity?${query}`);
  },
  publicLinks: (cursor: string | null) => {
    const query = new URLSearchParams({ limit: "25" });
    if (cursor !== null) query.set("cursor", cursor);
    return request(
      publicLinkPageSchema,
      `/api/v1/administration/public-links?${query}`,
    );
  },
  makePublicLinksPrivate: (
    items: readonly MakePublicLinkPrivateItem[],
  ) => request(
    publicLinkMutationResponseSchema,
    "/api/v1/administration/public-links/make-private",
    {
      body: JSON.stringify({ items }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
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
  projectGitHistory: (projectId: string) => request(
    z.object({gitHistory: projectGitHistorySettingSchema}),
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
  ).then(({gitHistory}) => gitHistory),
  estimateProjectGitHistory: (projectId: string) => request(
    z.object({estimate: projectGitHistoryEstimateSchema}),
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history/estimate`,
    {headers: mutationHeaders(), method: "POST"},
  ).then(({estimate}) => estimate),
  setProjectGitHistory: (projectId: string, enabled: boolean) => request(
    z.object({gitHistory: projectGitHistorySettingSchema}),
    `/api/v1/projects/${encodeURIComponent(projectId)}/git-history`,
    {
      body: JSON.stringify(enabled
        ? {confirmEstimate: true, enabled: true}
        : {enabled: false}),
      headers: mutationHeaders(),
      method: "PUT",
    },
  ).then(({gitHistory}) => gitHistory),
  artifacts: (
    projectId: string,
    cursor: string | null,
    tags: readonly string[],
    search = "",
    options: {
      readonly comments?: "all" | "with" | "without";
      readonly folderId?: string | null | undefined;
      readonly sort?: "comments" | "newest";
    } = {},
  ): Promise<ArtifactPage | FolderPage> => {
    const query = new URLSearchParams({ limit: "25", projectId });
    query.set("comments", options.comments ?? "all");
    query.set("sort", options.sort ?? "newest");
    if (cursor !== null) query.set("cursor", cursor);
    for (const tag of tags) query.append("tag", tag);
    if (search.trim() !== "") query.set("search", search.trim());
    if (options.folderId !== undefined) {
      return request(folderPageSchema, `${folderUrl(projectId, options.folderId)}?${query}`);
    }
    return request(artifactPageSchema, `/api/v1/artifacts?${query}`);
  },
  folders: (projectId: string, folderId: string | null, search = "", cursor: string | null = null) => {
    const query = new URLSearchParams({foldersOnly: "true", search, limit: "50"});
    if (cursor !== null) query.set("cursor", cursor);
    return request(folderPageSchema, `${folderUrl(projectId, folderId)}?${query}`);
  },
  createFolder: (projectId: string, parentFolderId: string | null, name: string, key: string) => request(
    folderMutationSchema,
    `/api/v1/projects/${encodeURIComponent(projectId)}/folders`,
    {method: "POST", headers: mutationHeaders(key), body: JSON.stringify({name, parentFolderId})},
  ),
  updateFolder: (folder: Folder, change: {name: string} | {parentFolderId: string | null}, key: string) => request(
    folderMutationSchema,
    folderUrl(folder.projectId, folder.id),
    {method: "PATCH", headers: mutationHeaders(key), body: JSON.stringify({...change, expectedRevision: folder.revision})},
  ),
  files: (query: URLSearchParams) => request(filePageSchema, `/api/v1/files?${query}`),
  fileFacets: (query: URLSearchParams) =>
    request(fileFacetsSchema, `/api/v1/files/facets?${query}`).then(({facets}) => facets),
  batch: (body: {
    readonly operation: BatchOperation;
    readonly items: readonly BatchItem[];
    readonly params: {readonly toFolderId?: string | null; readonly toProjectId?: string; readonly tags?: readonly string[]};
    readonly idempotencyKey: string;
  }) => request(batchResultSchema, "/api/v1/batch", {
    method: "POST", headers: mutationHeaders(body.idempotencyKey), body: JSON.stringify(body),
  }),
  trash: (cursor: string | null) => {
    const query = new URLSearchParams({limit: "50"});
    if (cursor !== null) query.set("cursor", cursor);
    return request(trashPageSchema, `/api/v1/trash?${query}`);
  },
  recoverTrashed: (item: Pick<TrashedItem, "kind" | "id" | "projectId">, key: string, name?: string) => request(
    recoverySchema,
    item.kind === "artifact"
      ? `/api/v1/artifacts/${encodeURIComponent(item.id)}/recover?${projectQuery(item.projectId)}`
      : `${folderUrl(item.projectId, item.id)}/recover`,
    item.kind === "artifact"
      ? {method: "POST", headers: mutationHeaders(key)}
      : {method: "POST", headers: mutationHeaders(key), body: JSON.stringify(name === undefined ? {} : {name})},
  ),
  purgeTrashed: (item: Pick<TrashedItem, "kind" | "id" | "projectId">, confirm: string, key: string) => request(
    z.object({}).loose(),
    item.kind === "artifact"
      ? `/api/v1/artifacts/${encodeURIComponent(item.id)}/purge?${projectQuery(item.projectId)}`
      : `${folderUrl(item.projectId, item.id)}/purge`,
    {method: "POST", headers: mutationHeaders(key), body: JSON.stringify({confirm})},
  ),
  deleteFolder: (folder: Folder, key: string) => request(
    folderMutationSchema,
    `${folderUrl(folder.projectId, folder.id)}?expectedRevision=${folder.revision}`,
    {method: "DELETE", headers: mutationHeaders(key)},
  ),
  renameArtifact: (artifact: Artifact, name: string, key: string) => request(
    placementMutationSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/name?${projectQuery(artifact.projectId)}`,
    {method: "PATCH", headers: mutationHeaders(key), body: JSON.stringify({name, expectedCurrentVersionId: artifact.currentVersionId})},
  ),
  moveArtifact: (artifact: Artifact, toFolderId: string | null, key: string, toProjectId = artifact.projectId) => request(
    placementMutationSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/move?${projectQuery(artifact.projectId)}`,
    {method: "POST", headers: mutationHeaders(key), body: JSON.stringify(
      {toFolderId, expectedCurrentVersionId: artifact.currentVersionId, toProjectId},
    )},
  ),
  moveFolderToProject: (folder: Folder, toProjectId: string, toParentFolderId: string | null, key: string) => request(
    folderMutationSchema,
    `${folderUrl(folder.projectId, folder.id)}/move-to-project`,
    {method: "POST", headers: mutationHeaders(key), body: JSON.stringify({toProjectId, toParentFolderId, expectedRevision: folder.revision})},
  ),
  locateArtifact: (artifactId: string) => request(
    artifactLocationSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/location`,
  ),
  artifact: (projectId: string, artifactId: string) => request(
    artifactDetailsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${projectQuery(projectId)}`,
  ),
  versions: (projectId: string, artifactId: string) => request(
    z.object({
      artifactId: z.string(),
      versions: z.array(z.object({
        links: z.object({ review: z.url(), version: z.url() }),
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
      recoverable: z.boolean().default(false),
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
  /**
   * Save the linked file's current bytes as a new immutable version. Capturing
   * a binding that is already in sync replays the current version instead of
   * committing a second identical one.
   */
  captureArtifact: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ) => request(
    linkedPublicationSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/capture?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  folderLinks: async (projectId: string) => (await request(
    z.object({folderLinks: z.array(folderLinkSchema)}),
    `/api/v1/projects/${encodeURIComponent(projectId)}/folder-links`,
  )).folderLinks,
  linkFolder: async (projectId: string, path: string, newFolderName: string | null, key: string) => (await request(
    folderLinkResultSchema,
    `/api/v1/projects/${encodeURIComponent(projectId)}/folder-links`,
    {body: JSON.stringify({folderId: null, ignore: [], newFolderName, path}), headers: mutationHeaders(key), method: "POST"},
  )).folderLink,
  updateFolderLink: async (link: FolderLink, change: {readonly paused: boolean} | {readonly ignore: readonly string[]}) => (await request(
    folderLinkResultSchema,
    folderLinkUrl(link.id),
    {body: JSON.stringify({...change, expectedRevision: link.revision}), headers: mutationHeaders(), method: "PATCH"},
  )).folderLink,
  unlinkFolder: async (link: FolderLink) => (await request(
    folderLinkResultSchema,
    folderLinkUrl(link.id, `?expectedRevision=${link.revision}`),
    {headers: mutationHeaders(), method: "DELETE"},
  )).folderLink,
  scanFolderLink: async (folderLinkId: string) => (await request(
    folderLinkResultSchema,
    folderLinkUrl(folderLinkId, "/scan"),
    {headers: mutationHeaders(), method: "POST"},
  )).folderLink,
  folderLinkInventory: (folderLinkId: string, filter: "pending" | "all" | "skipped", cursor: string | null) => {
    const query = new URLSearchParams({limit: "200"});
    if (filter === "pending") query.set("pending", "true");
    if (filter === "skipped") query.set("state", "skipped");
    if (cursor !== null) query.set("cursor", cursor);
    return request(inventoryPageSchema, folderLinkUrl(folderLinkId, `/inventory?${query}`));
  },
  captureFolderLink: async (folderLinkId: string, entries: readonly string[] | "all", key: string) => (await request(
    z.object({results: z.array(captureResultSchema)}),
    folderLinkUrl(folderLinkId, "/capture"),
    {
      body: JSON.stringify(entries === "all" ? {all: true} : {entryIds: entries}),
      headers: mutationHeaders(key),
      method: "POST",
    },
  )).results,
  relinkSuggestions: async (folderLinkId: string) => (await request(
    z.object({suggestions: z.array(relinkSuggestionSchema)}),
    folderLinkUrl(folderLinkId, "/relink-suggestions"),
  )).suggestions,
  acceptRelink: (folderLinkId: string, suggestion: RelinkSuggestion, key: string) => request(
    z.object({sourceBinding: sourceBindingSchema}),
    folderLinkUrl(folderLinkId, "/relink"),
    {
      body: JSON.stringify({
        artifactId: suggestion.artifactId,
        entryId: suggestion.toEntryId,
        expectedSha256: suggestion.expectedSha256,
      }),
      headers: mutationHeaders(key),
      method: "POST",
    },
  ),
  entryLiveSession: (folderLinkId: string, entryId: string) => request(
    z.object({bootstrapUrl: z.url(), expiresAt: z.string()}),
    folderLinkUrl(folderLinkId, `/entries/${encodeURIComponent(entryId)}/live-sessions`),
    {headers: mutationHeaders(), method: "POST"},
  ),
  /**
   * Enter the artifact's live origin: the answer is a one-use bootstrap URL
   * that exchanges itself for the content cookie, exactly like a version's
   * content session, and then streams the file's current bytes.
   */
  liveSession: (projectId: string, artifactId: string) => request(
    z.object({ bootstrapUrl: z.url(), expiresAt: z.string() }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/live-sessions?${projectQuery(projectId)}`,
    { headers: mutationHeaders(), method: "POST" },
  ),
  contentSession: (
    projectId: string,
    artifactId: string,
    versionId?: string,
    path?: string,
  ) => {
    const versionPath = versionId === undefined
      ? ""
      : `/versions/${encodeURIComponent(versionId)}`;
    const query = new URLSearchParams({ projectId });
    if (path !== undefined) query.set("path", path);
    return request(
      z.object({
        bootstrapUrl: z.url(),
        expiresAt: z.string(),
        versionId: z.string(),
      }),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}${versionPath}/content-sessions?${query}`,
      { headers: mutationHeaders(), method: "POST" },
    );
  },
  previewLease: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => request(
    z.object({
      baseUrl: z.url(),
      expiresAt: z.string(),
      versionId: z.string(),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview-leases?${projectQuery(projectId)}`,
    {headers: mutationHeaders(), method: "POST"},
  ),
  versionFile: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => requestText(versionAssetUrl(
    "file",
    projectId,
    artifactId,
    versionId,
    path,
  )),
  versionFileBytes: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
    byteLimit: number | null,
  ) => requestBytes(
    versionAssetUrl("file", projectId, artifactId, versionId, path),
    byteLimit,
  ),
  versionFileUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => versionAssetUrl("file", projectId, artifactId, versionId, path),
  versionArchiveUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/archive?${projectQuery(projectId)}`,
  versionMediaUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => versionAssetUrl("media", projectId, artifactId, versionId, path),
  probeVersionMedia: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => requestHead(versionAssetUrl(
    "media",
    projectId,
    artifactId,
    versionId,
    path,
  )),
  comments: (
    projectId: string,
    artifactId: string,
    query: CommentThreadQuery,
  ) => {
    const search = new URLSearchParams({ projectId });
    if (query.cursor !== null) search.set("cursor", query.cursor);
    if (query.dispatched !== null) search.set("dispatched", query.dispatched);
    if (query.limit !== null) search.set("limit", String(query.limit));
    if (query.since !== null) search.set("since", query.since);
    if (query.state !== null) search.set("state", query.state);
    if (query.versionId !== null) search.set("versionId", query.versionId);
    return request(
      commentThreadPageSchema,
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments?${search}`,
    );
  },
  comment: (projectId: string, artifactId: string, threadId: string) => request(
    commentThreadDetailsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
  ),
  createComment: (
    projectId: string,
    artifactId: string,
    versionId: string,
    draft: CommentDraft,
    idempotencyKey: string,
  ) => request(
    createdCommentThreadSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/comments?${projectQuery(projectId)}`,
    {
      body: JSON.stringify(
        draft.path === null
          ? { anchor: draft.anchor, body: draft.body }
          : { anchor: draft.anchor, body: draft.body, path: draft.path },
      ),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  updateComment: (
    projectId: string,
    artifactId: string,
    threadId: string,
    edit: CommentThreadEdit,
  ) => request(
    z.object({ thread: commentThreadSchema }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify(edit),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ thread }) => thread),
  deleteComment: (projectId: string, artifactId: string, threadId: string) =>
    requestNoContent(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
      { headers: mutationHeaders(), method: "DELETE" },
    ),
  createCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    body: string,
    idempotencyKey: string,
  ) => request(
    createdCommentReplySchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ body }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  updateCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    replyId: string,
    body: string,
  ) => request(
    z.object({ reply: commentReplySchema }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ body }),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ reply }) => reply),
  deleteCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    replyId: string,
  ) => requestNoContent(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}?${projectQuery(projectId)}`,
    { headers: mutationHeaders(), method: "DELETE" },
  ),
  agents: () => request(
    z.object({ items: z.array(registeredAgentSchema) }),
    "/api/v1/agents",
  ).then(({ items }) => items),
  agentDispatches: (projectId: string, query: AgentDispatchQuery) => {
    const search = new URLSearchParams({ projectId });
    if (query.agentId !== null) search.set("agentId", query.agentId);
    if (query.cursor !== null) search.set("cursor", query.cursor);
    if (query.limit !== null) search.set("limit", String(query.limit));
    if (query.state !== null) search.set("state", query.state);
    return request(agentDispatchPageSchema, `/api/v1/agent-dispatches?${search}`);
  },
  createAgentDispatch: (
    projectId: string,
    draft: AgentDispatchDraft,
    idempotencyKey: string,
  ) => request(
    createdAgentDispatchSchema,
    `/api/v1/agent-dispatches?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({
        agentId: draft.agentId,
        note: draft.note,
        threadIds: draft.threadIds,
      }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  cancelAgentDispatch: (projectId: string, dispatchId: string) => request(
    z.object({ dispatch: agentDispatchSchema }),
    `/api/v1/agent-dispatches/${encodeURIComponent(dispatchId)}/cancel?${projectQuery(projectId)}`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ dispatch }) => dispatch),
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
  /** The registered agents with their derived presence, for live surfaces. */
  agentPresence: () => request(
    z.object({ items: z.array(agentPresenceSchema) }),
    "/api/v1/agents",
  ).then(({ items }) => items),
  /**
   * Delete this artifact's resolved (or all) comment threads in one action.
   * Threads an active send carries are skipped and counted, never deleted.
   */
  clearComments: (
    projectId: string,
    artifactId: string,
    state: "all" | "resolved",
    versionId: string | null,
  ) => request(
    commentClearResultSchema,
    `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/comments/clear`,
    {
      body: JSON.stringify(
        versionId === null ? { state } : { state, versionId },
      ),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
};
