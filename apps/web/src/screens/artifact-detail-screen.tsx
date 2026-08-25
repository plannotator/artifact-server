import { useEffect, useState } from "react";

import {
  api,
  ApiError,
  type ArtifactAction,
  type ArtifactComparison,
  type ArtifactDetails,
  type ArtifactVersion,
  type CommentThread,
  type Project,
  type SourceBinding,
  type Version,
} from "@/api/client";
import { useCommentPoll } from "@/components/comments/comment-poll";
import { CommentsPanel } from "@/components/comments/comments-panel";
import {
  ErrorPanel,
  MetadataRow,
  PageHeader,
  StatePanel,
  StatusBadge,
} from "@/components/product";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  accessSettingLabel,
  actionLabel,
  formatBytes,
  formatTimestamp,
  sourceDriftDescription,
  sourceFreshnessLabel,
  sourceFreshnessTone,
} from "@/lib/presentation";

const openThreadQuery = {
  cursor: null,
  // Unset: the server hides the threads an active send carries, so the version
  // counts stop including an annotation as soon as it is sent.
  dispatched: null,
  limit: 100,
  since: null,
  state: "open",
  versionId: null,
} as const;

function countOpenThreadsByVersion(
  threads: readonly CommentThread[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    counts.set(thread.versionId, (counts.get(thread.versionId) ?? 0) + 1);
  }
  return counts;
}

interface VersionListItem {
  readonly links: { readonly version: string };
  readonly version: Version;
}

/**
 * The binding this screen may show: a linked file exists in the read, and this
 * deployment offers linked files at all. A deployment without the capability
 * shows no linked affordance anywhere, whatever a read happens to carry.
 */
function shownBinding(
  details: ArtifactDetails | null,
  linkedArtifacts: boolean,
): SourceBinding | null {
  if (!linkedArtifacts || details === null) return null;
  return details.sourceBinding ?? null;
}

/** Complete artifact metadata, history, comparison, mutation, and tombstone surface. */
export function ArtifactDetailScreen({
  artifactId,
  canManage,
  linkedArtifacts,
  project,
}: {
  readonly artifactId: string;
  readonly canManage: boolean;
  readonly linkedArtifacts: boolean;
  readonly project: Project;
}) {
  const [details, setDetails] = useState<ArtifactDetails | null>(null);
  const [versions, setVersions] = useState<readonly VersionListItem[]>([]);
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [actionsNextCursor, setActionsNextCursor] = useState<string | null>(null);
  const [openThreads, setOpenThreads] = useState<readonly CommentThread[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMoreActions, setLoadingMoreActions] = useState(false);
  const [opening, setOpening] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedDetails, loadedVersions, loadedActions, loadedThreads] =
        await Promise.all([
          api.artifact(project.id, artifactId),
          api.versions(project.id, artifactId),
          api.actions(project.id, artifactId, null),
          api.comments(project.id, artifactId, openThreadQuery),
        ]);
      setDetails(loadedDetails);
      setVersions(loadedVersions);
      setActions(loadedActions.actions);
      setActionsNextCursor(loadedActions.nextCursor);
      setOpenThreads(loadedThreads.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Artifact loading failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [artifactId, project.id]);

  /**
   * Re-read the artifact on its own. The read lazily refreshes a linked file's
   * freshness, so the badge follows the file on disk, and it names the current
   * version, which the implicit capture behind a comment can move.
   */
  const refreshDetails = async (): Promise<void> => {
    try {
      setDetails(await api.artifact(project.id, artifactId));
    } catch {
      // A failed refresh changes nothing on screen; Reload reports for itself.
    }
  };

  // The linked file's freshness rides the comment surfaces' own poll cadence:
  // one visibility-aware interval, running only while this artifact is linked.
  useCommentPoll(refreshDetails, shownBinding(details, linkedArtifacts) !== null);

  const loadOpenThreads = async () => {
    try {
      const page = await api.comments(project.id, artifactId, openThreadQuery);
      setOpenThreads(page.items);
      // A comment on a drifted binding captures first, so the current version
      // and the freshness can both have moved with it.
      await refreshDetails();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    }
  };

  const loadMoreActions = async () => {
    if (actionsNextCursor === null) return;
    setLoadingMoreActions(true);
    setError(null);
    try {
      const loaded = await api.actions(
        project.id,
        artifactId,
        actionsNextCursor,
      );
      setActions((current) => [...current, ...loaded.actions]);
      setActionsNextCursor(loaded.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Action history loading failed."));
    } finally {
      setLoadingMoreActions(false);
    }
  };

  const openPrivateVersion = async (
    versionId?: string,
    destinationPath?: string,
  ) => {
    const popup = window.open("about:blank", "_blank");
    setOpening(true);
    setError(null);
    try {
      const issued = await api.contentSession(
        project.id,
        artifactId,
        versionId,
        destinationPath,
      );
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setError(caught instanceof Error ? caught : new Error("Artifact opening failed."));
    } finally {
      setOpening(false);
    }
  };

  if (loading && details === null) {
    return (
      <StatePanel
        description="Loading artifact metadata and immutable history."
        title="Loading artifact"
      />
    );
  }
  if (error !== null && details === null) {
    return <ErrorPanel error={error} onRetry={() => void load()} />;
  }
  if (details === null) {
    return (
      <StatePanel
        description="The artifact is not available in this project."
        title="Artifact unavailable"
      />
    );
  }

  const publicArtifact = details.artifact.accessSetting === "public_link";
  const openThreadCounts = countOpenThreadsByVersion(openThreads);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <>
            {publicArtifact
              ? (
                <Button
                  render={<a href={details.links.artifact} rel="noreferrer" target="_blank" />}
                  type="button"
                >
                  Open artifact
                </Button>
              )
              : (
                <Button
                  disabled={opening}
                  onClick={() => void openPrivateVersion()}
                  type="button"
                >
                  {opening ? "Opening…" : "Open artifact"}
                </Button>
              )}
            <Button
              onClick={() => void load()}
              type="button"
              variant="outline"
            >
              Reload
            </Button>
          </>
        )}
        description={`Project: ${project.name}`}
        eyebrow="Artifact"
        title={details.artifact.name}
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full overflow-x-auto" variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="actions">Action history</TabsTrigger>
        </TabsList>

        <TabsContent className="pt-6" value="overview">
          <Overview
            binding={shownBinding(details, linkedArtifacts)}
            canManage={canManage}
            details={details}
            onChanged={load}
            onError={setError}
            project={project}
          />
        </TabsContent>
        <TabsContent className="pt-6" value="versions">
          <VersionHistory
            artifactId={artifactId}
            canManage={canManage}
            currentVersionId={details.artifact.currentVersionId}
            openThreadCounts={openThreadCounts}
            onChanged={load}
            onError={setError}
            onOpenPrivate={openPrivateVersion}
            projectId={project.id}
            publicCurrent={publicArtifact}
            versions={versions}
          />
        </TabsContent>
        <TabsContent className="pt-6" value="compare">
          <ComparisonPanel
            artifactId={artifactId}
            opening={opening}
            onError={setError}
            onOpenVersion={openPrivateVersion}
            projectId={project.id}
            versions={versions}
          />
        </TabsContent>
        <TabsContent className="pt-6" value="comments">
          <CommentsPanel
            artifactId={artifactId}
            canManage={canManage}
            canSend={canManage && project.archivedAt === null}
            currentVersionId={details.artifact.currentVersionId}
            onThreadsChanged={loadOpenThreads}
            projectId={project.id}
            versions={versions.map(({ version }) => version)}
          />
        </TabsContent>
        <TabsContent className="pt-6" value="actions">
          <ActionHistory
            actions={actions}
            loadingMore={loadingMoreActions}
            nextCursor={actionsNextCursor}
            onLoadMore={loadMoreActions}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({
  binding,
  canManage,
  details,
  onChanged,
  onError,
  project,
}: {
  readonly binding: SourceBinding | null;
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
  readonly project: Project;
}) {
  const artifact = details.artifact;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="border p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-lg font-semibold">Current artifact</h2>
          <StatusBadge tone={artifact.accessSetting === "public_link" ? "primary" : "neutral"}>
            {accessSettingLabel(artifact.accessSetting)}
          </StatusBadge>
        </div>
        <dl>
          <MetadataRow label="Current version">Version {details.current.version.number}</MetadataRow>
          <MetadataRow label="Saved">{formatTimestamp(details.current.version.createdAt)}</MetadataRow>
          <MetadataRow label="Entry file">{details.current.version.entryPath}</MetadataRow>
          <MetadataRow label="Routing">{details.current.version.routingMode.toUpperCase()}</MetadataRow>
          <MetadataRow label="Tags">
            {artifact.tags.length === 0
              ? "No tags"
              : (
                <span className="flex flex-wrap gap-3">
                  {artifact.tags.map((tag) => <StatusBadge key={tag}>{tag}</StatusBadge>)}
                </span>
              )}
          </MetadataRow>
          {binding === null
            ? null
            : (
              <>
                <MetadataRow label="Linked file">
                  <span className="flex flex-wrap items-center gap-3">
                    <code className="font-mono text-xs break-all">{binding.path}</code>
                    <StatusBadge tone={sourceFreshnessTone(binding.status)}>
                      {sourceFreshnessLabel(binding.status)}
                    </StatusBadge>
                  </span>
                </MetadataRow>
                <MetadataRow label="Source checked">
                  {formatTimestamp(binding.lastVerifiedAt)}
                </MetadataRow>
              </>
            )}
        </dl>
        {binding === null
          ? null
          : (
            <LinkedSourcePanel
              binding={binding}
              canManage={canManage}
              details={details}
              onChanged={onChanged}
              onError={onError}
            />
          )}
        <details className="mt-5 border-t pt-5">
          <summary className="cursor-pointer text-xs font-semibold tracking-widest uppercase">
            Technical details
          </summary>
          <dl className="mt-3">
            <MetadataRow label="Artifact ID">
              <code className="font-mono text-xs break-all">{artifact.id}</code>
            </MetadataRow>
            <MetadataRow label="Project ID">
              <code className="font-mono text-xs break-all">{artifact.projectId}</code>
            </MetadataRow>
            <MetadataRow label="Version ID">
              <code className="font-mono text-xs break-all">{details.current.version.id}</code>
            </MetadataRow>
            <MetadataRow label="Manifest digest">
              <code className="font-mono text-xs break-all">{details.current.manifest.digest}</code>
            </MetadataRow>
          </dl>
        </details>
      </section>

      <aside className="flex flex-col gap-3 border p-5">
        <h2 className="font-heading text-lg font-semibold">Manage</h2>
        {canManage
          ? (
            <>
              <TagDialog details={details} onChanged={onChanged} onError={onError} />
              <AccessDialog details={details} onChanged={onChanged} onError={onError} />
              <TombstoneDialog
                details={details}
                onError={onError}
                projectId={project.id}
              />
            </>
          )
          : (
            <p className="text-sm leading-6 text-muted-foreground">
              Your principal can read this artifact but cannot change it.
            </p>
          )}
      </aside>
    </div>
  );
}

/**
 * The linked file's ambient state and the one write it offers. Drift is shown,
 * never enforced: nothing here blocks reading, sharing, or commenting on the
 * captured version, and capturing is always an explicit, attributed act.
 */
function LinkedSourcePanel({
  binding,
  canManage,
  details,
  onChanged,
  onError,
}: {
  readonly binding: SourceBinding;
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
}) {
  const [pending, setPending] = useState(false);
  const readable = binding.status === "in-sync" || binding.status === "modified";

  const capture = async () => {
    setPending(true);
    try {
      await api.captureArtifact(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      await onChanged();
    } catch (caught) {
      const failure = caught instanceof Error
        ? caught
        : new Error("Capture failed.");
      // Somebody captured first, so the version this screen named is no longer
      // current: re-read before the standard conflict presentation says so.
      if (failure instanceof ApiError && failure.status === 409) {
        await onChanged();
      }
      onError(failure);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border p-4">
      <p className="min-w-0 max-w-xl text-sm leading-6 text-muted-foreground">
        {sourceDriftDescription(binding.status, "captured")
          ?? "Versions of this artifact are captured from a file on this machine. Shared links and comments read the captured version."}
      </p>
      {canManage
        ? (
          <Button
            disabled={pending || !readable}
            onClick={() => void capture()}
            size="xs"
            type="button"
            variant="outline"
          >
            {pending ? "Capturing…" : "Capture now"}
          </Button>
        )
        : null}
    </div>
  );
}

function TagDialog({
  details,
  onChanged,
  onError,
}: {
  readonly details: ArtifactDetails;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
}) {
  const [tags, setTags] = useState(details.artifact.tags.join(", "));
  const [pending, setPending] = useState(false);

  const save = async () => {
    setPending(true);
    try {
      await api.changeTags(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        tags.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
        crypto.randomUUID(),
      );
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Tag update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog>
      <DialogTrigger render={<Button className="w-full" type="button" variant="outline" />}>
        Edit tags
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace tags</DialogTitle>
          <DialogDescription>
            Enter the complete tag set, separated by commas. Artifact Server normalizes,
            deduplicates, and sorts up to 20 tags.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="artifact-tags">Tags</Label>
          <Input
            id="artifact-tags"
            onChange={(event) => setTags(event.currentTarget.value)}
            placeholder="prototype, approved"
            value={tags}
          />
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => void save()} type="button">
            {pending ? "Saving…" : "Replace tags"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({
  details,
  onChanged,
  onError,
}: {
  readonly details: ArtifactDetails;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
}) {
  const [pending, setPending] = useState(false);
  const makingPublic = details.artifact.accessSetting === "account_required";
  const nextAccess = makingPublic ? "public_link" : "account_required";

  const save = async () => {
    setPending(true);
    try {
      await api.changeAccess(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        nextAccess,
        crypto.randomUUID(),
      );
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Access update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog>
      <DialogTrigger render={<Button className="w-full" type="button" variant="outline" />}>
        {makingPublic ? "Make public" : "Require account"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{makingPublic ? "Make public" : "Require account"}</DialogTitle>
          <DialogDescription>
            {makingPublic
              ? "Anybody who can reach this server and has the link can open the current version. Downloaded or externally cached copies cannot be recalled."
              : "New requests will require an admitted installation account. Copies already downloaded or cached outside Artifact Server cannot be recalled."}
          </DialogDescription>
        </DialogHeader>
        <div className="border p-4 text-sm leading-6">
          A public link does not change a firewall, create a tunnel, or make an unreachable
          server reachable.
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => void save()}
            type="button"
            variant={makingPublic ? "default" : "outline"}
          >
            {pending
              ? "Saving…"
              : makingPublic
                ? "Make public"
                : "Require account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TombstoneDialog({
  details,
  onError,
  projectId,
}: {
  readonly details: ArtifactDetails;
  readonly onError: (error: Error) => void;
  readonly projectId: string;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);

  const tombstone = async () => {
    setPending(true);
    try {
      await api.deleteArtifact(
        projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      window.location.assign(`/projects/${encodeURIComponent(projectId)}/artifacts`);
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Artifact tombstone failed."));
      setPending(false);
    }
  };

  return (
    <Dialog>
      <DialogTrigger
        render={<Button className="mt-3 w-full" type="button" variant="destructive" />}
      >
        Tombstone artifact
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tombstone artifact</DialogTitle>
          <DialogDescription>
            All current and exact-version links will stop working. Committed immutable versions
            remain stored; this is not permanent deletion.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="tombstone-confirmation">
            Type <strong>{details.artifact.name}</strong> to confirm
          </Label>
          <Input
            autoComplete="off"
            id="tombstone-confirmation"
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            value={confirmation}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={pending || confirmation !== details.artifact.name}
            onClick={() => void tombstone()}
            type="button"
            variant="destructive"
          >
            {pending ? "Tombstoning…" : "Tombstone artifact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionHistory({
  artifactId,
  canManage,
  currentVersionId,
  onChanged,
  onError,
  onOpenPrivate,
  openThreadCounts,
  projectId,
  publicCurrent,
  versions,
}: {
  readonly artifactId: string;
  readonly canManage: boolean;
  readonly currentVersionId: string;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
  readonly onOpenPrivate: (versionId?: string) => Promise<void>;
  readonly openThreadCounts: ReadonlyMap<string, number>;
  readonly projectId: string;
  readonly publicCurrent: boolean;
  readonly versions: readonly VersionListItem[];
}) {
  if (versions.length === 0) {
    return (
      <StatePanel
        description="This artifact has no saved versions."
        title="No versions"
      />
    );
  }
  return (
    <div className="grid border">
      {versions.map(({ links, version }) => (
        <VersionCard
          artifactId={artifactId}
          canManage={canManage}
          currentVersionId={currentVersionId}
          key={version.id}
          link={links.version}
          onChanged={onChanged}
          onError={onError}
          onOpenPrivate={onOpenPrivate}
          openThreadCount={openThreadCounts.get(version.id) ?? 0}
          projectId={projectId}
          publicCurrent={publicCurrent}
          version={version}
        />
      ))}
    </div>
  );
}

function VersionCard({
  artifactId,
  canManage,
  currentVersionId,
  link,
  onChanged,
  onError,
  onOpenPrivate,
  openThreadCount,
  projectId,
  publicCurrent,
  version,
}: {
  readonly artifactId: string;
  readonly canManage: boolean;
  readonly currentVersionId: string;
  readonly link: string;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
  readonly onOpenPrivate: (versionId?: string) => Promise<void>;
  readonly openThreadCount: number;
  readonly projectId: string;
  readonly publicCurrent: boolean;
  readonly version: Version;
}) {
  const [manifest, setManifest] = useState<ArtifactVersion | null>(null);
  const [pending, setPending] = useState(false);
  const current = version.id === currentVersionId;
  // Only an HTML entry can be annotated in place; other media comment on the
  // whole version from this tab.
  const reviewable = /\.x?html?$/iu.test(version.entryPath);
  const reviewHref = `/projects/${encodeURIComponent(projectId)}/artifacts/${
    encodeURIComponent(artifactId)
  }/versions/${encodeURIComponent(version.id)}/review`;

  const inspect = async () => {
    setPending(true);
    try {
      setManifest(await api.version(projectId, artifactId, version.id));
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Manifest loading failed."));
    } finally {
      setPending(false);
    }
  };

  const restore = async () => {
    setPending(true);
    try {
      await api.restore(
        projectId,
        artifactId,
        currentVersionId,
        version.id,
        crypto.randomUUID(),
      );
      await onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Version restore failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="border-b p-5 last:border-b-0">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-heading text-lg font-semibold">Version {version.number}</h3>
            {current ? <StatusBadge tone="primary">Current</StatusBadge> : null}
            {openThreadCount === 0
              ? null
              : (
                <StatusBadge>
                  {openThreadCount === 1
                    ? "1 open comment"
                    : `${openThreadCount} open comments`}
                </StatusBadge>
              )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved {formatTimestamp(version.createdAt)} by {version.publisherPrincipalId}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {publicCurrent && current
            ? (
              <Button
                render={<a href={link} rel="noreferrer" target="_blank" />}
                size="xs"
                variant="outline"
              >
                Open version
              </Button>
            )
            : (
              <Button
                disabled={pending}
                onClick={() => void onOpenPrivate(version.id)}
                size="xs"
                type="button"
                variant="outline"
              >
                Open version
              </Button>
            )}
          {reviewable
            ? (
              <Button
                render={<a href={reviewHref} />}
                size="xs"
                variant="outline"
              >
                Review
              </Button>
            )
            : null}
          <Button
            disabled={pending}
            onClick={() => void inspect()}
            size="xs"
            type="button"
            variant="ghost"
          >
            Inspect manifest
          </Button>
          {!canManage || current
            ? null
            : (
              <Dialog>
                <DialogTrigger render={<Button size="xs" type="button" variant="ghost" />}>
                  Restore version
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Restore version {version.number}</DialogTitle>
                    <DialogDescription>
                      Version {version.number} will become current instead of the current saved
                      version. No immutable version is edited or duplicated.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      disabled={pending}
                      onClick={() => void restore()}
                      type="button"
                    >
                      {pending ? "Restoring…" : `Restore version ${version.number}`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
        </div>
      </div>
      {manifest === null ? null : <ManifestDetails saved={manifest} />}
    </article>
  );
}

function ManifestDetails({ saved }: { readonly saved: ArtifactVersion }) {
  return (
    <div className="mt-5 overflow-hidden border">
      <div className="border-b bg-muted/50 px-4 py-3">
        <p className="font-mono text-xs break-all">{saved.manifest.digest}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-2xl text-left text-sm">
          <thead className="border-b text-xs tracking-widest text-muted-foreground uppercase">
            <tr>
              <th className="px-4 py-3 font-semibold">Path</th>
              <th className="px-4 py-3 font-semibold">Type</th>
              <th className="px-4 py-3 font-semibold">Size</th>
              <th className="px-4 py-3 font-semibold">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {saved.manifest.entries.map((entry) => (
              <tr className="border-b last:border-b-0" key={entry.path}>
                <td className="px-4 py-3 font-mono text-xs">{entry.path}</td>
                <td className="px-4 py-3">{entry.mediaType}</td>
                <td className="px-4 py-3 whitespace-nowrap">{formatBytes(entry.size)}</td>
                <td className="max-w-64 px-4 py-3 font-mono text-xs break-all">{entry.sha256}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComparisonPanel({
  artifactId,
  opening,
  onError,
  onOpenVersion,
  projectId,
  versions,
}: {
  readonly artifactId: string;
  readonly opening: boolean;
  readonly onError: (error: Error) => void;
  readonly onOpenVersion: (
    versionId: string,
    destinationPath: string,
  ) => Promise<void>;
  readonly projectId: string;
  readonly versions: readonly VersionListItem[];
}) {
  const newest = versions[0]?.version.id ?? "";
  const oldest = versions.at(-1)?.version.id ?? "";
  const [fromVersionId, setFromVersionId] = useState(oldest);
  const [toVersionId, setToVersionId] = useState(newest);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [pending, setPending] = useState(false);

  if (versions.length < 2) {
    return (
      <StatePanel
        description="Publish another immutable version before comparing changes."
        title="One saved version"
      />
    );
  }

  const compare = async () => {
    setPending(true);
    try {
      setComparison(await api.comparison(
        projectId,
        artifactId,
        fromVersionId,
        toVersionId,
      ));
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error("Comparison failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 border p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <VersionSelect
          id="compare-from"
          label="From version"
          onChange={setFromVersionId}
          value={fromVersionId}
          versions={versions}
        />
        <VersionSelect
          id="compare-to"
          label="To version"
          onChange={setToVersionId}
          value={toVersionId}
          versions={versions}
        />
        <Button
          disabled={pending || fromVersionId === toVersionId}
          onClick={() => void compare()}
          type="button"
        >
          {pending ? "Comparing…" : "Compare"}
        </Button>
      </div>
      {comparison === null
        ? null
        : (
          <ComparisonResult
            comparison={comparison}
            opening={opening}
            onOpenVersion={onOpenVersion}
          />
        )}
    </div>
  );
}

function VersionSelect({
  id,
  label,
  onChange,
  value,
  versions,
}: {
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
  readonly versions: readonly VersionListItem[];
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        className="w-full"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {versions.map(({ version }) => (
          <NativeSelectOption key={version.id} value={version.id}>
            Version {version.number} · {formatTimestamp(version.createdAt)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function ComparisonResult({
  comparison,
  opening,
  onOpenVersion,
}: {
  readonly comparison: ArtifactComparison;
  readonly opening: boolean;
  readonly onOpenVersion: (
    versionId: string,
    destinationPath: string,
  ) => Promise<void>;
}) {
  const noChanges = comparison.added.length === 0
    && comparison.removed.length === 0
    && comparison.renamed.length === 0
    && comparison.changed.length === 0;
  if (noChanges) {
    return (
      <StatePanel
        description={`${comparison.unchangedCount} files have the same path and fingerprint.`}
        title="No file changes"
      />
    );
  }
  return (
    <div className="grid gap-6">
      <div className="grid border sm:grid-cols-5">
        {[
          ["Added", comparison.added.length],
          ["Removed", comparison.removed.length],
          ["Changed", comparison.changed.length],
          ["Renamed", comparison.renamed.length],
          ["Unchanged", comparison.unchangedCount],
        ].map(([label, count]) => (
          <div className="border-b p-4 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0" key={label}>
            <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{label}</p>
            <p className="mt-1 font-heading text-2xl font-semibold">{count}</p>
          </div>
        ))}
      </div>
      <ChangeGroup entries={comparison.added.map((entry) => entry.path)} title="Added" />
      <ChangeGroup entries={comparison.removed.map((entry) => entry.path)} title="Removed" />
      <ChangeGroup
        entries={comparison.renamed.map((rename) => `${rename.from.path} → ${rename.to.path}`)}
        title="Renamed"
      />
      {comparison.changed.length === 0
        ? null
        : (
          <section className="border">
            <h3 className="border-b px-4 py-3 font-heading font-semibold">Changed</h3>
            {comparison.changed.map((change) => (
              <div className="border-b p-4 last:border-b-0" key={change.after.path}>
                <p className="font-mono text-xs font-semibold">{change.after.path}</p>
                {change.detail.kind === "binary"
                  ? (
                    <div className="mt-3 text-sm text-muted-foreground">
                      <p>
                        Binary metadata only: {formatBytes(change.before.size)} →{" "}
                        {formatBytes(change.after.size)}
                      </p>
                      <div className="mt-2 flex gap-3">
                        <Button
                          disabled={opening}
                          onClick={() => void onOpenVersion(
                            comparison.from.id,
                            change.before.path,
                          )}
                          size="xs"
                          type="button"
                          variant="link"
                        >
                          Open before
                        </Button>
                        <Button
                          disabled={opening}
                          onClick={() => void onOpenVersion(
                            comparison.to.id,
                            change.after.path,
                          )}
                          size="xs"
                          type="button"
                          variant="link"
                        >
                          Open after
                        </Button>
                      </div>
                    </div>
                  )
                  : change.detail.change === null
                    ? <p className="mt-2 text-sm text-muted-foreground">Text line counts changed.</p>
                    : (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <pre className="overflow-x-auto border border-destructive/20 bg-destructive/5 p-3 text-xs">
                          {change.detail.change.before.join("\n")}
                        </pre>
                        <pre className="overflow-x-auto border border-primary/20 bg-primary/5 p-3 text-xs">
                          {change.detail.change.after.join("\n")}
                        </pre>
                      </div>
                    )}
              </div>
            ))}
          </section>
        )}
    </div>
  );
}

function ChangeGroup({
  entries,
  title,
}: {
  readonly entries: readonly string[];
  readonly title: string;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="border">
      <h3 className="border-b px-4 py-3 font-heading font-semibold">{title}</h3>
      <ul className="divide-y">
        {entries.map((entry) => (
          <li className="px-4 py-3 font-mono text-xs" key={entry}>{entry}</li>
        ))}
      </ul>
    </section>
  );
}

function ActionHistory({
  actions,
  loadingMore,
  nextCursor,
  onLoadMore,
}: {
  readonly actions: readonly ArtifactAction[];
  readonly loadingMore: boolean;
  readonly nextCursor: string | null;
  readonly onLoadMore: () => Promise<void>;
}) {
  if (actions.length === 0) {
    return (
      <StatePanel
        description="No attributed artifact mutations are available."
        title="No action history"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ol className="border">
        {actions.map((action) => (
          <li className="grid gap-2 border-b p-4 last:border-b-0 sm:grid-cols-[12rem_1fr_auto]" key={action.id}>
            <span className="font-heading text-sm font-semibold">{actionLabel(action.action)}</span>
            <span className="font-mono text-xs break-all text-muted-foreground">
              {action.principalId}
              {action.authorizedByPrincipalId === null
                ? null
                : `, authorized by ${action.authorizedByPrincipalId}`}
            </span>
            <time className="text-xs whitespace-nowrap text-muted-foreground">
              {formatTimestamp(action.createdAt)}
            </time>
          </li>
        ))}
      </ol>
      {nextCursor === null
        ? null
        : (
          <div>
            <Button
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
              type="button"
              variant="outline"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
    </div>
  );
}
