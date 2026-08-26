import {ArrowLeft01Icon, Moon02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";

import {api, type Project, type Session} from "@/api/client";
import {StatePanel} from "@/components/product";
import {Button} from "@/components/ui/button";
import {ArtifactMark} from "./artifact-mark.tsx";
import {parseSettingsRoute, type SettingsRoute} from "./review-routes.ts";
import {ApiKeysScreen} from "./settings-api-keys.tsx";
import {MembersScreen} from "./settings-members.tsx";
import {SettingsProject, SettingsProjects} from "./settings-projects.tsx";
import {PublicLinksScreen} from "./settings-public-links.tsx";

interface ReviewSettingsProps {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}

/** Render project and installation administration inside the canonical application. */
export function ReviewSettings({
  onProjectsChanged,
  onThemeChange,
  projects,
  session,
  theme,
}: ReviewSettingsProps) {
  const route = parseSettingsRoute(window.location.pathname);
  const principal = session.principal;
  const directHuman = principal.kind === "human"
    && principal.authorizedByPrincipalId === null;
  const canManageProjects = directHuman
    || principal.capabilities.includes("project:manage");
  const administrator = directHuman
    && principal.membershipRole === "administrator";
  const reviewHref = readReturnToReview();

  return (
    <div className="as-settings">
      <header className="as-settings__header">
        <div className="as-settings__header-inner">
          <a className="as-settings__brand" href="/review">
            <ArtifactMark className="as-settings__mark" />
            <span>Artifact Server</span>
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
            <Button render={<a href={reviewHref} />} size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              Back to Review
            </Button>
          </div>
        </div>
      </header>
      <div className="as-settings__layout">
        <nav aria-label="Settings" className="as-settings__nav">
          <p>Settings</p>
          {canManageProjects ? (
            <SettingsLink active={route.kind === "projects" || route.kind === "project"} href="/review/settings/projects">
              Projects
            </SettingsLink>
          ) : null}
          {administrator ? (
            <>
              <SettingsLink active={route.kind === "members"} href="/review/settings/members">Members</SettingsLink>
              <SettingsLink active={route.kind === "apiKeys"} href="/review/settings/api-keys">API keys</SettingsLink>
              <SettingsLink active={route.kind === "publicLinks"} href="/review/settings/public-links">Public links</SettingsLink>
            </>
          ) : null}
        </nav>
        <main className="as-settings__content" id="main-content">
          <SettingsContent
            administrator={administrator}
            canManageProjects={canManageProjects}
            onProjectsChanged={onProjectsChanged}
            projects={projects}
            route={route}
            session={session}
          />
        </main>
      </div>
    </div>
  );
}

function SettingsContent({
  administrator,
  canManageProjects,
  onProjectsChanged,
  projects,
  route,
  session,
}: {
  readonly administrator: boolean;
  readonly canManageProjects: boolean;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
  readonly session: Session;
}) {
  if (route.kind === "notFound") {
    return (
      <StatePanel
        action={<Button render={<a href="/review/settings/projects" />} variant="outline">View settings</Button>}
        description="This Artifact Server settings route does not exist."
        title="Page not found"
      />
    );
  }
  if (route.kind === "projects" || route.kind === "project") {
    if (!canManageProjects) return <ProjectPermissionRequired />;
    if (route.kind === "projects") {
      return (
        <SettingsProjects
          canManage={canManageProjects}
          gitHistory={session.capabilities.gitHistory}
          onProjectsChanged={onProjectsChanged}
          projects={projects}
        />
      );
    }
    return (
      <SettingsProject
        canManage={canManageProjects}
        gitHistory={session.capabilities.gitHistory}
        onProjectsChanged={onProjectsChanged}
        projectId={route.projectId}
        projects={projects}
      />
    );
  }
  if (!administrator) return <AdministratorPermissionRequired />;
  switch (route.kind) {
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
  }
  return <AdministratorPermissionRequired />;
}

function SettingsLink({
  active,
  children,
  href,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly href: string;
}) {
  return (
    <a aria-current={active ? "page" : undefined} data-active={active} href={href}>
      {children}
    </a>
  );
}

function ProjectPermissionRequired() {
  return (
    <StatePanel
      description="This account cannot manage projects."
      title="Project permission required"
    />
  );
}

function AdministratorPermissionRequired() {
  return (
    <StatePanel
      description="Only an installation administrator can manage members, API keys, and public links."
      title="Administrator permission required"
    />
  );
}

function readReturnToReview(): string {
  const stored = window.sessionStorage.getItem("artifact-review-return-url");
  return stored?.startsWith("/review") && !stored.startsWith("/review/settings")
    ? stored
    : "/review";
}
