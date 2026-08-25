import { useEffect, useState } from "react";

import {
  api,
  type DeploymentCapabilities,
  type Project,
  type ProjectGitHistoryEstimate,
  type ProjectGitHistorySetting,
} from "@/api/client";
import { ErrorPanel, PageHeader, StatePanel, StatusBadge } from "@/components/product";
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
import { formatTimestamp } from "@/lib/presentation";

/** Project list and complete project lifecycle controls. */
export function ProjectsScreen({
  canManage,
  gitHistory,
  onProjectsChanged,
  projects,
}: {
  readonly canManage: boolean;
  readonly gitHistory: DeploymentCapabilities["gitHistory"];
  readonly onProjectsChanged: () => Promise<void>;
  readonly projects: readonly Project[];
}) {
  const [error, setError] = useState<Error | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const createProject = async () => {
    setCreating(true);
    setError(null);
    try {
      await api.createProject(name);
      setName("");
      await onProjectsChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project creation failed."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={canManage
          ? (
            <Dialog>
              <DialogTrigger render={<Button type="button" />}>
                New project
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New project</DialogTitle>
                  <DialogDescription>
                    Projects organize artifacts inside this installation. Every admitted member can
                    manage every project.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <Label htmlFor="new-project-name">Project name</Label>
                  <Input
                    id="new-project-name"
                    maxLength={120}
                    onChange={(event) => setName(event.currentTarget.value)}
                    value={name}
                  />
                </div>
                <DialogFooter>
                  <Button
                    disabled={creating || name.trim() === ""}
                    onClick={() => void createProject()}
                    type="button"
                  >
                    {creating ? "Creating…" : "Create project"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
          : undefined}
        description="One installation contains one or more projects. Project names are labels; stable IDs select the project."
        eyebrow="Installation"
        title="Projects"
      />

      {error === null ? null : <ErrorPanel error={error} />}
      {projects.length === 0
        ? (
          <StatePanel
            description="No projects are available in this installation."
            title="No projects"
          />
        )
        : (
          <div className="grid border sm:grid-cols-2">
            {projects.map((project) => (
              <ProjectCard
                canManage={canManage}
                gitHistory={gitHistory}
                key={project.id}
                onChanged={onProjectsChanged}
                project={project}
              />
            ))}
          </div>
        )}
    </div>
  );
}

function ProjectCard({
  canManage,
  gitHistory,
  onChanged,
  project,
}: {
  readonly canManage: boolean;
  readonly gitHistory: DeploymentCapabilities["gitHistory"];
  readonly onChanged: () => Promise<void>;
  readonly project: Project;
}) {
  const [error, setError] = useState<Error | null>(null);
  const [gitHistorySetting, setGitHistorySetting] =
    useState<ProjectGitHistorySetting | null>(null);
  const [gitHistoryEstimate, setGitHistoryEstimate] =
    useState<ProjectGitHistoryEstimate | null>(null);
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const setting = await api.projectGitHistory(project.id);
        if (current) setGitHistorySetting(setting);
      } catch (caught) {
        if (current) {
          setError(caught instanceof Error
            ? caught
            : new Error("Git history status could not be loaded."));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [project.id]);

  const rename = async () => {
    setPending(true);
    setError(null);
    try {
      await api.renameProject(project.id, name);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project rename failed."));
    } finally {
      setPending(false);
    }
  };

  const changeArchiveState = async () => {
    setPending(true);
    setError(null);
    try {
      if (project.archivedAt === null) {
        await api.archiveProject(project.id);
      } else {
        await api.unarchiveProject(project.id);
      }
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project update failed."));
    } finally {
      setPending(false);
    }
  };

  const prepareGitHistoryEnable = async () => {
    setPending(true);
    setError(null);
    try {
      setGitHistoryEstimate(await api.estimateProjectGitHistory(project.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history estimate failed."));
    } finally {
      setPending(false);
    }
  };

  const changeGitHistory = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    try {
      setGitHistorySetting(await api.setProjectGitHistory(project.id, enabled));
      setGitHistoryEstimate(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="flex min-w-0 flex-col gap-5 border-b p-5 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold break-words">{project.name}</h2>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{project.id}</p>
        </div>
        <StatusBadge tone={project.archivedAt === null ? "primary" : "neutral"}>
          {project.archivedAt === null ? "Active" : "Archived"}
        </StatusBadge>
      </div>

      <p className="text-sm text-muted-foreground">
        Created {formatTimestamp(project.createdAt)}
      </p>
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">{error.message}</p>
      )}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Git history</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {gitHistory.provider === null
                ? "This deployment has no Git history provider."
                : gitHistory.providerState === "available"
                ? "Cloudflare Artifacts stores a derived repository for each artifact in this project."
                : `Cloudflare Artifacts is ${gitHistory.providerState.replaceAll("-", " ")}.`}
            </p>
          </div>
          <StatusBadge tone={gitHistorySetting?.enabled === true ? "primary" : "neutral"}>
            {gitHistorySetting === null
              ? "Loading"
              : gitHistorySetting.state.replaceAll("-", " ")}
          </StatusBadge>
        </div>
        {canManage && gitHistory.provider !== null && gitHistorySetting !== null
          ? (
            <div className="mt-3 flex justify-end">
              <Button
                disabled={pending || (!gitHistorySetting.enabled && gitHistory.providerState !== "available")}
                onClick={() => void (gitHistorySetting.enabled
                  ? changeGitHistory(false)
                  : prepareGitHistoryEnable())}
                size="sm"
                type="button"
                variant="outline"
              >
                {pending
                  ? "Working…"
                  : gitHistorySetting.enabled ? "Disable Git history" : "Enable Git history"}
              </Button>
            </div>
          )
          : null}
      </div>
      <Dialog
        onOpenChange={(open) => {
          if (!open) setGitHistoryEstimate(null);
        }}
        open={gitHistoryEstimate !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable Git history?</DialogTitle>
            <DialogDescription>
              Existing and future versions in this project will be copied to derived Cloudflare Artifacts repositories.
            </DialogDescription>
          </DialogHeader>
          {gitHistoryEstimate === null ? null : (
            <dl className="grid grid-cols-2 gap-3 border-y py-4 text-sm">
              <dt className="text-muted-foreground">Repositories</dt>
              <dd>{gitHistoryEstimate.repositories}</dd>
              <dt className="text-muted-foreground">Versions</dt>
              <dd>{gitHistoryEstimate.versions}</dd>
              <dt className="text-muted-foreground">Estimated copy</dt>
              <dd>{formatBytes(gitHistoryEstimate.estimatedCopiedBytes)}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button
              onClick={() => setGitHistoryEstimate(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => void changeGitHistory(true)}
              type="button"
            >
              {pending ? "Enabling…" : "Enable Git history"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button
          render={<a href={`/projects/${encodeURIComponent(project.id)}/artifacts`} />}
          size="sm"
        >
          View artifacts
        </Button>
        {canManage
          ? (
            <Dialog>
              <DialogTrigger render={<Button size="sm" type="button" variant="outline" />}>
                Rename
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Rename project</DialogTitle>
                  <DialogDescription>
                    Renaming changes only the label. The project ID and its artifacts stay the same.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <Label htmlFor={`rename-${project.id}`}>Project name</Label>
                  <Input
                    id={`rename-${project.id}`}
                    maxLength={120}
                    onChange={(event) => setName(event.currentTarget.value)}
                    value={name}
                  />
                </div>
                <DialogFooter>
                  <Button
                    disabled={pending || name.trim() === ""}
                    onClick={() => void rename()}
                    type="button"
                  >
                    {pending ? "Saving…" : "Save name"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
          : null}
        {canManage
          ? (
            <Dialog>
              <DialogTrigger
                render={<Button size="sm" type="button" variant="ghost" />}
              >
                {project.archivedAt === null ? "Archive" : "Unarchive"}
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {project.archivedAt === null ? "Archive project" : "Unarchive project"}
                  </DialogTitle>
                  <DialogDescription>
                    {project.archivedAt === null
                      ? "Archiving blocks new artifacts and versions. Existing artifacts, immutable versions, and links remain available."
                      : "Unarchiving allows new artifacts and versions again. Existing artifact identities do not change."}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    disabled={pending}
                    onClick={() => void changeArchiveState()}
                    type="button"
                    variant={project.archivedAt === null ? "destructive" : "default"}
                  >
                    {pending
                      ? "Saving…"
                      : project.archivedAt === null
                        ? "Archive project"
                        : "Unarchive project"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
          : null}
      </div>
    </article>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}
