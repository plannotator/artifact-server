import { useEffect, useState } from "react";

import {
  api,
  type ArtifactAction,
  type ArtifactComparison,
  type ArtifactDetails,
  type ArtifactVersion,
  type Project,
  type Version,
} from "@/api/client";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  accessSettingLabel,
  actionLabel,
  formatBytes,
  formatTimestamp,
} from "@/lib/presentation";

interface VersionListItem {
  readonly links: { readonly version: string };
  readonly version: Version;
}

/** Complete artifact metadata, history, comparison, mutation, and tombstone surface. */
export function ArtifactDetailScreen({
  artifactId,
  canManage,
  project,
}: {
  readonly artifactId: string;
  readonly canManage: boolean;
  readonly project: Project;
}) {
  const [details, setDetails] = useState<ArtifactDetails | null>(null);
  const [versions, setVersions] = useState<readonly VersionListItem[]>([]);
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedDetails, loadedVersions, loadedActions] = await Promise.all([
        api.artifact(project.id, artifactId),
        api.versions(project.id, artifactId),
        api.actions(project.id, artifactId, null),
      ]);
      setDetails(loadedDetails);
      setVersions(loadedVersions);
      setActions(loadedActions.actions);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Artifact loading failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [artifactId, project.id]);

  const openPrivateVersion = async (versionId?: string) => {
    const popup = window.open("about:blank", "_blank");
    setOpening(true);
    setError(null);
    try {
      const issued = await api.contentSession(project.id, artifactId, versionId);
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
          <TabsTrigger value="actions">Action history</TabsTrigger>
        </TabsList>

        <TabsContent className="pt-6" value="overview">
          <Overview
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
            onError={setError}
            projectId={project.id}
            versions={versions}
          />
        </TabsContent>
        <TabsContent className="pt-6" value="actions">
          <ActionHistory actions={actions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({
  canManage,
  details,
  onChanged,
  onError,
  project,
}: {
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
        </dl>
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
  readonly projectId: string;
  readonly publicCurrent: boolean;
  readonly version: Version;
}) {
  const [manifest, setManifest] = useState<ArtifactVersion | null>(null);
  const [pending, setPending] = useState(false);
  const current = version.id === currentVersionId;

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
  onError,
  projectId,
  versions,
}: {
  readonly artifactId: string;
  readonly onError: (error: Error) => void;
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
      {comparison === null ? null : <ComparisonResult comparison={comparison} />}
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
      <select
        className="h-10 w-full rounded-none border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {versions.map(({ version }) => (
          <option key={version.id} value={version.id}>
            Version {version.number} · {formatTimestamp(version.createdAt)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ComparisonResult({ comparison }: { readonly comparison: ArtifactComparison }) {
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
                        <a className="underline underline-offset-4" href={change.links.before} rel="noreferrer" target="_blank">
                          Open before
                        </a>
                        <a className="underline underline-offset-4" href={change.links.after} rel="noreferrer" target="_blank">
                          Open after
                        </a>
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

function ActionHistory({ actions }: { readonly actions: readonly ArtifactAction[] }) {
  if (actions.length === 0) {
    return (
      <StatePanel
        description="No attributed artifact mutations are available."
        title="No action history"
      />
    );
  }
  return (
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
  );
}
