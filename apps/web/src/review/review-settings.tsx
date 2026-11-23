import {ArrowLeft01Icon, Moon02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";

import {api, type Project, type Session} from "@/api/client";
import {StatePanel} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {LanguageSwitch} from "@/i18n/language-switch";
import {settingsText} from "@/i18n/messages/settings";
import {ArtifactMark} from "./artifact-mark.tsx";
import {parseSettingsRoute, type SettingsRoute} from "./review-routes.ts";
import {ApiKeysScreen} from "./settings-api-keys.tsx";
import {McpScreen} from "./settings-mcp.tsx";
import {MembersScreen} from "./settings-members.tsx";
import {SettingsProject, SettingsProjects} from "./settings-projects.tsx";
import {PublicLinksScreen} from "./settings-public-links.tsx";
import {WebmcpScreen} from "./settings-webmcp.tsx";

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
          <a aria-label="Artifact Server" className="as-settings__brand" href={reviewHref}>
            <span className="as-settings__brand-mark">
              <ArtifactMark className="as-settings__mark" />
            </span>
            <span className="as-settings__brand-label">{settingsText.shell.brandLabel}</span>
          </a>
          <div className="as-settings__header-actions">
            <LanguageSwitch />
            <button
              aria-label={theme === "moon" ? settingsText.shell.useLightTheme : settingsText.shell.useDarkTheme}
              className="as-icon-button"
              onClick={onThemeChange}
              title={theme === "moon" ? settingsText.shell.useLightTheme : settingsText.shell.useDarkTheme}
              type="button"
            >
              <HugeiconsIcon icon={theme === "moon" ? Sun03Icon : Moon02Icon} strokeWidth={1.8} />
            </button>
            <ButtonLink href={reviewHref} size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              {settingsText.shell.backToReview}
            </ButtonLink>
            <Button
              onClick={() => void api.logout().finally(() => window.location.assign("/review"))}
              size="sm"
              variant="ghost"
            >
              {settingsText.shell.signOut}
            </Button>
          </div>
        </div>
      </header>
      <div className="as-settings__layout">
        <nav aria-label={settingsText.shell.navLabel} className="as-settings__nav">
          <p>{settingsText.shell.navHeading}</p>
          {canManageProjects ? (
            <SettingsLink active={route.kind === "projects" || route.kind === "project"} href="/review/settings/projects">
              {settingsText.shell.navProjects}
            </SettingsLink>
          ) : null}
          <SettingsLink active={route.kind === "mcp"} href="/review/settings/mcp">
            MCP
          </SettingsLink>
          <SettingsLink active={route.kind === "webmcp"} href="/review/settings/webmcp">
            WebMCP
          </SettingsLink>
          {administrator ? (
            <>
              <SettingsLink active={route.kind === "members"} href="/review/settings/members">{settingsText.shell.navMembers}</SettingsLink>
              <SettingsLink active={route.kind === "apiKeys"} href="/review/settings/api-keys">{settingsText.shell.navApiKeys}</SettingsLink>
              <SettingsLink active={route.kind === "publicLinks"} href="/review/settings/public-links">{settingsText.shell.navPublicLinks}</SettingsLink>
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
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            {settingsText.shell.notFoundAction}
          </ButtonLink>
        )}
        description={settingsText.shell.notFoundDescription}
        title={settingsText.shell.notFoundTitle}
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
  if (route.kind === "mcp") return <McpScreen administrator={administrator} />;
  if (route.kind === "webmcp") return <WebmcpScreen />;
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
      description={settingsText.shell.projectPermissionDescription}
      title={settingsText.shell.projectPermissionTitle}
    />
  );
}

function AdministratorPermissionRequired() {
  return (
    <StatePanel
      description={settingsText.shell.administratorPermissionDescription}
      title={settingsText.shell.administratorPermissionTitle}
    />
  );
}

function readReturnToReview(): string {
  const stored = window.sessionStorage.getItem("artifact-review-return-url");
  return stored?.startsWith("/review") && !stored.startsWith("/review/settings")
    ? stored
    : "/review";
}
