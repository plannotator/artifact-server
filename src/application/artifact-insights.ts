import {Context, DateTime, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {AuthorizationService} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  CapabilityUnavailable,
  InvalidPagination,
} from "../core/errors.js";
import type {Principal, PrincipalKind} from "../core/identity.js";
import type {
  ArtifactInsightFacts,
  ArtifactInsights,
  InsightActivityPage,
  InsightActor,
  InsightWindow,
  ListInsightActivity,
  ReadArtifactInsights,
  StorageGrowthPoint,
  StorageInsight,
} from "../core/insights.js";
import type {PageCursor} from "../core/model.js";

/** Rows returned by every ranked list inside the summary. */
const summaryListLimit = 10;
const maximumActivityPageSize = 100;
/** Longest span still drawn one point per day before switching to weeks. */
const maximumDailyBuckets = 90;
const millisecondsPerDay = 86_400_000;

const windowDays = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const satisfies Record<Exclude<InsightWindow, "all">, number>;

/** Persistence port for dashboard reads, named for what the dashboard needs. */
export interface ArtifactInsightsRepository {
  readonly listActivity: (
    command: ListInsightActivity,
  ) => Effect.Effect<InsightActivityPage, ArtifactRepositoryFailure>;
  readonly readInsights: (
    command: ReadArtifactInsights,
  ) => Effect.Effect<ArtifactInsightFacts, ArtifactRepositoryFailure>;
}

/** A principal the deployment knows by construction rather than by record. */
export interface KnownInsightPrincipal {
  readonly displayName: string;
  readonly kind: PrincipalKind;
}

/** Dependencies of the enabled insights service. */
export interface ArtifactInsightsDependencies {
  readonly clock: ApplicationClock;
  readonly knownPrincipals: ReadonlyMap<string, KnownInsightPrincipal>;
  readonly repository: ArtifactInsightsRepository;
}

/** Input for the dashboard summary. */
export interface ReadArtifactInsightsCommand {
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly window: InsightWindow;
}

/** Input for one page of the activity timeline. */
export interface ListInsightActivityCommand {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly window: InsightWindow;
}

/** Expected failures of dashboard reads. */
export type ArtifactInsightsFailure =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | CapabilityUnavailable
  | InvalidPagination
  | ProjectManagementFailure;

interface ArtifactInsightsOperations {
  readonly listActivity: (
    command: ListInsightActivityCommand,
  ) => Effect.Effect<InsightActivityPage, ArtifactInsightsFailure>;
  readonly readInsights: (
    command: ReadArtifactInsightsCommand,
  ) => Effect.Effect<ArtifactInsights, ArtifactInsightsFailure>;
}

/**
 * Read-only dashboard over the catalog, review, storage, and activity records.
 * Every deployment provides this service; deployments whose persistence does
 * not implement the insights queries provide the disabled layer, which answers
 * the stable capability-unavailable shape.
 */
export class ArtifactInsightsService extends Context.Service<
  ArtifactInsightsService,
  ArtifactInsightsOperations
>()("artifact-server/application/ArtifactInsightsService") {
  /** Construct the enabled service over an insights-capable persistence adapter. */
  static readonly layer = (
    dependencies: ArtifactInsightsDependencies,
  ): Layer.Layer<
    ArtifactInsightsService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      ArtifactInsightsService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeArtifactInsightsService(dependencies, authorization, projects);
      }),
    );
}

/** The stable answer of a deployment without insights persistence. */
export const disabledArtifactInsightsLayer: Layer.Layer<ArtifactInsightsService> =
  Layer.succeed(
    ArtifactInsightsService,
    ArtifactInsightsService.of({
      listActivity: () => insightsUnavailable(),
      readInsights: () => insightsUnavailable(),
    }),
  );

function insightsUnavailable(): Effect.Effect<never, CapabilityUnavailable> {
  return Effect.fail(
    new CapabilityUnavailable({
      message: "Dashboard insights are not available on this deployment.",
    }),
  );
}

function makeArtifactInsightsService(
  dependencies: ArtifactInsightsDependencies,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
): ArtifactInsightsOperations {
  const authorizeScope = Effect.fn("ArtifactInsightsService.authorizeScope")(
    function*(principal: Principal, projectId: string | null) {
      // The summary reveals catalog and review aggregates, so it needs both
      // the listing authority and the comment-read authority.
      yield* authorization.requireArtifactListing(principal);
      yield* authorization.requireCommentRead(principal);
      if (projectId === null) {
        yield* authorization.requireProjectAccess(principal);
        return null;
      }
      const project = yield* projects.getProject({principal, projectId});
      return project.id;
    },
  );

  const readInsights = Effect.fn("ArtifactInsightsService.readInsights")(
    function*(command: ReadArtifactInsightsCommand) {
      const projectId = yield* authorizeScope(command.principal, command.projectId);
      const now = yield* dependencies.clock.now;
      const since = windowStart(now, command.window);
      const facts = yield* dependencies.repository.readInsights({
        listLimit: summaryListLimit,
        projectId,
        since,
      });
      const today = DateTime.formatIsoDate(now);
      const {baselineBytes, dailyGrowth, firstPublicationDay, ...storage} =
        facts.storage;
      const firstDay = since === null
        ? firstPublicationDay ?? today
        : since.slice(0, 10);
      const series = growthSeries({
        baselineBytes,
        dailyGrowth,
        firstDay,
        today,
      });
      return {
        generatedAt: DateTime.formatIso(now),
        overview: facts.overview,
        projectId,
        review: facts.review,
        since,
        storage: {...storage, growth: series.points, growthBucket: series.bucket},
        window: command.window,
      } satisfies ArtifactInsights;
    },
  );

  const listActivity = Effect.fn("ArtifactInsightsService.listActivity")(
    function*(command: ListInsightActivityCommand) {
      if (
        !Number.isInteger(command.limit) ||
        command.limit < 1 ||
        command.limit > maximumActivityPageSize
      ) {
        return yield* new InvalidPagination({
          message: `The page size must be between 1 and ${maximumActivityPageSize}.`,
        });
      }
      const projectId = yield* authorizeScope(command.principal, command.projectId);
      const now = yield* dependencies.clock.now;
      const page = yield* dependencies.repository.listActivity({
        cursor: command.cursor,
        limit: command.limit,
        projectId,
        since: windowStart(now, command.window),
      });
      return {
        items: page.items.map((event) => ({
          ...event,
          actor: knownActor(event.actor, dependencies.knownPrincipals),
        })),
        nextCursor: page.nextCursor,
      } satisfies InsightActivityPage;
    },
  );

  return ArtifactInsightsService.of({listActivity, readInsights});
}

/** Start of the first UTC day inside the window, so every bucket is a whole day. */
function windowStart(now: DateTime.Utc, window: InsightWindow): string | null {
  if (window === "all") return null;
  const firstDay = DateTime.subtract(DateTime.startOf(now, "day"), {
    days: windowDays[window] - 1,
  });
  return DateTime.formatIso(firstDay);
}

function knownActor(
  actor: InsightActor | null,
  knownPrincipals: ReadonlyMap<string, KnownInsightPrincipal>,
): InsightActor | null {
  if (actor === null || actor.displayName !== null) return actor;
  const known = knownPrincipals.get(actor.principalId);
  return known === undefined
    ? actor
    : {displayName: known.displayName, kind: known.kind, principalId: actor.principalId};
}

/** A continuous growth series and the bucket width it was drawn with. */
interface StorageGrowthSeries {
  readonly bucket: StorageInsight["growthBucket"];
  readonly points: readonly StorageGrowthPoint[];
}

/**
 * Fill the sparse per-day totals into a continuous series from the first day
 * to today. Spans longer than the daily limit fold into seven-day buckets that
 * start on the first day, so the chart keeps a readable number of points.
 */
function growthSeries(input: {
  readonly baselineBytes: number;
  readonly dailyGrowth: readonly {
    readonly addedBytes: number;
    readonly day: string;
    readonly versions: number;
  }[];
  readonly firstDay: string;
  readonly today: string;
}): StorageGrowthSeries {
  const start = Date.parse(`${input.firstDay}T00:00:00.000Z`);
  const end = Math.max(start, Date.parse(`${input.today}T00:00:00.000Z`));
  const spanDays = Math.round((end - start) / millisecondsPerDay) + 1;
  const bucketDays = spanDays > maximumDailyBuckets ? 7 : 1;
  const bucketCount = Math.ceil(spanDays / bucketDays);
  const added = Array.from({length: bucketCount}, () => 0);
  const versions = Array.from({length: bucketCount}, () => 0);
  for (const day of input.dailyGrowth) {
    const offset = Math.round(
      (Date.parse(`${day.day}T00:00:00.000Z`) - start) / millisecondsPerDay,
    );
    if (offset < 0 || offset >= spanDays) continue;
    const bucket = Math.floor(offset / bucketDays);
    added[bucket] = (added[bucket] ?? 0) + day.addedBytes;
    versions[bucket] = (versions[bucket] ?? 0) + day.versions;
  }
  let cumulativeBytes = input.baselineBytes;
  const points = added.map((addedBytes, index) => {
    cumulativeBytes += addedBytes;
    return {
      addedBytes,
      cumulativeBytes,
      day: new Date(start + index * bucketDays * millisecondsPerDay)
        .toISOString()
        .slice(0, 10),
      versions: versions[index] ?? 0,
    };
  });
  return {bucket: bucketDays === 1 ? "day" : "week", points};
}
