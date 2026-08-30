import {useEffect, useState} from "react";

import {
  api,
  type DeploymentCapabilities,
  type Project,
  type ProjectGitHistoryEstimate,
  type ProjectGitHistorySetting,
} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {formatBytes, formatTimestamp} from "@/lib/presentation";
import {projectSettingsHref} from "./review-routes.ts";

interface ProjectSettingsSharedProps {
  readonly canManage: boolean;
  readonly gitHistory: DeploymentCapabilities["gitHistory"];
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
}

/** List every project and provide the canonical project creation surface. */
export function SettingsProjects({
  canManage,
  onProjectsChanged,
  projects,
}: ProjectSettingsSharedProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const orderedProjects = [...projects].toSorted((left, right) => {
    if (left.archivedAt === null && right.archivedAt !== null) return -1;
    if (left.archivedAt !== null && right.archivedAt === null) return 1;
    return left.name.localeCompare(right.name);
  });

  const createProject = async (): Promise<void> => {
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      const created = await api.createProject(name.trim());
      await onProjectsChanged();
      window.location.assign(projectSettingsHref(created.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project creation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={canManage ? (
          <Dialog
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open && !pending) {
                setError(null);
                setName("");
              }
            }}
            open={createOpen}
          >
            <DialogTrigger render={<Button type="button" />}>New project</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New project</DialogTitle>
                <DialogDescription>
                  Create a place for related artifacts. Every installation member can use it.
                </DialogDescription>
              </DialogHeader>
              {error === null ? null : (
                <p className="text-sm text-destructive" role="alert">{error.message}</p>
              )}
              <div className="grid gap-2">
                <Label className="sr-only" htmlFor="settings-project-name">Project name</Label>
                <Input
                  autoFocus
                  id="settings-project-name"
                  maxLength={120}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="Project name"
                  value={name}
                />
              </div>
              <DialogFooter>
                <Button disabled={pending} onClick={() => setCreateOpen(false)} type="button" variant="outline">
                  Cancel
                </Button>
                <Button disabled={pending || name.trim() === ""} onClick={() => void createProject()} type="button">
                  {pending ? "Creating…" : "Create project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : undefined}
        description="Create projects, open their artifacts, or manage their lifecycle."
        title="Projects"
      />

      {orderedProjects.length === 0 ? (
        <StatePanel
          description="Create a project to begin organizing artifacts in this installation."
          title="No projects"
        />
      ) : (
        <div className="overflow-x-auto border">
          <table className="w-full min-w-2xl text-left text-sm">
            <thead className="border-b bg-muted/50 text-xs tracking-widest text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3 font-semibold">Project</th>
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orderedProjects.map((project) => (
                <tr className="border-b last:border-b-0" key={project.id}>
                  <td className="px-4 py-4">
                    <a className="font-heading font-semibold hover:underline" href={projectSettingsHref(project.id)}>
                      {project.name}
                    </a>
                    <code className="mt-1 block max-w-80 truncate font-mono text-xs text-muted-foreground" title={project.id}>
                      {project.id}
                    </code>
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge tone={project.archivedAt === null ? "primary" : "neutral"}>
                      {project.archivedAt === null ? "Active" : "Archived"}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-muted-foreground">
                    {formatTimestamp(project.createdAt)}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-end gap-2">
                      <ButtonLink
                        href={`/review?project=${encodeURIComponent(project.id)}`}
                        size="sm"
                        variant="outline"
                      >
                        Open artifacts
                      </ButtonLink>
                      <ButtonLink href={projectSettingsHref(project.id)} size="sm">
                        Settings
                      </ButtonLink>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Manage one project's identity, lifecycle, and optional Git history. */
export function SettingsProject({
  canManage,
  gitHistory,
  onProjectsChanged,
  projectId,
  projects,
}: ProjectSettingsSharedProps & {readonly projectId: string}) {
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const [name, setName] = useState(project?.name ?? "");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [gitSetting, setGitSetting] = useState<ProjectGitHistorySetting | null>(null);
  const [gitEstimate, setGitEstimate] = useState<ProjectGitHistoryEstimate | null>(null);

  useEffect(() => {
    setName(project?.name ?? "");
  }, [project?.name]);

  useEffect(() => {
    if (project === null || gitHistory.provider === null) {
      setGitSetting(null);
      return undefined;
    }
    let current = true;
    void (async (): Promise<void> => {
      try {
        const setting = await api.projectGitHistory(project.id);
        if (current) setGitSetting(setting);
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
  }, [gitHistory.provider, project]);

  if (project === null) {
    return (
      <StatePanel
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            View projects
          </ButtonLink>
        )}
        description="The project named by this settings URL is unavailable."
        title="Project not found"
      />
    );
  }

  const rename = async (): Promise<void> => {
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      await api.renameProject(project.id, name.trim());
      await onProjectsChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project rename failed."));
    } finally {
      setPending(false);
    }
  };
  const changeArchiveState = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      if (project.archivedAt === null) {
        await api.archiveProject(project.id);
      } else {
        await api.unarchiveProject(project.id);
      }
      await onProjectsChanged();
      setArchiveOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project update failed."));
    } finally {
      setPending(false);
    }
  };
  const estimateGitHistory = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setGitEstimate(await api.estimateProjectGitHistory(project.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history estimate failed."));
    } finally {
      setPending(false);
    }
  };
  const changeGitHistory = async (enabled: boolean): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setGitSetting(await api.setProjectGitHistory(project.id, enabled));
      setGitEstimate(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Git history update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <ButtonLink
            href={`/review?project=${encodeURIComponent(project.id)}`}
            variant="outline"
          >
            Open artifacts
          </ButtonLink>
        )}
        description={project.archivedAt === null
          ? "Manage this project's name, lifecycle, and optional history."
          : "This project is archived. Existing artifacts and immutable versions remain readable."}
        title={project.name}
      />
      {error === null ? null : <ErrorPanel error={error} />}

      <section className="grid gap-5 border p-5 sm:p-6" aria-labelledby="project-identity-heading">
        <div>
          <h2 className="font-heading text-lg font-semibold" id="project-identity-heading">Project identity</h2>
          <p className="mt-1 text-sm text-muted-foreground">Renaming changes the label, not the stable project ID.</p>
        </div>
        <div className="grid max-w-xl gap-2">
          <Label htmlFor="settings-rename-project">Project name</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              disabled={!canManage || pending}
              id="settings-rename-project"
              maxLength={120}
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
            <Button
              disabled={!canManage || pending || name.trim() === "" || name.trim() === project.name}
              onClick={() => void rename()}
              type="button"
            >
              {pending ? "Saving…" : "Save name"}
            </Button>
          </div>
        </div>
        <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">Project ID</dt>
          <dd><code className="break-all font-mono text-xs">{project.id}</code></dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatTimestamp(project.createdAt)}</dd>
        </dl>
      </section>

      {gitHistory.provider === null ? null : (
        <section className="grid gap-5 border p-5 sm:p-6" aria-labelledby="project-git-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-lg font-semibold" id="project-git-heading">Git history</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Cloudflare Artifacts keeps a derived Git repository for each artifact. Artifact Server remains the source of truth.
              </p>
            </div>
            <StatusBadge tone={gitSetting?.enabled === true ? "primary" : "neutral"}>
              {gitSetting === null ? "Loading" : gitSetting.state.replaceAll("-", " ")}
            </StatusBadge>
          </div>
          <div>
            <Button
              disabled={!canManage
                || pending
                || gitSetting === null
                || (!gitSetting.enabled && gitHistory.providerState !== "available")}
              onClick={() => void (gitSetting?.enabled === true
                ? changeGitHistory(false)
                : estimateGitHistory())}
              type="button"
              variant="outline"
            >
              {pending
                ? "Working…"
                : gitSetting?.enabled === true ? "Disable Git history" : "Enable Git history"}
            </Button>
            {gitHistory.providerState === "available" ? null : (
              <p className="mt-2 text-sm text-muted-foreground">
                Git history is currently {gitHistory.providerState.replaceAll("-", " ")} for this deployment.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="grid gap-5 border border-destructive/40 p-5 sm:p-6" aria-labelledby="project-lifecycle-heading">
        <div>
          <h2 className="font-heading text-lg font-semibold" id="project-lifecycle-heading">Project lifecycle</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {project.archivedAt === null
              ? "Archiving stops new artifacts and versions. Existing reads, links, and immutable history remain."
              : "Unarchive this project to accept new artifacts and versions again."}
          </p>
        </div>
        {canManage ? (
          <Dialog onOpenChange={setArchiveOpen} open={archiveOpen}>
            <DialogTrigger
              render={(
                <Button
                  className="justify-self-start"
                  type="button"
                  variant={project.archivedAt === null ? "destructive" : "outline"}
                />
              )}
            >
              {project.archivedAt === null ? "Archive project" : "Unarchive project"}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{project.archivedAt === null ? "Archive project?" : "Unarchive project?"}</DialogTitle>
                <DialogDescription>
                  {project.archivedAt === null
                    ? "New publication stops. Saved artifacts, links, and immutable versions remain readable."
                    : "This project will accept new artifacts and versions again."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button disabled={pending} onClick={() => void changeArchiveState()} type="button" variant={project.archivedAt === null ? "destructive" : "default"}>
                  {pending ? "Working…" : project.archivedAt === null ? "Archive project" : "Unarchive project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </section>

      <Dialog onOpenChange={(open) => { if (!open) setGitEstimate(null); }} open={gitEstimate !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable Git history?</DialogTitle>
            <DialogDescription>
              Existing and future versions will be copied to derived Cloudflare Artifacts repositories.
            </DialogDescription>
          </DialogHeader>
          {gitEstimate === null ? null : (
            <dl className="grid grid-cols-2 gap-3 border-y py-4 text-sm">
              <dt className="text-muted-foreground">Repositories</dt>
              <dd>{gitEstimate.repositories}</dd>
              <dt className="text-muted-foreground">Versions</dt>
              <dd>{gitEstimate.versions}</dd>
              <dt className="text-muted-foreground">Estimated copy</dt>
              <dd>{formatBytes(gitEstimate.estimatedCopiedBytes)}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button disabled={pending} onClick={() => setGitEstimate(null)} type="button" variant="outline">Cancel</Button>
            <Button disabled={pending} onClick={() => void changeGitHistory(true)} type="button">
              {pending ? "Enabling…" : "Enable Git history"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
