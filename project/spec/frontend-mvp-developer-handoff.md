# Artifact Server frontend MVP developer handoff

Status: completed by `feat/frontend-mvp` and retained as the original implementation brief.

The descriptions of missing frontend behavior below record the repository state
when this assignment began. The implemented application and its tests are now
the source of truth.

## Assignment

Build the first Artifact Server management interface in this repository.

The backend, HTTP API, CLI, MCP server, persistence layers, and deployment
packages already exist. The missing product surface is a browser interface for
people to browse and manage their projects and artifacts. This assignment must
produce that interface and ship it with the existing local and deployed
runtimes.

Work in an isolated Git worktree and preserve unrelated changes. Do not edit the
QA Miner repository. It is a read-only design and scaffold reference.

The source scaffold is:

```text
/Users/ramos/oss/qaminer/apps/web/src
```

Copy that source tree exactly before adapting it. Do not approximate its theme,
recreate its button, replace Base UI with Radix, or choose a different shadcn
preset. The starting source is deliberately small. Keep its visual foundation
and extend it into Artifact Server.

## What Artifact Server does

Artifact Server stores finished files and client-side websites. Every artifact
belongs to a project, keeps one stable identity, and has immutable saved
versions. A person can open the current version, inspect earlier versions,
compare versions, restore an earlier version, change whether the current link
requires sign-in, change tags, or tombstone the artifact.

Artifact Server does not compile source code or run backend code for an
artifact. It does not provide organizations inside one installation, comments,
annotations, workspaces, ownership transfer, custom document viewers, media
conversion, general Git hosting, or project-specific access-control lists.

The hierarchy is fixed:

```text
Artifact Server installation
└── Project
    └── Artifact
        └── Immutable version
```

One installation represents one person, team, or company. It contains one
closed member group and one or more projects. Every admitted human member can
manage artifacts in every project. Service API keys can perform only their
explicit capabilities.

## Current implementation

The backend already supports:

- local SQLite and local file storage;
- Postgres with S3-compatible, GCS, R2, or preview Azure Blob storage;
- a default project plus create, rename, archive, and unarchive operations;
- artifact lists with cursor pagination and exact tag filtering;
- artifact details, tags, access settings, action history, and tombstones;
- immutable versions, canonical manifests, text comparisons, and restore;
- public links and account-required content sessions;
- browser-native HTML, static sites, SPAs, images, PDFs, audio, and video;
- local browser sessions and hosted WorkOS browser login;
- installation members and managed API keys;
- CLI, HTTP, and MCP access through the same application services;
- local packages, OCI images, Compose, Helm, Cloudflare, AWS, and GCP release
  paths.

The repository now contains the management application in `apps/web`, and the
application origin serves its compiled assets. This document records the
original frontend assignment and is no longer a current-state inventory.

Since this handoff was written, the tree has also gained exact-version comments,
the artifact-first review viewer, agent dispatch, linked local artifacts,
generic OIDC and local-owner access, plus the first configurable Git-history
foundation. Public hosting controls, the server-operation route of the Artifact Server skill, custom domains, and the
remaining Git mirror are still separate work.

## Read these files before changing code

Read them in this order:

1. `AGENTS.md`
2. `project/spec/artifact-server-product-spec.md`
3. `project/spec/conformance.yml`
4. `README.md`
5. `project/spec/phase-8-project-scoped-artifacts.md`
6. `project/spec/decisions/0004-installation-identity-and-login.md`
7. `src/http/create-http-app.ts`
8. `src/http/artifact-http-failure.ts`
9. `src/core/model.ts`
10. `src/core/identity.ts`
11. `src/core/installation-identity.ts`
12. The relevant tests under `tests/conformance/`, especially:
    `installation-identity.test.ts`, `project-scoped-artifacts.test.ts`,
    `artifact-management.test.ts`, `artifact-lifecycle.test.ts`,
    `artifact-tags.test.ts`, `artifact-comparison.test.ts`, and
    `private-content-session.test.ts`.

The HTTP implementation and conformance tests are the current wire contract.
Do not infer a route from product prose when the route can be read directly.

Then inspect the complete QA Miner web package:

```text
/Users/ramos/oss/qaminer/apps/web/src
/Users/ramos/oss/qaminer/apps/web/package.json
/Users/ramos/oss/qaminer/apps/web/components.json
/Users/ramos/oss/qaminer/apps/web/index.html
/Users/ramos/oss/qaminer/apps/web/tsconfig.json
/Users/ramos/oss/qaminer/apps/web/vite.config.ts
```

The reference repository revision at the time of this handoff is
`58ab90a6d80ab329b0ea567fa8377d14d85dede4`. If the reference repository has
changed, compare it with that revision before deciding which changes belong in
Artifact Server.

## Scaffold requirement

Create `apps/web` in Artifact Server and add it to the pnpm workspace. Begin by
copying the QA Miner `src` directory byte for byte. Also use its package,
`components.json`, Vite, Tailwind, TypeScript, font, Base UI, Hugeicons, and
shadcn setup as the configuration baseline. Change product names, descriptions,
build destinations, and API proxy settings only where Artifact Server requires
different values.

The retained foundation includes:

- React 19 and Vite;
- Tailwind CSS 4;
- shadcn style `base-sera`;
- Base UI primitives;
- Hugeicons;
- Geist for body text and Noto Sans for headings;
- the complete light and dark color tokens in `src/index.css`;
- the existing `cn` helper;
- the existing button implementation and variants;
- square controls, restrained color, and the existing typography.

The copied `app.tsx` is demo content, not an Artifact Server screen. Replace
that content. The theme and component foundation are the required design
system.

Add shadcn components through the package's existing configuration. Do not
paste components from a different preset. Add only components used by the MVP.
Do not introduce another component library or a second styling system.

You own the screen composition, information hierarchy, responsive behavior,
and interaction details. Use plain product language. Do not add slogans,
marketing copy, decorative dashboards, fake metrics, charts without real data,
or an onboarding tour that delays access to the product.

## Runtime and packaging architecture

Use one frontend source and one production build. Do not create a separate UI
for each deployment provider.

The management application belongs on the trusted application origin. It must
never be served from a version content hostname. Version content hostnames run
untrusted customer JavaScript and expose only immutable artifact files plus the
private-content bootstrap exchange.

The completed build must cover these paths:

- direct local package;
- compact and external-storage Node runtimes;
- the production OCI image used by Compose, Helm, AWS, and GCP;
- the Cloudflare Worker deployment.

Keep the platform difference at the asset-serving boundary. Node runtimes can
serve the built files from the release package. Cloudflare can use its static
asset binding. The React application and API client must not contain provider
branches.

Serve the application HTML with a strict self-only Content Security Policy and
without inline script or `eval`. Add `frame-ancestors 'none'`, a strict referrer
policy, and `X-Content-Type-Options: nosniff`. Cache fingerprinted assets for a
long time and make the application shell revalidatable so a deployment does not
leave browsers pinned to an old asset manifest. Apply the same policy in Node
and Cloudflare delivery.

Application routes must coexist with these existing server routes:

```text
/health
/ready
/auth/*
/api/*
/mcp
/artifacts/:artifactId
```

Do not let SPA fallback intercept an API, authentication, MCP, health, stable
artifact, or version-content request. A deep link to a real management screen
must still load the application after a browser refresh.

Add the web build to the existing root build and verification commands. Include
its static output in the direct package and OCI image. Keep the existing server
build usable by deployment and recovery scripts. Do not make Docker a
requirement for local UI development or direct local use.

## Local development

The repository requires Node.js 24.12 or newer and pnpm 10.34.3.

The existing backend starts from source with:

```sh
cd /Users/ramos/oss/artifact-server
pnpm install
pnpm start -- --data .artifact-server --port 8787
```

It creates private local credentials in `.artifact-server/` and prints neither
credential. Preserve that rule.

Provide one root development command that runs the backend and Vite together.
Vite may proxy same-origin application and API requests to port 8787. The proxy
must preserve the backend's session and CSRF protections. Do not disable origin,
Fetch Metadata, cookie, or CSRF checks to make development convenient.

Add a simple packaged CLI path that opens the clean local management URL in the
person's browser. The loopback, same-origin local-owner exchange creates the
normal application session without putting a credential in a URL or exposing
one to browser JavaScript. A person must not open a credential file, copy a
token, inspect startup logs, paste a secret, or use a particular browser
profile. Choose a command name consistent with the existing CLI after inspecting
its current surface, and document it.

The legacy `GET /auth/local` compatibility route is not the normal UI entry.
The UI reads `/auth/context`, performs at most one empty
`POST /auth/local-owner` exchange in local-owner mode, and then loads the management
application. Update the associated behavior tests.

## Browser authentication and request rules

The UI uses Artifact Server application sessions. It does not use MCP tokens,
WorkOS access tokens, or API keys directly.

On startup, call:

```text
GET /api/v1/session
```

The response contains `authenticationMethod` and the provider-neutral
`principal`. Use the principal's human role and capabilities to decide which
administrative actions to show.

For a hosted deployment, an unauthenticated screen sends the person to:

```text
GET /auth/login?returnTo=<safe application path>
```

WorkOS completes login, but the UI never receives or stores a WorkOS token.
Artifact Server exchanges the verified identity for its own opaque session.

Every browser request must use same-origin credentials. For `POST`, `PATCH`,
and `DELETE` requests authenticated by a browser session, read the CSRF cookie
and send its value as `X-CSRF-Token`. The local cookie is `artifact_csrf`; the
HTTPS cookie is `__Host-artifact_csrf`. Never copy the session cookie, which is
HttpOnly. Never store a credential in local storage, session storage, IndexedDB,
a URL, frontend state that can be serialized, telemetry, or an error report.

Real browsers supply the required `Origin` and Fetch Metadata headers. Do not
attempt to synthesize those headers in application code. A development proxy
must be configured so the backend still sees the request as same-origin.

A `401` means the browser needs a new application session. A `403` means the
signed-in principal lacks permission. Do not convert both cases into a generic
failure toast.

Logout is:

```text
POST /api/v1/session/logout
```

It uses the same CSRF rules as other browser mutations.

## HTTP API

The authenticated management API is under `/api/v1`. Success bodies are JSON.
Expected failures use this shape:

```json
{
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "Plain explanation"
  }
}
```

Create a small typed frontend client. Parse response data at the HTTP boundary
instead of asserting that JSON has the expected type. Keep its error type rich
enough for the UI to handle authentication, authorization, stale writes,
archived projects, missing records, and validation errors separately. Do not
introduce OpenAPI generation or a new repository-wide schema system for the
MVP.

Use the routes in `src/http/create-http-app.ts`. The main groups are:

```text
GET    /api/v1/session
POST   /api/v1/session/logout

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:projectId
PATCH  /api/v1/projects/:projectId
POST   /api/v1/projects/:projectId/archive
POST   /api/v1/projects/:projectId/unarchive

GET    /api/v1/artifacts
GET    /api/v1/artifacts/:artifactId
GET    /api/v1/artifacts/:artifactId/versions
GET    /api/v1/artifacts/:artifactId/versions/:versionId
GET    /api/v1/artifacts/:artifactId/actions
GET    /api/v1/artifacts/:artifactId/comparisons
POST   /api/v1/artifacts/:artifactId/restore
PATCH  /api/v1/artifacts/:artifactId/access
PATCH  /api/v1/artifacts/:artifactId/tags
DELETE /api/v1/artifacts/:artifactId
POST   /api/v1/artifacts/:artifactId/content-sessions
POST   /api/v1/artifacts/:artifactId/versions/:versionId/content-sessions

GET    /api/v1/members
POST   /api/v1/members
POST   /api/v1/members/:memberId/deactivate

GET    /api/v1/api-keys
POST   /api/v1/api-keys
POST   /api/v1/api-keys/:keyId/rotate
POST   /api/v1/api-keys/:keyId/revoke
```

Artifact operations must include the selected `projectId` as a query parameter.
When several active projects exist, the server intentionally refuses to guess.
Project names are labels; IDs are the request identity.

List routes use bounded cursor pagination. Use `nextCursor`; do not fetch every
page in the background. Artifact tag filtering is exact after server-side
normalization. Do not invent full-text search.

Restore, access changes, tag replacement, and artifact deletion require the
`expectedCurrentVersionId` last observed by the UI and a fresh
`Idempotency-Key` request header. If the artifact changed, show the conflict and
reload its current state. Do not retry a stale mutation with a new expected
version automatically. Generate one idempotency key for one intentional user
action and reuse that same key only when retrying the identical request after an
uncertain transport failure.

Creating or rotating a managed API key returns its secret once. Show it once,
offer a copy action, and discard it when the person leaves the result. Never
persist it in browser storage. API key expiration is required by the existing
contract; do not add non-expiring keys.

To open account-required content, first create a content session and then open
the returned `bootstrapUrl`. The content host consumes it once and redirects to
the clean immutable version address. Keep this action connected to the person's
click so popup blockers do not turn a successful authorization into a broken
experience. Public current artifacts can use the stable artifact link directly.

## MVP workflows

The first interface must support these complete workflows.

### Session

- Recognize a valid local or hosted application session.
- Start hosted login when needed.
- Show the signed-in person's identity and role.
- Log out.
- Recover cleanly when a session expires.

### Projects

- List active and archived projects.
- Select one project and keep that ID in management links.
- Create and rename a project.
- Archive and unarchive a project with clear consequences.
- Explain that archiving blocks new artifacts and versions but preserves
  existing artifacts and links.

### Artifacts

- List the selected project's active artifacts with cursor pagination.
- Filter by one exact tag.
- Show name, tags, access setting, current version number, and creation time.
- Open a public or account-required artifact through the correct flow.
- Show a useful empty state that points to the existing CLI and Agent Skill for
  publication.

Browser file publication is not an MVP requirement. The existing primary path
is `artifactserver publish <file-or-directory>` and the `artifact-server`
Agent Skill. Do not delay the management interface to build drag-and-drop,
directory hashing, upload progress, or browser retry orchestration.

### Artifact details and history

- Show current artifact metadata and the current immutable version.
- List saved versions and inspect a version's manifest.
- Compare any two versions using the server response. Present added, removed,
  changed, renamed, and bounded text differences without inventing media diffs.
- Restore an earlier version after showing what will become current.
- Replace the complete tag set.
- Change between `account_required` and `public_link`.
- Before making an artifact public, state that anybody who can reach the server
  and has the link can open it, and that downloaded or externally cached copies
  cannot be recalled.
- Tombstone an artifact only after explicit confirmation. State that all links
  stop working while committed versions remain stored. Do not add permanent
  deletion or individual-version deletion.
- Show the attributed action history in a compact, readable form.

### Installation administration

- For administrators, list, admit, and deactivate members.
- For administrators, list, issue, rotate, and revoke managed API keys.
- Require a name, future expiration, and explicit capabilities for a key.
- Do not build organizations, invitations, public sign-up, project membership,
  ownership transfer, billing, or Plannotator connection screens.

## Interaction and content rules

- Use product terms exactly: installation, project, artifact, version, account
  required, and public link.
- Do not call a project an organization, workspace, store, repository, or site.
- Do not call a tombstone permanent deletion.
- Do not imply that a public link changes a firewall or exposes a private
  network to the internet.
- Do not imply that an older saved version can change.
- Do not claim that changing a public artifact to account required recalls
  downloaded copies.
- Keep timestamps, IDs, hashes, paths, and API key capabilities available where
  they help an operator, but do not let them overwhelm the primary actions.
- Use progressive disclosure for manifests, action history, IDs, and other
  technical details.
- Every empty, loading, error, forbidden, conflict, and archived state needs an
  intentional treatment.
- Support keyboard use, visible focus, semantic controls, reduced motion, light
  and dark themes, narrow screens, and long names without clipping actions.
- Prefer direct labels such as `New project`, `Open artifact`, `Compare`,
  `Restore version`, and `Make public`.

## Anti-slop and code quality

The repository already contains the anti-slop Oxlint plugin at
`tools/oxlint/anti-slop` and enables every rule at error level in
`.oxlintrc.json`. The web package must be covered by that existing root lint
gate.

Invoke `$install-anti-slop` before changing lint configuration. Follow its
inspection procedure. Do not blindly reinstall or overwrite the existing
plugin. Confirm the installed Oxlint and `@oxlint/plugins` versions are current
and aligned, merge only necessary web ignores or environment settings, and keep
every anti-slop rule enabled at `error`.

Do not weaken a rule, add a broad ignore, introduce `any`, launder external JSON
through casts, use module mocks, or add a safety comment to excuse an avoidable
assertion. Fix the type or parse the boundary.

Use normal React code for view composition and local interaction state. Do not
force Effect into components. If a new backend workflow genuinely needs Effect,
read `node_modules/effect/AGENTS.md` completely first and follow the repository
rules. Keep HTTP parsing and failure translation at a narrow client boundary.

Avoid speculative abstractions. A small API client, route-level screens,
reusable product components, and shared interaction primitives are enough.

## Testing

Tests must prove behavior that can fail. Do not add snapshots of static markup,
tests that only assert a component renders, module mocks, coverage-padding
tests, or assertions against private implementation details.

At minimum, add:

- API client contract tests against real Artifact Server HTTP responses;
- browser-level tests for local login, project selection, artifact listing,
  public and account-required opening, access changes, tags, comparison,
  restore, tombstone, member administration, API key one-time display, logout,
  and session expiry;
- hostile tests proving that the UI cannot mutate without CSRF, cannot expose a
  session or managed-key secret, cannot cross project context, and cannot load
  trusted UI routes from a version content hostname;
- refresh/deep-link tests for management routes;
- a production-build smoke test using the exact packaged assets and real
  backend, not Vite's development server;
- a Cloudflare Worker test proving the same UI build loads from the application
  origin while version hosts remain content-only;
- accessibility checks for the completed primary workflows.

Use temporary SQLite data and the real HTTP boundary for the main MVP tests.
Use a real browser for browser claims. Keep the suite bounded and deterministic.
Do not rerun live AWS, GCP, or Cloudflare infrastructure qualification merely
because the shared OCI image gained static assets. The production image,
package, Helm, Compose, and Worker integration gates must prove the assets are
present and routed correctly.

If the UI implements a promise that is indexed in `project/spec/conformance.yml`, add
or update the observable acceptance test and its evidence. Do not mark a
requirement verified because a component exists.

## Work order

Keep every checkpoint runnable and reviewable.

1. Create the worktree and record the starting repository status.
2. Read the contracts and run the existing fast baseline before making changes.
3. Copy the QA Miner scaffold exactly and prove the untouched scaffold builds
   inside the Artifact Server workspace.
4. Add the typed API client, session bootstrap, CSRF handling, and real-backend
   contract tests.
5. Build project selection and artifact list/detail read paths.
6. Add open, history, comparison, tags, access, restore, and tombstone flows.
7. Add the administrator-only member and API key surfaces.
8. Integrate the production assets into Node packages, the OCI image, and the
   Cloudflare Worker without weakening content-host isolation.
9. Add the frictionless local browser-opening command and update local login to
   land on the UI.
10. Run browser, package, image, Worker, lint, type, build, smoke, and complete
    iteration gates. Review the changed code before handoff.

Split the work into understandable commits. A reasonable boundary is scaffold,
API/session foundation, core management workflows, administration, production
delivery, and verification. Do not mix unrelated backend cleanup into these
commits.

## Definition of done

The assignment is complete when:

- the final source retains the exact QA Miner theme and component foundation;
- one management application works locally and in every packaged runtime;
- a local person can open it without reading or copying a credential;
- hosted login uses Artifact Server's WorkOS-backed application session;
- no browser code stores an API key, WorkOS token, MCP token, or session secret;
- every MVP workflow above works against the real backend;
- untrusted artifact content cannot reach the management UI or its credentials;
- root lint includes anti-slop at error level and passes without suppressions;
- strict type checking, focused tests, production builds, package/image/Worker
  smoke tests, and `pnpm verify:iteration` pass;
- the README explains how a person starts and opens the UI locally and how the
  same UI appears on a deployed server;
- any real API gap discovered during implementation is either fixed through the
  existing application and authorization services or recorded precisely. The
  UI must not fake unsupported behavior.

At handoff, report the commit list, routes implemented, checks run, remaining
gaps, and screenshots of the primary light, dark, narrow, empty, populated, and
error states. Do not include credentials or private artifact data in
screenshots.
