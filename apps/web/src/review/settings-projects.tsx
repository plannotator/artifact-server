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
import {settingsText} from "@/i18n/messages/settings";
import {formatBytes, formatTimestamp, displayError} from "@/lib/presentation";
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
      setError(caught instanceof Error ? caught : new Error(settingsText.projects.createFailed));
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
            <DialogTrigger render={<Button type="button" />}>{settingsText.projects.newProject}</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{settingsText.projects.newProject}</DialogTitle>
                <DialogDescription>
                  {settingsText.projects.createDescription}
                </DialogDescription>
              </DialogHeader>
              {error === null ? null : (
                <p className="text-sm text-destructive" role="alert">{displayError(error)}</p>
              )}
              <div className="grid gap-2">
                <Label className="sr-only" htmlFor="settings-project-name">{settingsText.projects.projectName}</Label>
                <Input
                  autoFocus
                  id="settings-project-name"
                  maxLength={120}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder={settingsText.projects.projectName}
                  value={name}
                />
              </div>
              <DialogFooter>
                <Button disabled={pending} onClick={() => setCreateOpen(false)} type="button" variant="outline">
                  {settingsText.projects.cancel}
                </Button>
                <Button disabled={pending || name.trim() === ""} onClick={() => void createProject()} type="button">
                  {pending ? settingsText.projects.creating : settingsText.projects.createProject}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : undefined}
        description={settingsText.projects.listDescription}
        title={settingsText.projects.title}
      />

      {orderedProjects.length === 0 ? (
        <StatePanel
          description={settingsText.projects.emptyDescription}
          title={settingsText.projects.emptyTitle}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="as-stack-table w-full min-w-2xl text-left text-sm">
            <thead className="border-b text-sm text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{settingsText.projects.columnProject}</th>
                <th className="px-4 py-3 font-medium">{settingsText.projects.columnState}</th>
                <th className="px-4 py-3 font-medium">{settingsText.projects.columnCreated}</th>
                <th className="px-4 py-3 text-right font-medium">{settingsText.projects.columnActions}</th>
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
                      {project.archivedAt === null ? settingsText.projects.active : settingsText.projects.archived}
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
                        {settingsText.projects.openArtifacts}
                      </ButtonLink>
                      <ButtonLink href={projectSettingsHref(project.id)} size="sm" variant="outline">
                        {settingsText.projects.settings}
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
            : new Error(settingsText.projects.gitStatusLoadFailed));
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
            {settingsText.projects.viewProjects}
          </ButtonLink>
        )}
        description={settingsText.projects.notFoundDescription}
        title={settingsText.projects.notFoundTitle}
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
      setError(caught instanceof Error ? caught : new Error(settingsText.projects.renameFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.projects.updateFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.projects.gitEstimateFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.projects.gitUpdateFailed));
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
            {settingsText.projects.openArtifacts}
          </ButtonLink>
        )}
        description={project.archivedAt === null
          ? settingsText.projects.activeDescription
          : settingsText.projects.archivedDescription}
        title={project.name}
      />
      {error === null ? null : <ErrorPanel error={error} />}

      <section className="grid gap-4 rounded-[var(--radius-card)] border bg-card p-5" aria-labelledby="project-identity-heading">
        <div>
          <h2 className="font-heading text-base font-semibold" id="project-identity-heading">{settingsText.projects.identityHeading}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{settingsText.projects.identityHelp}</p>
        </div>
        <div className="grid max-w-xl gap-2">
          <Label htmlFor="settings-rename-project">{settingsText.projects.projectName}</Label>
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
              {pending ? settingsText.projects.saving : settingsText.projects.saveName}
            </Button>
          </div>
        </div>
        <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">{settingsText.projects.projectId}</dt>
          <dd><code className="break-all font-mono text-xs">{project.id}</code></dd>
          <dt className="text-muted-foreground">{settingsText.projects.created}</dt>
          <dd>{formatTimestamp(project.createdAt)}</dd>
        </dl>
      </section>

      {gitHistory.provider === null ? null : (
        <section className="grid gap-4 rounded-[var(--radius-card)] border bg-card p-5" aria-labelledby="project-git-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-base font-semibold" id="project-git-heading">{settingsText.projects.gitHeading}</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {settingsText.projects.gitDescription}
              </p>
            </div>
            <StatusBadge tone={gitSetting?.enabled === true ? "primary" : "neutral"}>
              {gitSetting === null ? settingsText.projects.loading : settingsText.projects.gitState[gitSetting.state]}
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
                ? settingsText.projects.working
                : gitSetting?.enabled === true ? settingsText.projects.disableGitHistory : settingsText.projects.enableGitHistory}
            </Button>
            {gitHistory.providerState === "available" ? null : (
              <p className="mt-2 text-sm text-muted-foreground">
                {settingsText.projects.providerNotice(settingsText.projects.providerState[gitHistory.providerState])}
              </p>
            )}
          </div>
        </section>
      )}

      <section className="grid gap-4 rounded-[var(--radius-card)] border border-destructive/40 bg-card p-5" aria-labelledby="project-lifecycle-heading">
        <div>
          <h2 className="font-heading text-base font-semibold" id="project-lifecycle-heading">{settingsText.projects.lifecycleHeading}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {project.archivedAt === null
              ? settingsText.projects.archiveHelp
              : settingsText.projects.unarchiveHelp}
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
              {project.archivedAt === null ? settingsText.projects.archiveProject : settingsText.projects.unarchiveProject}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{project.archivedAt === null ? settingsText.projects.archiveConfirmTitle : settingsText.projects.unarchiveConfirmTitle}</DialogTitle>
                <DialogDescription>
                  {project.archivedAt === null
                    ? settingsText.projects.archiveConfirmDescription
                    : settingsText.projects.unarchiveConfirmDescription}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button disabled={pending} onClick={() => void changeArchiveState()} type="button" variant={project.archivedAt === null ? "destructive" : "default"}>
                  {pending ? settingsText.projects.working : project.archivedAt === null ? settingsText.projects.archiveProject : settingsText.projects.unarchiveProject}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </section>

      <Dialog onOpenChange={(open) => { if (!open) setGitEstimate(null); }} open={gitEstimate !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{settingsText.projects.enableGitTitle}</DialogTitle>
            <DialogDescription>
              {settingsText.projects.enableGitDescription}
            </DialogDescription>
          </DialogHeader>
          {gitEstimate === null ? null : (
            <dl className="grid grid-cols-2 gap-3 border-y py-4 text-sm">
              <dt className="text-muted-foreground">{settingsText.projects.repositories}</dt>
              <dd>{gitEstimate.repositories}</dd>
              <dt className="text-muted-foreground">{settingsText.projects.versions}</dt>
              <dd>{gitEstimate.versions}</dd>
              <dt className="text-muted-foreground">{settingsText.projects.estimatedCopy}</dt>
              <dd>{formatBytes(gitEstimate.estimatedCopiedBytes)}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button disabled={pending} onClick={() => setGitEstimate(null)} type="button" variant="outline">{settingsText.projects.cancel}</Button>
            <Button disabled={pending} onClick={() => void changeGitHistory(true)} type="button">
              {pending ? settingsText.projects.enabling : settingsText.projects.enableGitHistory}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
