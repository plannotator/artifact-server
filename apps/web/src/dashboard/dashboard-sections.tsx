import type {ReactNode} from "react";

import type {Insights} from "@/api/client";
import {StatusBadge} from "@/components/product";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Progress} from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {dashboardText} from "@/i18n/messages/dashboard";
import {formatBytes, formatRelativeTime, formatTimestamp} from "@/lib/presentation";
import {GrowthChart, TagChart} from "./dashboard-charts.tsx";
import {
  artifactReviewHref,
  dispatchStates,
  formatDay,
  percentage,
} from "./dashboard-format.ts";

const readingsText = dashboardText.readings;
const overviewText = dashboardText.overview;
const reviewText = dashboardText.review;
const storageText = dashboardText.storage;

/** One counted reading in the readings panel: label, figure, then context. */
function Reading({
  detail,
  label,
  value,
}: {
  readonly detail: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 bg-card px-6 py-4">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl tabular-nums slashed-zero">{value}</dd>
      <dd className="col-span-2 text-sm text-muted-foreground">{detail}</dd>
    </div>
  );
}

/**
 * The dashboard overview readings in a compact grid.
 */
export function DashboardHeadline({insights}: {readonly insights: Insights}) {
  const {overview, review, storage} = insights;
  const inWindow = insights.window === "all" ? readingsText.inTotal : readingsText.inThisWindow;
  const inFlight = review.dispatches.queued + review.dispatches.claimed +
    review.dispatches.delivered;
  return (
    <section
      aria-label={readingsText.label}
      className="grid min-w-0 gap-px self-start overflow-hidden rounded-[var(--radius-card)] border border-border bg-border"
    >
      <dl className="grid gap-px">
        <Reading
          detail={readingsText.acrossEveryVersion(formatBytes(storage.logicalBytes))}
          label={readingsText.stored}
          value={formatBytes(storage.storedBytes)}
        />
        <Reading
          detail={readingsText.versionsDetail(overview.versionCount, overview.versionsInWindow, inWindow)}
          label={readingsText.artifacts}
          value={String(overview.artifactCount)}
        />
        <Reading
          detail={readingsText.threadsDetail(review.threadsOpenedInWindow, review.threadsResolvedInWindow, inWindow)}
          label={readingsText.openThreads}
          value={String(review.openThreads)}
        />
        <Reading
          detail={readingsText.dispatchesDetail(inFlight, review.dispatches.failed)}
          label={readingsText.dispatches}
          value={String(review.dispatchesInWindow)}
        />
      </dl>
    </section>
  );
}

function SectionCard({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 grid-cols-1 gap-6">{children}</CardContent>
    </Card>
  );
}

function Subheading({children}: {readonly children: ReactNode}) {
  return (
    <h3 className="text-sm font-medium text-muted-foreground">
      {children}
    </h3>
  );
}

function Quiet({children}: {readonly children: ReactNode}) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** What exists, what changed recently, and how it is tagged. */
export function OverviewSection({
  insights,
  now,
  projectNames,
}: {
  readonly insights: Insights;
  readonly now: number;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const {overview} = insights;
  const showProjects = insights.projectId === null && overview.projects.length > 1;
  return (
    <SectionCard
      description={overviewText.description}
      title={overviewText.title}
    >
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="grid min-w-0 grid-cols-1 content-start gap-3">
        <Subheading>{overviewText.recentlyUpdated}</Subheading>
        {overview.recentArtifacts.length === 0
          ? <Quiet>{overviewText.noArtifacts}</Quiet>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{overviewText.artifact}</TableHead>
                  {showProjects ? <TableHead>{overviewText.project}</TableHead> : null}
                  <TableHead className="text-right">{overviewText.version}</TableHead>
                  <TableHead className="text-right">{overviewText.updated}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.recentArtifacts.map((artifact) => (
                  <TableRow key={artifact.artifactId}>
                    <TableCell className="max-w-64 truncate">
                      <a
                        className="underline-offset-4 hover:underline"
                        href={artifactReviewHref(artifact.projectId, artifact.artifactId)}
                      >
                        {artifact.name}
                      </a>
                    </TableCell>
                    {showProjects
                      ? <TableCell>{projectNames.get(artifact.projectId) ?? artifact.projectId}</TableCell>
                      : null}
                    <TableCell className="text-right font-mono tabular-nums">
                      v{artifact.latestVersionNumber}
                    </TableCell>
                    <TableCell className="text-right" title={formatTimestamp(artifact.latestVersionAt)}>
                      {formatRelativeTime(artifact.latestVersionAt, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <div className="grid min-w-0 content-start gap-6">
      {showProjects
        ? (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <Subheading>{overviewText.projects}</Subheading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{overviewText.project}</TableHead>
                  <TableHead className="text-right">{overviewText.artifacts}</TableHead>
                  <TableHead className="text-right">{overviewText.versions}</TableHead>
                  <TableHead className="text-right">{overviewText.lastVersion}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.projects.map((project) => (
                  <TableRow key={project.projectId}>
                    <TableCell>
                      {project.name}
                      {project.archived ? <span className="ml-2"><StatusBadge>{overviewText.archived}</StatusBadge></span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{project.artifactCount}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{project.versionCount}</TableCell>
                    <TableCell className="text-right">
                      {project.latestVersionAt === null ? overviewText.noneYet : formatRelativeTime(project.latestVersionAt, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
        : null}
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <Subheading>{overviewText.tags}</Subheading>
        {overview.tags.length === 0
          ? <Quiet>{overviewText.noTags}</Quiet>
          : <TagChart tags={overview.tags} />}
        <Quiet>
          {overviewText.tagSummary(overview.untaggedArtifactCount, overview.publicLinkCount)}
        </Quiet>
      </div>
      </div>
      </div>
    </SectionCard>
  );
}

/** What still needs attention and what agents were asked to do. */
export function ReviewSection({
  insights,
  now,
}: {
  readonly insights: Insights;
  readonly now: number;
}) {
  const {review} = insights;
  const total = review.openThreads + review.resolvedThreads;
  const resolvedShare = percentage(review.resolvedThreads, total);
  return (
    <SectionCard
      description={reviewText.description}
      title={reviewText.title}
    >
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <Subheading>{reviewText.resolved}</Subheading>
          <span className="font-mono text-sm tabular-nums">
            {reviewText.resolvedOf(review.resolvedThreads, total)}
          </span>
        </div>
        {resolvedShare === null
          ? <Quiet>{reviewText.noThreads}</Quiet>
          : <Progress aria-label={reviewText.resolvedThreads} value={resolvedShare} />}
        <Quiet>
          {reviewText.openSummary(review.openThreads, review.openDispatchedThreads)}
          {review.oldestOpenThreadAt === null
            ? null
            : reviewText.oldestOpened(formatRelativeTime(review.oldestOpenThreadAt, now))}
        </Quiet>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3" id="dispatches">
        <Subheading>{reviewText.dispatches}</Subheading>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {dispatchStates.map((entry) => (
            <div className="flex items-center justify-between gap-3" key={entry.state}>
              <dt>
                <StatusBadge tone={review.dispatches[entry.state] > 0 ? entry.tone : "neutral"}>
                  {entry.label}
                </StatusBadge>
              </dt>
              <dd className="font-mono tabular-nums">{review.dispatches[entry.state]}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <Subheading>{reviewText.mostOpenThreads}</Subheading>
        {review.openThreadsByArtifact.length === 0
          ? <Quiet>{reviewText.nothingWaiting}</Quiet>
          : (
            <ul className="grid grid-cols-1 gap-2 text-sm">
              {review.openThreadsByArtifact.map((artifact) => (
                <li className="flex min-w-0 items-center justify-between gap-4" key={artifact.artifactId}>
                  <a
                    className="min-w-0 truncate underline-offset-4 hover:underline"
                    href={artifactReviewHref(artifact.projectId, artifact.artifactId)}
                  >
                    {artifact.name}
                  </a>
                  <span className="font-mono tabular-nums">{artifact.openThreads}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </SectionCard>
  );
}

/** How many bytes the catalog holds, how fast it grows, and Git-history use. */
export function StorageSection({
  insights,
  projectNames,
}: {
  readonly insights: Insights;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const {storage} = insights;
  const saved = storage.logicalBytes - storage.storedBytes;
  const firstDay = storage.growth.at(0)?.day;
  const enabledProjects = storage.gitHistory.projects.filter((project) => project.enabled);
  return (
    <SectionCard
      description={storageText.description}
      title={storageText.title}
    >
      <dl className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-4 sm:grid-cols-[repeat(4,minmax(0,1fr))]">
        <Figure label={storageText.stored} value={formatBytes(storage.storedBytes)} />
        <Figure label={storageText.acrossVersions} value={formatBytes(storage.logicalBytes)} />
        <Figure label={storageText.savedByDeduplication} value={formatBytes(saved)} />
        <Figure label={storageText.files(storage.distinctBlobCount)} value={String(storage.fileCount)} />
      </dl>
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <Subheading>
          {storageText.publishedBytes(firstDay === undefined ? null : formatDay(firstDay))}
        </Subheading>
        {storage.growth.length < 2
          ? (
            <Quiet>
              {storageText.singleDay(
                formatBytes(storage.growth.at(0)?.cumulativeBytes ?? 0),
                firstDay === undefined ? null : formatDay(firstDay),
              )}
            </Quiet>
          )
          : <GrowthChart bucket={storage.growthBucket} points={storage.growth} />}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{storageText.viewAsTable}</summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{storage.growthBucket === "week" ? storageText.weekOf : storageText.day}</TableHead>
                <TableHead className="text-right">{storageText.added}</TableHead>
                <TableHead className="text-right">{storageText.versions}</TableHead>
                <TableHead className="text-right">{storageText.total}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {storage.growth.filter((point) => point.versions > 0).map((point) => (
                <TableRow key={point.day}>
                  <TableCell>{formatDay(point.day)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatBytes(point.addedBytes)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{point.versions}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatBytes(point.cumulativeBytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <Subheading>{storageText.largestArtifacts}</Subheading>
        {storage.largestArtifacts.length === 0
          ? <Quiet>{storageText.noArtifacts}</Quiet>
          : (
            <ul className="grid grid-cols-1 gap-2 text-sm">
              {storage.largestArtifacts.map((artifact) => (
                <li className="flex min-w-0 items-center justify-between gap-4" key={artifact.artifactId}>
                  <a
                    className="min-w-0 truncate underline-offset-4 hover:underline"
                    href={artifactReviewHref(artifact.projectId, artifact.artifactId)}
                  >
                    {artifact.name}
                  </a>
                  <span className="font-mono tabular-nums">{formatBytes(artifact.logicalBytes)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <Subheading>{storageText.gitHistory}</Subheading>
        {enabledProjects.length === 0
          ? <Quiet>{storageText.gitHistoryOff}</Quiet>
          : (
            <>
              <Quiet>
                {storageText.gitHistorySummary(
                  formatBytes(storage.gitHistory.committedBytes),
                  formatBytes(storage.gitHistory.reservedBytes),
                  storage.gitHistory.pendingJobs,
                  storage.gitHistory.failingJobs,
                )}
              </Quiet>
              {enabledProjects.map((project) => {
                const used = project.committedBytes + project.reservedBytes;
                const share = project.budgetBytes === null ? null : percentage(used, project.budgetBytes);
                return (
                  <div className="grid gap-1.5" key={project.projectId}>
                    <div className="flex justify-between gap-4 text-sm">
                      <span>{projectNames.get(project.projectId) ?? project.projectId}</span>
                      <span className="font-mono tabular-nums">
                        {formatBytes(used)}
                        {project.budgetBytes === null ? storageText.noBudget : storageText.ofBudget(formatBytes(project.budgetBytes))}
                      </span>
                    </div>
                    {share === null
                      ? null
                      : <Progress aria-label={storageText.budgetUsed} value={Math.min(100, share)} />}
                  </div>
                );
              })}
            </>
          )}
      </div>
    </SectionCard>
  );
}

function Figure({label, value}: {readonly label: string; readonly value: string}) {
  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg tabular-nums slashed-zero">{value}</dd>
    </div>
  );
}
