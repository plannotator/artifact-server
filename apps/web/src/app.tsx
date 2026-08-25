import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  api,
  ApiError,
  type AccessContext,
  type Principal,
  type Project,
  type Session,
} from "@/api/client";
import { ErrorPanel, StatePanel } from "@/components/product";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ApiKeysScreen } from "@/screens/api-keys-screen";
import { ArtifactDetailScreen } from "@/screens/artifact-detail-screen";
import { ArtifactsScreen } from "@/screens/artifacts-screen";
import { MembersScreen } from "@/screens/members-screen";
import { ProjectsScreen } from "@/screens/projects-screen";
import { PublicLinksScreen } from "@/screens/public-links-screen";
import { ReviewScreen } from "@/screens/review-screen";

type Route =
  | { readonly kind: "projects" }
  | { readonly kind: "artifacts"; readonly projectId: string }
  | {
    readonly artifactId: string;
    readonly kind: "artifact";
    readonly projectId: string;
  }
  | {
    readonly artifactId: string;
    readonly kind: "review";
    readonly projectId: string;
    readonly versionId: string;
  }
  | { readonly kind: "members" }
  | { readonly kind: "apiKeys" }
  | { readonly kind: "publicLinks" }
  | { readonly kind: "home" }
  | { readonly kind: "notFound" };

/** Artifact Server's trusted management application. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [accessContext, setAccessContext] = useState<AccessContext | null>(null);
  const accessContextRef = useRef<AccessContext | null>(null);
  const bootstrapInFlightRef = useRef(false);
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
    if (bootstrapInFlightRef.current) return;
    bootstrapInFlightRef.current = true;
    setSessionState("loading");
    setError(null);
    try {
      const [loadedAccessContext, initialSession] = await Promise.all([
        api.accessContext(),
        api.session().then(
          (value) => ({kind: "authenticated" as const, value}),
          (cause: unknown) => ({cause, kind: "failed" as const}),
        ),
      ]);
      setAccessContext(loadedAccessContext);
      accessContextRef.current = loadedAccessContext;
      let loadedSession: Session;
      if (initialSession.kind === "authenticated") {
        loadedSession = initialSession.value;
      } else if (
        loadedAccessContext.accessMode === "local_owner"
        && initialSession.cause instanceof ApiError
        && initialSession.cause.status === 401
      ) {
        await api.localOwnerSession();
        loadedSession = await api.session();
      } else {
        throw initialSession.cause;
      }
      setSession(loadedSession);
      await loadProjects();
      setSessionState("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
        setSessionState("unauthenticated");
      } else {
        setError(caught instanceof Error ? caught : new Error("Session loading failed."));
        setSessionState("ready");
      }
    } finally {
      bootstrapInFlightRef.current = false;
    }
  };

  useEffect(() => {
    void bootstrap();
    const expire = () => {
      if (accessContextRef.current?.accessMode === "local_owner") {
        void bootstrap();
        return;
      }
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
            Sign in with this installation&apos;s configured identity provider.
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
  if (error !== null) {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-5 text-foreground">
        <ErrorPanel error={error} onRetry={() => void bootstrap()} />
      </main>
    );
  }
  if (session === null) return null;

  const routeContent = (
    <RouteContent
      gitHistory={session.capabilities.gitHistory}
      linkedArtifacts={session.capabilities.linkedArtifacts}
      principal={session.principal}
      projects={projects}
      reloadProjects={loadProjects}
      route={route}
    />
  );

  if (route.kind === "review") {
    return (
      <main className="h-svh bg-background text-foreground" id="main-content">
        {routeContent}
      </main>
    );
  }

  return (
    <ApplicationShell
      dark={dark}
      localOwner={accessContext?.accessMode === "local_owner"}
      onThemeChange={() => setDark((current) => !current)}
      principal={session.principal}
      projects={projects}
      route={route}
    >
      {routeContent}
    </ApplicationShell>
  );
}

function ApplicationShell({
  children,
  dark,
  localOwner,
  onThemeChange,
  principal,
  projects,
  route,
}: {
  readonly children: React.ReactNode;
  readonly dark: boolean;
  readonly localOwner: boolean;
  readonly onThemeChange: () => void;
  readonly principal: Principal;
  readonly projects: readonly Project[];
  readonly route: Route;
}) {
  const [logoutError, setLogoutError] = useState<Error | null>(null);
  const selectedProjectId = route.kind === "artifacts" || route.kind === "artifact"
      || route.kind === "review"
    ? route.projectId
    : "";
  const administrator = isAdministrator(principal);
  const accountName = principal.displayName?.trim()
    || (localOwner ? "Local owner" : "Account");
  const accountLabel = localOwner ? "Local admin" : accountName;

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
        <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-5 py-3 sm:px-8 md:flex md:h-16 md:gap-4 md:py-0">
          <a
            className="row-start-1 shrink-0 font-heading text-base font-semibold tracking-tight"
            href="/"
          >
            Artifact Server
          </a>
          <span className="hidden h-5 w-px shrink-0 bg-border md:block" aria-hidden="true" />
          <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 md:col-auto md:row-auto md:flex-1">
            <label className="min-w-0 flex-1 md:max-w-56">
              <span className="sr-only">Project</span>
              <NativeSelect
                aria-label="Project"
                className="w-full [&_[data-slot=native-select]]:font-medium"
                onChange={(event) => {
                  if (event.currentTarget.value !== "") {
                    window.location.assign(
                      `/projects/${encodeURIComponent(event.currentTarget.value)}/artifacts`,
                    );
                  }
                }}
                size="sm"
                value={selectedProjectId}
              >
                <NativeSelectOption value="">Choose project</NativeSelectOption>
                {projects.map((project) => (
                  <NativeSelectOption key={project.id} value={project.id}>
                    {project.name}{project.archivedAt === null ? "" : " (archived)"}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <nav aria-label="Primary navigation" className="flex items-center gap-1">
              {selectedProjectId === ""
                ? null
                : (
                  <Button
                    aria-current={route.kind === "artifacts" || route.kind === "artifact"
                      ? "page"
                      : undefined}
                    render={(
                      <a
                        href={`/projects/${encodeURIComponent(selectedProjectId)}/artifacts`}
                      />
                    )}
                    size="xs"
                    variant={route.kind === "artifacts" || route.kind === "artifact"
                      ? "secondary"
                      : "ghost"}
                  >
                    Artifacts
                  </Button>
                )}
              <Button
                aria-current={route.kind === "projects" ? "page" : undefined}
                render={<a href="/projects" />}
                size="xs"
                variant={route.kind === "projects" ? "secondary" : "ghost"}
              >
                Projects
              </Button>
            </nav>
          </div>
          <details className="group relative col-start-2 row-start-1 md:ml-auto">
            <summary
              aria-label="Account menu"
              className="flex h-9 cursor-pointer list-none items-center gap-2 border border-transparent px-3 text-xs font-semibold tracking-widest uppercase outline-none select-none hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden"
            >
              <span className="max-w-36 truncate">{accountLabel}</span>
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-180"
                icon={ChevronDownIcon}
                strokeWidth={2}
              />
            </summary>
            <div className="absolute top-full right-0 z-50 mt-2 w-64 border bg-popover p-1 text-popover-foreground shadow-lg">
              <div className="px-3 py-3">
                <p className="truncate text-sm font-medium">{accountName}</p>
                <p
                  className="mt-1 truncate text-xs capitalize text-muted-foreground"
                  title={principal.id}
                >
                  {principal.membershipRole} · {compactPrincipalId(principal.id)}
                </p>
              </div>
              {administrator
                ? (
                  <nav
                    aria-label="Administration"
                    className="grid gap-1 border-t p-1"
                  >
                    <Button
                      aria-current={route.kind === "publicLinks" ? "page" : undefined}
                      className="w-full justify-start"
                      render={<a href="/administration/public-links" />}
                      size="sm"
                      variant={route.kind === "publicLinks" ? "secondary" : "ghost"}
                    >
                      Public links
                    </Button>
                    <Button
                      aria-current={route.kind === "members" ? "page" : undefined}
                      className="w-full justify-start"
                      render={<a href="/administration/members" />}
                      size="sm"
                      variant={route.kind === "members" ? "secondary" : "ghost"}
                    >
                      Members
                    </Button>
                    <Button
                      aria-current={route.kind === "apiKeys" ? "page" : undefined}
                      className="w-full justify-start"
                      render={<a href="/administration/api-keys" />}
                      size="sm"
                      variant={route.kind === "apiKeys" ? "secondary" : "ghost"}
                    >
                      API keys
                    </Button>
                  </nav>
                )
                : null}
              <div className="grid gap-1 border-t p-1">
                <Button
                  className="w-full justify-start"
                  onClick={onThemeChange}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {dark ? "Light theme" : "Dark theme"}
                </Button>
                {localOwner ? null : (
                  <Button
                    className="w-full justify-start"
                    onClick={() => void logout()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Log out
                  </Button>
                )}
              </div>
            </div>
          </details>
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
  gitHistory,
  linkedArtifacts,
  principal,
  projects,
  reloadProjects,
  route,
}: {
  /** Optional Git provider availability; project selection remains separate. */
  readonly gitHistory: Session["capabilities"]["gitHistory"];
  /** Whether this deployment offers linked files at all (spec §4.3). */
  readonly linkedArtifacts: boolean;
  readonly principal: Principal;
  readonly projects: readonly Project[];
  readonly reloadProjects: () => Promise<void>;
  readonly route: Route;
}) {
  const project = route.kind === "artifacts" || route.kind === "artifact"
      || route.kind === "review"
    ? projects.find((candidate) => candidate.id === route.projectId)
    : undefined;
  const administrator = isAdministrator(principal);
  const canManageProjects = isDirectHuman(principal)
    || principal.capabilities.includes("project:manage");
  const canManageArtifacts = isDirectHuman(principal)
    || principal.capabilities.includes("artifact:manage:any");
  const canComment = isDirectHuman(principal)
    || principal.capabilities.includes("comment:write");

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
          gitHistory={gitHistory}
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
            linkedArtifacts={linkedArtifacts}
            project={project}
          />
        );
    case "review":
      return project === undefined
        ? <MissingProject />
        : (
          <ReviewScreen
            artifactId={route.artifactId}
            canComment={canComment}
            canManage={canManageArtifacts}
            linkedArtifacts={linkedArtifacts}
            principalId={principal.id}
            project={project}
            versionId={route.versionId}
          />
        );
    case "members":
      return administrator ? <MembersScreen /> : <ForbiddenAdministration />;
    case "apiKeys":
      return administrator ? <ApiKeysScreen /> : <ForbiddenAdministration />;
    case "publicLinks":
      return administrator ? <PublicLinksScreen /> : <ForbiddenAdministration />;
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
      description="Only an installation administrator can manage public links, members, and API keys."
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

function compactPrincipalId(value: string): string {
  const separator = value.indexOf("_");
  const identifier = separator === -1 ? value : value.slice(separator + 1);
  return identifier.slice(0, 8);
}

function parseRoute(pathname: string): Route {
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/projects") return { kind: "projects" };
  if (pathname === "/administration/members") return { kind: "members" };
  if (pathname === "/administration/api-keys") return { kind: "apiKeys" };
  if (pathname === "/administration/public-links") return { kind: "publicLinks" };
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
    if (
      segments.length === 7
      && segments[0] === "projects"
      && segments[2] === "artifacts"
      && segments[4] === "versions"
      && segments[6] === "review"
      && segments[1] !== undefined
      && segments[3] !== undefined
      && segments[5] !== undefined
    ) {
      return {
        artifactId: decodeURIComponent(segments[3]),
        kind: "review",
        projectId: decodeURIComponent(segments[1]),
        versionId: decodeURIComponent(segments[5]),
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
