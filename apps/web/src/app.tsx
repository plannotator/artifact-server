import { useEffect, useMemo, useState } from "react";

import { api, type Principal, type Project, type Session } from "@/api/client";
import { ErrorPanel, StatePanel, StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
import { ApiKeysScreen } from "@/screens/api-keys-screen";
import { ArtifactDetailScreen } from "@/screens/artifact-detail-screen";
import { ArtifactsScreen } from "@/screens/artifacts-screen";
import { MembersScreen } from "@/screens/members-screen";
import { ProjectsScreen } from "@/screens/projects-screen";

type Route =
  | { readonly kind: "projects" }
  | { readonly kind: "artifacts"; readonly projectId: string }
  | {
    readonly artifactId: string;
    readonly kind: "artifact";
    readonly projectId: string;
  }
  | { readonly kind: "members" }
  | { readonly kind: "apiKeys" }
  | { readonly kind: "home" }
  | { readonly kind: "notFound" };

/** Artifact Server's trusted management application. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "unauthenticated">(
    "loading",
  );
  const [error, setError] = useState<Error | null>(null);
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const route = useMemo(() => parseRoute(window.location.pathname), []);

  const loadProjects = async () => {
    setProjects(await api.projects());
  };

  const bootstrap = async () => {
    setSessionState("loading");
    setError(null);
    try {
      const loadedSession = await api.session();
      setSession(loadedSession);
      await loadProjects();
      setSessionState("ready");
    } catch (caught) {
      if (caught instanceof Error && "status" in caught && caught.status === 401) {
        setSession(null);
        setSessionState("unauthenticated");
      } else {
        setError(caught instanceof Error ? caught : new Error("Session loading failed."));
        setSessionState("ready");
      }
    }
  };

  useEffect(() => {
    void bootstrap();
    const expire = () => {
      setSession(null);
      setSessionState("unauthenticated");
    };
    window.addEventListener("artifact-session-expired", expire);
    return () => window.removeEventListener("artifact-session-expired", expire);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (sessionState !== "ready" || route.kind !== "home" || projects.length === 0) return;
    const preferred = projects.find((project) => project.archivedAt === null) ?? projects[0];
    if (preferred !== undefined) {
      window.location.replace(
        `/projects/${encodeURIComponent(preferred.id)}/artifacts`,
      );
    }
  }, [projects, route.kind, sessionState]);

  if (sessionState === "loading") {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-5 text-foreground">
        <StatePanel
          description="Checking your Artifact Server application session."
          title="Loading installation"
        />
      </main>
    );
  }
  if (sessionState === "unauthenticated") {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return (
      <main className="grid min-h-svh place-items-center bg-background p-5 text-foreground">
        <section className="w-full max-w-lg border p-6 sm:p-8">
          <p className="font-mono text-xs font-semibold tracking-widest text-primary uppercase">
            Artifact Server
          </p>
          <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight">
            Sign in required
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Sign in with this installation's configured identity provider. For local use, run{" "}
            <code className="font-mono text-foreground">artifactserver open</code> so Artifact
            Server can authorize the browser without exposing its private credential.
          </p>
          <Button
            className="mt-6"
            render={<a href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`} />}
          >
            Sign in
          </Button>
        </section>
      </main>
    );
  }
  if (error !== null && session === null) {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-5 text-foreground">
        <ErrorPanel error={error} onRetry={() => void bootstrap()} />
      </main>
    );
  }
  if (session === null) return null;

  return (
    <ApplicationShell
      dark={dark}
      onThemeChange={() => setDark((current) => !current)}
      principal={session.principal}
      projects={projects}
      route={route}
    >
      <RouteContent
        principal={session.principal}
        projects={projects}
        reloadProjects={loadProjects}
        route={route}
      />
    </ApplicationShell>
  );
}

function ApplicationShell({
  children,
  dark,
  onThemeChange,
  principal,
  projects,
  route,
}: {
  readonly children: React.ReactNode;
  readonly dark: boolean;
  readonly onThemeChange: () => void;
  readonly principal: Principal;
  readonly projects: readonly Project[];
  readonly route: Route;
}) {
  const [logoutError, setLogoutError] = useState<Error | null>(null);
  const selectedProjectId = route.kind === "artifacts" || route.kind === "artifact"
    ? route.projectId
    : "";
  const administrator = isAdministrator(principal);

  const logout = async () => {
    setLogoutError(null);
    try {
      await api.logout();
      window.location.assign("/");
    } catch (caught) {
      setLogoutError(caught instanceof Error ? caught : new Error("Logout failed."));
    }
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <a
        className="fixed top-2 left-2 z-[100] -translate-y-20 bg-foreground px-3 py-2 text-sm text-background focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-4 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-5">
            <a className="shrink-0 font-heading text-base font-semibold tracking-tight" href="/">
              Artifact Server
            </a>
            <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
            <label className="min-w-0 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              <span className="sr-only">Selected project</span>
              <select
                className="h-9 max-w-64 rounded-none border border-input bg-background px-3 text-sm font-normal tracking-normal text-foreground normal-case outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                onChange={(event) => {
                  if (event.currentTarget.value !== "") {
                    window.location.assign(
                      `/projects/${encodeURIComponent(event.currentTarget.value)}/artifacts`,
                    );
                  }
                }}
                value={selectedProjectId}
              >
                <option value="">Select project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}{project.archivedAt === null ? "" : " (archived)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <nav aria-label="Primary navigation" className="flex items-center gap-1">
              <Button
                render={<a href="/projects" />}
                size="xs"
                variant={route.kind === "projects" ? "secondary" : "ghost"}
              >
                Projects
              </Button>
              {administrator
                ? (
                  <>
                    <Button
                      render={<a href="/administration/members" />}
                      size="xs"
                      variant={route.kind === "members" ? "secondary" : "ghost"}
                    >
                      Members
                    </Button>
                    <Button
                      render={<a href="/administration/api-keys" />}
                      size="xs"
                      variant={route.kind === "apiKeys" ? "secondary" : "ghost"}
                    >
                      API keys
                    </Button>
                  </>
                )
                : null}
            </nav>
            <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 text-right">
                <p className="max-w-40 truncate font-mono text-xs">{principal.id}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {principal.membershipRole}
                </p>
              </div>
              <StatusBadge tone={administrator ? "primary" : "neutral"}>
                {principal.kind}
              </StatusBadge>
            </div>
            <Button onClick={onThemeChange} size="xs" type="button" variant="ghost">
              {dark ? "Light theme" : "Dark theme"}
            </Button>
            <Button onClick={() => void logout()} size="xs" type="button" variant="outline">
              Log out
            </Button>
          </div>
        </div>
        {logoutError === null ? null : (
          <p className="mx-auto max-w-7xl px-5 pb-3 text-sm text-destructive" role="alert">
            {logoutError.message}
          </p>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-12" id="main-content">
        {children}
      </main>
    </div>
  );
}

function RouteContent({
  principal,
  projects,
  reloadProjects,
  route,
}: {
  readonly principal: Principal;
  readonly projects: readonly Project[];
  readonly reloadProjects: () => Promise<void>;
  readonly route: Route;
}) {
  const project = route.kind === "artifacts" || route.kind === "artifact"
    ? projects.find((candidate) => candidate.id === route.projectId)
    : undefined;
  const administrator = isAdministrator(principal);
  const canManageProjects = isDirectHuman(principal)
    || principal.capabilities.includes("project:manage");
  const canManageArtifacts = isDirectHuman(principal)
    || principal.capabilities.includes("artifact:manage:any");

  switch (route.kind) {
    case "home":
      return projects.length === 0
        ? (
          <StatePanel
            description="No project is available in this installation."
            title="No projects"
          />
        )
        : (
          <StatePanel
            description="Opening the selected project."
            title="Loading project"
          />
        );
    case "projects":
      return (
        <ProjectsScreen
          canManage={canManageProjects}
          onProjectsChanged={reloadProjects}
          projects={projects}
        />
      );
    case "artifacts":
      return project === undefined
        ? <MissingProject />
        : <ArtifactsScreen project={project} />;
    case "artifact":
      return project === undefined
        ? <MissingProject />
        : (
          <ArtifactDetailScreen
            artifactId={route.artifactId}
            canManage={canManageArtifacts}
            project={project}
          />
        );
    case "members":
      return administrator ? <MembersScreen /> : <ForbiddenAdministration />;
    case "apiKeys":
      return administrator ? <ApiKeysScreen /> : <ForbiddenAdministration />;
    case "notFound":
      return (
        <StatePanel
          action={(
            <Button render={<a href="/" />} variant="outline">Return to artifacts</Button>
          )}
          description="This management route does not exist."
          title="Page not found"
        />
      );
  }
  return routeHandled(route);
}

function MissingProject() {
  return (
    <StatePanel
      action={<Button render={<a href="/projects" />} variant="outline">View projects</Button>}
      description="The selected project is unavailable in this installation."
      title="Project not found"
    />
  );
}

function ForbiddenAdministration() {
  return (
    <StatePanel
      description="Only an installation administrator can manage members and API keys."
      title="Administrator permission required"
    />
  );
}

function isDirectHuman(principal: Principal): boolean {
  return principal.kind === "human" && principal.authorizedByPrincipalId === null;
}

function isAdministrator(principal: Principal): boolean {
  return isDirectHuman(principal) && principal.membershipRole === "administrator";
}

function parseRoute(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/projects") return { kind: "projects" };
  if (pathname === "/administration/members") return { kind: "members" };
  if (pathname === "/administration/api-keys") return { kind: "apiKeys" };
  const segments = pathname.split("/").filter((segment) => segment !== "");
  try {
    if (
      segments.length === 3
      && segments[0] === "projects"
      && segments[2] === "artifacts"
      && segments[1] !== undefined
    ) {
      return { kind: "artifacts", projectId: decodeURIComponent(segments[1]) };
    }
    if (
      segments.length === 4
      && segments[0] === "projects"
      && segments[2] === "artifacts"
      && segments[1] !== undefined
      && segments[3] !== undefined
    ) {
      return {
        artifactId: decodeURIComponent(segments[3]),
        kind: "artifact",
        projectId: decodeURIComponent(segments[1]),
      };
    }
  } catch {
    return { kind: "notFound" };
  }
  return { kind: "notFound" };
}

function routeHandled(route: never): never {
  throw new Error(`Unhandled management route: ${String(route)}`);
}
