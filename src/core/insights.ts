import type {PageCursor} from "./model.js";
import type {PrincipalKind} from "./identity.js";

/** Reporting windows a dashboard reader can select. */
export const insightWindows = ["7d", "30d", "90d", "all"] as const;

/** One reporting window; `all` reads the installation's whole history. */
export type InsightWindow = (typeof insightWindows)[number];

/** The window a reader gets when they do not choose one. */
export const defaultInsightWindow: InsightWindow = "30d";

/** Agent-dispatch lifecycle states counted by the review section. */
export const insightDispatchStates = [
  "queued",
  "claimed",
  "delivered",
  "addressed",
  "failed",
  "canceled",
] as const;

/** One agent-dispatch lifecycle state. */
export type InsightDispatchState = (typeof insightDispatchStates)[number];

/** Artifact and version totals for one project in the reporting scope. */
export interface ProjectInsight {
  readonly archived: boolean;
  readonly artifactCount: number;
  readonly latestVersionAt: string | null;
  readonly name: string;
  readonly projectId: string;
  readonly versionCount: number;
}

/** One live artifact ordered by its most recent version. */
export interface RecentArtifactInsight {
  readonly artifactId: string;
  readonly latestVersionAt: string;
  readonly latestVersionNumber: number;
  readonly name: string;
  readonly projectId: string;
}

/** How many live artifacts carry one tag. */
export interface TagInsight {
  readonly artifactCount: number;
  readonly tag: string;
}

/** Catalog totals: what exists and how recently it changed. */
export interface ArtifactOverviewInsight {
  readonly artifactCount: number;
  readonly projects: readonly ProjectInsight[];
  readonly publicLinkCount: number;
  readonly recentArtifacts: readonly RecentArtifactInsight[];
  readonly tags: readonly TagInsight[];
  readonly untaggedArtifactCount: number;
  readonly versionCount: number;
  readonly versionsInWindow: number;
}

/** One live artifact with unresolved review threads. */
export interface OpenThreadArtifactInsight {
  readonly artifactId: string;
  readonly name: string;
  readonly openThreads: number;
  readonly projectId: string;
}

/** Review progress: what is unresolved and what agents were asked to do. */
export interface ReviewInsight {
  readonly dispatches: Readonly<Record<InsightDispatchState, number>>;
  readonly dispatchesInWindow: number;
  readonly oldestOpenThreadAt: string | null;
  readonly openDispatchedThreads: number;
  readonly openThreads: number;
  readonly openThreadsByArtifact: readonly OpenThreadArtifactInsight[];
  readonly repliesInWindow: number;
  readonly resolvedThreads: number;
  readonly threadsOpenedInWindow: number;
  readonly threadsResolvedInWindow: number;
}

/** Bytes published on one day (UTC) or one week starting that day. */
export interface StorageGrowthPoint {
  readonly addedBytes: number;
  readonly cumulativeBytes: number;
  readonly day: string;
  readonly versions: number;
}

/** One live artifact ranked by the bytes its versions declare. */
export interface LargestArtifactInsight {
  readonly artifactId: string;
  readonly logicalBytes: number;
  readonly name: string;
  readonly projectId: string;
}

/** Git-history mirroring configuration and consumption for one project. */
export interface ProjectGitHistoryInsight {
  readonly budgetBytes: number | null;
  readonly committedBytes: number;
  readonly enabled: boolean;
  readonly projectId: string;
  readonly reservedBytes: number;
}

/** Git-history consumption across the reporting scope. */
export interface GitHistoryInsight {
  readonly committedBytes: number;
  readonly failingJobs: number;
  readonly pendingJobs: number;
  readonly projects: readonly ProjectGitHistoryInsight[];
  readonly reservedBytes: number;
}

/** Storage consumption: declared bytes, deduplicated bytes, and growth. */
export interface StorageInsight {
  readonly distinctBlobCount: number;
  readonly fileCount: number;
  readonly gitHistory: GitHistoryInsight;
  readonly growth: readonly StorageGrowthPoint[];
  readonly growthBucket: "day" | "week";
  readonly largestArtifacts: readonly LargestArtifactInsight[];
  readonly logicalBytes: number;
  readonly storedBytes: number;
}

/** The kinds of durable change the activity timeline reports. */
export const insightActivityKinds = [
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
] as const;

/** One kind of durable change. */
export type InsightActivityKind = (typeof insightActivityKinds)[number];

/** Who made a change, as far as durable records can say. */
export interface InsightActor {
  /**
   * The member or agent name, or `null` when the principal is an API key or
   * is no longer known; API key names stay an administration-only detail.
   */
  readonly displayName: string | null;
  /** `null` when the principal is no longer known to the installation. */
  readonly kind: PrincipalKind | null;
  readonly principalId: string;
}

/** One durable change in the activity timeline. */
export interface InsightActivityEvent {
  /**
   * `null` for transitions whose record keeps no actor: inferred addressing,
   * delivery failure, and cancellation.
   */
  readonly actor: InsightActor | null;
  readonly artifactId: string | null;
  readonly artifactName: string | null;
  readonly id: string;
  readonly kind: InsightActivityKind;
  readonly occurredAt: string;
  readonly projectId: string;
  readonly versionNumber: number | null;
}

/** One newest-first page of activity. */
export interface InsightActivityPage {
  readonly items: readonly InsightActivityEvent[];
  readonly nextCursor: PageCursor | null;
}

/** Durable facts a persistence adapter reads for one reporting scope. */
export interface ArtifactInsightFacts {
  readonly overview: ArtifactOverviewInsight;
  readonly review: ReviewInsight;
  readonly storage: Omit<StorageInsight, "growth" | "growthBucket"> & {
    /** Bytes published before the window opened; zero for `all`. */
    readonly baselineBytes: number;
    /** Sparse per-day publication totals inside the window, oldest first. */
    readonly dailyGrowth: readonly {
      readonly addedBytes: number;
      readonly day: string;
      readonly versions: number;
    }[];
    /** First day any version was published in scope, or null when empty. */
    readonly firstPublicationDay: string | null;
  };
}

/** Persistence query for the dashboard summary. */
export interface ReadArtifactInsights {
  readonly listLimit: number;
  /** `null` reads every project in the installation. */
  readonly projectId: string | null;
  /** Inclusive lower bound; `null` reads the whole history. */
  readonly since: string | null;
}

/** Persistence query for one page of the activity timeline. */
export interface ListInsightActivity {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectId: string | null;
  readonly since: string | null;
}

/** The dashboard summary for one reporting scope. */
export interface ArtifactInsights {
  readonly generatedAt: string;
  readonly overview: ArtifactOverviewInsight;
  readonly projectId: string | null;
  readonly review: ReviewInsight;
  readonly since: string | null;
  readonly storage: StorageInsight;
  readonly window: InsightWindow;
}
