import {ArrowLeft01Icon, Moon02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useEffect, useMemo, useState} from "react";

import {ApiError, api, type Insights, type InsightWindow, type Project} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel} from "@/components/product";
import {ButtonLink} from "@/components/ui/button";
import {NativeSelect} from "@/components/ui/native-select";
import {Skeleton} from "@/components/ui/skeleton";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {ArtifactMark} from "../review/artifact-mark.tsx";
import {ActivitySection} from "./dashboard-activity.tsx";
import {dashboardWindows} from "./dashboard-format.ts";
import {
  DashboardHeadline,
  OverviewSection,
  ReviewSection,
  StorageSection,
} from "./dashboard-sections.tsx";

type InsightsState =
  | {readonly status: "loading"}
  | {readonly error: Error; readonly status: "failed"}
  | {readonly insights: Insights; readonly status: "ready"};

/** Scope and window, kept in the URL so a refresh or a shared link keeps them. */
interface DashboardSelection {
  readonly projectId: string | null;
  readonly window: InsightWindow;
}

const allProjects = "";

/** Read-only overview of artifacts, review, storage, and activity. */
export function DashboardPage({
  onThemeChange,
  projects,
  theme,
}: {
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly theme: "dawn" | "moon";
}) {
  const [selection, setSelection] = useState<DashboardSelection>(readSelection);
  const [state, setState] = useState<InsightsState>({status: "loading"});
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  useEffect(() => {
    writeSelection(selection);
    let current = true;
    setState({status: "loading"});
    const load = async () => {
      try {
        const insights = await api.insights(selection.projectId, selection.window);
        if (!current) return;
        setNow(Date.parse(insights.generatedAt));
        setState({insights, status: "ready"});
      } catch (caught) {
        if (!current) return;
        setState({
          error: caught instanceof Error ? caught : new Error("The dashboard could not be loaded."),
          status: "failed",
        });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [attempt, selection]);

  return (
    <div className="as-settings">
      <header className="as-settings__header">
        <div className="as-settings__header-inner">
          <a aria-label="Artifact Server" className="as-settings__brand" href="/review">
            <span className="as-settings__brand-mark">
              <ArtifactMark className="as-settings__mark" />
            </span>
            <span className="as-settings__brand-label">Dashboard</span>
          </a>
          <div className="as-settings__header-actions">
            <button
              aria-label={theme === "moon" ? "Use light theme" : "Use dark theme"}
              className="as-icon-button"
              onClick={onThemeChange}
              title={theme === "moon" ? "Use light theme" : "Use dark theme"}
              type="button"
            >
              <HugeiconsIcon icon={theme === "moon" ? Sun03Icon : Moon02Icon} strokeWidth={1.8} />
            </button>
            <ButtonLink href="/review" size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              Back to review
            </ButtonLink>
          </div>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-7xl min-w-0 grid-cols-1 gap-6 px-4 py-8 sm:px-6" id="main-content">
        <PageHeader
          actions={(
            <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
              <NativeSelect
                aria-label="Project"
                onChange={(event) => setSelection((current) => ({
                  ...current,
                  projectId: event.target.value === allProjects ? null : event.target.value,
                }))}
                size="sm"
                value={selection.projectId ?? allProjects}
              >
                <option value={allProjects}>All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </NativeSelect>
              <ToggleGroup
                aria-label="Time window"
                className="w-full sm:w-fit"
                onValueChange={(values) => {
                  const chosen = dashboardWindows.find((option) => values.includes(option.value));
                  if (chosen !== undefined) {
                    setSelection((current) => ({...current, window: chosen.value}));
                  }
                }}
                size="sm"
                spacing={0}
                value={[selection.window]}
                variant="outline"
              >
                {dashboardWindows.map((option) => (
                  <ToggleGroupItem className="flex-1 px-2 sm:flex-none sm:px-3" key={option.value} value={option.value}>
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          description="Artifacts, review progress, storage, and activity at a glance."
          eyebrow="Artifact Server"
          title="Dashboard"
        />
        {state.status === "loading" ? <DashboardSkeleton /> : null}
        {state.status === "failed"
          ? <DashboardFailure error={state.error} onRetry={() => setAttempt((value) => value + 1)} />
          : null}
        {state.status === "ready"
          ? (
            <>
              <DashboardHeadline insights={state.insights} />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <OverviewSection insights={state.insights} now={now} projectNames={projectNames} />
                <ReviewSection insights={state.insights} now={now} />
                <StorageSection insights={state.insights} projectNames={projectNames} />
                <ActivitySection
                  now={now}
                  projectId={selection.projectId}
                  projectNames={projectNames}
                  window={selection.window}
                />
              </div>
            </>
          )
          : null}
      </main>
    </div>
  );
}

function DashboardFailure({
  error,
  onRetry,
}: {
  readonly error: Error;
  readonly onRetry: () => void;
}) {
  if (error instanceof ApiError && error.code === "CAPABILITY_UNAVAILABLE") {
    return (
      <StatePanel
        description="This deployment's storage does not provide dashboard insights. They are available on the local SQLite deployment."
        title="Dashboard unavailable"
      />
    );
  }
  if (error instanceof ApiError && error.code === "PROJECT_NOT_FOUND") {
    return (
      <StatePanel
        action={<ButtonLink href="/review/dashboard" variant="outline">Show all projects</ButtonLink>}
        description="The selected project does not exist in this installation."
        title="Project not found"
      />
    );
  }
  return <ErrorPanel error={error} onRetry={onRetry} />;
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard" className="grid gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {["artifacts", "threads", "stored", "dispatches"].map((key) => (
          <Skeleton className="h-28" key={key} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {["overview", "review", "storage", "activity"].map((key) => (
          <Skeleton className="h-80" key={key} />
        ))}
      </div>
    </div>
  );
}

function readSelection(): DashboardSelection {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("window");
  const chosen = dashboardWindows.find((option) => option.value === requested);
  const projectId = query.get("project");
  return {
    projectId: projectId === null || projectId === "" ? null : projectId,
    window: chosen?.value ?? "30d",
  };
}

function writeSelection(selection: DashboardSelection): void {
  const query = new URLSearchParams();
  if (selection.projectId !== null) query.set("project", selection.projectId);
  if (selection.window !== "30d") query.set("window", selection.window);
  const search = query.size === 0 ? "" : `?${query}`;
  if (window.location.search !== search) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
  }
}
