import {ArrowLeft01Icon, Moon02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useEffect, useMemo, useState} from "react";

import {ApiError, api, type Insights, type InsightWindow, type Project} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel} from "@/components/product";
import {ButtonLink} from "@/components/ui/button";
import {NativeSelect} from "@/components/ui/native-select";
import {Skeleton} from "@/components/ui/skeleton";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {LanguageSwitch} from "@/i18n/language-switch";
import {dashboardText} from "@/i18n/messages/dashboard";
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
const text = dashboardText.page;

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
            <span className="as-settings__brand-label">{text.title}</span>
          </a>
          <div className="as-settings__header-actions">
            <LanguageSwitch />
            <button
              aria-label={theme === "moon" ? text.useLightTheme : text.useDarkTheme}
              className="as-icon-button"
              onClick={onThemeChange}
              title={theme === "moon" ? text.useLightTheme : text.useDarkTheme}
              type="button"
            >
              <HugeiconsIcon icon={theme === "moon" ? Sun03Icon : Moon02Icon} strokeWidth={1.8} />
            </button>
            <ButtonLink href="/review" size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              {text.backToReview}
            </ButtonLink>
          </div>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[72rem] min-w-0 grid-cols-1 gap-6 px-4 pt-6 pb-24 sm:px-6" id="main-content">
        <PageHeader
          actions={(
            <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
              <NativeSelect
                aria-label={text.project}
                onChange={(event) => setSelection((current) => ({
                  ...current,
                  projectId: event.target.value === allProjects ? null : event.target.value,
                }))}
                size="sm"
                value={selection.projectId ?? allProjects}
              >
                <option value={allProjects}>{text.allProjects}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </NativeSelect>
              <ToggleGroup
                aria-label={text.timeWindow}
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
          description={text.description}
          title={text.title}
        />
        {state.status === "loading" ? <DashboardSkeleton /> : null}
        {state.status === "failed"
          ? <DashboardFailure error={state.error} onRetry={() => setAttempt((value) => value + 1)} />
          : null}
        {state.status === "ready"
          ? (
            <>
              {/* The trail leads; readings, one chart and one table follow it. */}
              {/* Two columns that stack on their own, so no panel stretches to
                  a neighbour's height and leaves a dead band. */}
              <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
                <div className="grid min-w-0 gap-6 xl:col-span-8">
                  <ActivitySection
                    now={now}
                    projectId={selection.projectId}
                    projectNames={projectNames}
                    window={selection.window}
                  />
                  <StorageSection insights={state.insights} projectNames={projectNames} />
                </div>
                <div className="grid min-w-0 gap-6 xl:col-span-4">
                  <DashboardHeadline insights={state.insights} />
                  <ReviewSection insights={state.insights} now={now} />
                </div>
                <div className="min-w-0 xl:col-span-12">
                  <OverviewSection insights={state.insights} now={now} projectNames={projectNames} />
                </div>
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
        description={text.unavailableDescription}
        title={text.unavailableTitle}
      />
    );
  }
  if (error instanceof ApiError && error.code === "PROJECT_NOT_FOUND") {
    return (
      <StatePanel
        action={<ButtonLink href="/review/dashboard" variant="outline">{text.showAllProjects}</ButtonLink>}
        description={text.projectNotFoundDescription}
        title={text.projectNotFoundTitle}
      />
    );
  }
  return <ErrorPanel error={error} onRetry={onRetry} />;
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label={text.loading} className="grid gap-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Skeleton className="h-[28rem] xl:col-span-8" />
        <Skeleton className="h-[28rem] xl:col-span-4" />
        <Skeleton className="h-80 xl:col-span-7" />
        <Skeleton className="h-80 xl:col-span-5" />
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
