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
import {formatBytes, formatRelativeTime, formatTimestamp} from "@/lib/presentation";
import {GrowthChart, TagChart} from "./dashboard-charts.tsx";
import {
  artifactReviewHref,
  dispatchStates,
  formatDay,
  percentage,
} from "./dashboard-format.ts";

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
 * The readings panel: one value set large (what the installation holds),
 * then three counted readings, cut from one surface with hairline seams.
 */
export function DashboardHeadline({insights}: {readonly insights: Insights}) {
  const {overview, review, storage} = insights;
  const inWindow = insights.window === "all" ? "in total" : "in this window";
  const inFlight = review.dispatches.queued + review.dispatches.claimed +
    review.dispatches.delivered;
  return (
    <section
      aria-label="Readings"
      className="grid min-w-0 gap-px self-start overflow-hidden rounded-[var(--radius-card)] border border-border bg-border"
    >
      <div className="grid gap-1 bg-card px-6 py-5">
        <h2 className="text-sm font-medium text-muted-foreground">Stored</h2>
        <p className="font-mono text-4xl leading-none tabular-nums slashed-zero">
          {formatBytes(storage.storedBytes)}
        </p>
        <p className="text-sm text-muted-foreground">
          {formatBytes(storage.logicalBytes)} across every version
        </p>
      </div>
      <dl className="grid gap-px">
        <Reading
          detail={`${overview.versionCount} versions, ${overview.versionsInWindow} ${inWindow}`}
          label="Artifacts"
          value={String(overview.artifactCount)}
        />
        <Reading
          detail={`${review.threadsOpenedInWindow} opened and ${review.threadsResolvedInWindow} resolved ${inWindow}`}
          label="Open threads"
          value={String(review.openThreads)}
        />
        <Reading
          detail={`${inFlight} still with an agent, ${review.dispatches.failed} failed`}
          label="Dispatches"
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
      <CardContent className="grid min-w-0 gap-6">{children}</CardContent>
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
      description="Live artifacts, their latest versions, and tags."
      title="Artifacts"
    >
      <div className="grid gap-3">
        <Subheading>Recently updated</Subheading>
        {overview.recentArtifacts.length === 0
          ? <Quiet>No artifacts yet.</Quiet>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Artifact</TableHead>
                  {showProjects ? <TableHead>Project</TableHead> : null}
                  <TableHead className="text-right">Version</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
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
      {showProjects
        ? (
          <div className="grid gap-3">
            <Subheading>Projects</Subheading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead className="text-right">Artifacts</TableHead>
                  <TableHead className="text-right">Versions</TableHead>
                  <TableHead className="text-right">Last version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.projects.map((project) => (
                  <TableRow key={project.projectId}>
                    <TableCell>
                      {project.name}
                      {project.archived ? <span className="ml-2"><StatusBadge>Archived</StatusBadge></span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{project.artifactCount}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{project.versionCount}</TableCell>
                    <TableCell className="text-right">
                      {project.latestVersionAt === null ? "None yet" : formatRelativeTime(project.latestVersionAt, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
        : null}
      <div className="grid gap-3">
        <Subheading>Tags</Subheading>
        {overview.tags.length === 0
          ? <Quiet>No artifact carries a tag.</Quiet>
          : <TagChart tags={overview.tags} />}
        <Quiet>
          {overview.untaggedArtifactCount} untagged, {overview.publicLinkCount} with a public link.
        </Quiet>
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
      description="Comment threads and agent dispatches."
      title="Review"
    >
      <div className="grid gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <Subheading>Resolved</Subheading>
          <span className="font-mono text-sm tabular-nums">
            {review.resolvedThreads} of {total}
          </span>
        </div>
        {resolvedShare === null
          ? <Quiet>No comment threads yet.</Quiet>
          : <Progress aria-label="Resolved threads" value={resolvedShare} />}
        <Quiet>
          {review.openThreads} open, {review.openDispatchedThreads} of them sent to an agent.
          {review.oldestOpenThreadAt === null
            ? null
            : ` The oldest was opened ${formatRelativeTime(review.oldestOpenThreadAt, now)}.`}
        </Quiet>
      </div>
      <div className="grid gap-3">
        <Subheading>Dispatches</Subheading>
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
      <div className="grid gap-3">
        <Subheading>Most open threads</Subheading>
        {review.openThreadsByArtifact.length === 0
          ? <Quiet>Nothing is waiting for review.</Quiet>
          : (
            <ul className="grid gap-2 text-sm">
              {review.openThreadsByArtifact.map((artifact) => (
                <li className="flex items-center justify-between gap-4" key={artifact.artifactId}>
                  <a
                    className="truncate underline-offset-4 hover:underline"
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
      description="Bytes stay stored after an artifact is deleted, because versions are immutable."
      title="Storage"
    >
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Stored" value={formatBytes(storage.storedBytes)} />
        <Figure label="Across versions" value={formatBytes(storage.logicalBytes)} />
        <Figure label="Saved by deduplication" value={formatBytes(saved)} />
        <Figure label={`Files, ${storage.distinctBlobCount} unique`} value={String(storage.fileCount)} />
      </dl>
      <div className="grid gap-3">
        <Subheading>
          Published bytes{firstDay === undefined ? "" : ` since ${formatDay(firstDay)}`}
        </Subheading>
        {storage.growth.length < 2
          ? (
            <Quiet>
              {formatBytes(storage.growth.at(0)?.cumulativeBytes ?? 0)} published
              {firstDay === undefined ? "" : ` on ${formatDay(firstDay)}`}; a trend appears once a second day has data.
            </Quiet>
          )
          : <GrowthChart bucket={storage.growthBucket} points={storage.growth} />}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">View as table</summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{storage.growthBucket === "week" ? "Week of" : "Day"}</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                <TableHead className="text-right">Total</TableHead>
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
      <div className="grid gap-3">
        <Subheading>Largest artifacts</Subheading>
        {storage.largestArtifacts.length === 0
          ? <Quiet>No artifacts yet.</Quiet>
          : (
            <ul className="grid gap-2 text-sm">
              {storage.largestArtifacts.map((artifact) => (
                <li className="flex items-center justify-between gap-4" key={artifact.artifactId}>
                  <a
                    className="truncate underline-offset-4 hover:underline"
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
      <div className="grid gap-3">
        <Subheading>Git history</Subheading>
        {enabledProjects.length === 0
          ? <Quiet>Git-history mirroring is off for every project in view.</Quiet>
          : (
            <>
              <Quiet>
                {formatBytes(storage.gitHistory.committedBytes)} mirrored,
                {" "}{formatBytes(storage.gitHistory.reservedBytes)} reserved,
                {" "}{storage.gitHistory.pendingJobs} jobs pending
                {storage.gitHistory.failingJobs > 0 ? `, ${storage.gitHistory.failingJobs} retrying after an error` : ""}.
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
                        {project.budgetBytes === null ? " (no budget)" : ` of ${formatBytes(project.budgetBytes)}`}
                      </span>
                    </div>
                    {share === null
                      ? null
                      : <Progress aria-label="Git-history budget used" value={Math.min(100, share)} />}
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
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg tabular-nums slashed-zero">{value}</dd>
    </div>
  );
}
