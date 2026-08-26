# Single application administration

Status: implemented

## Decision

Artifact Server ships one web application.

The application has two modes:

- **Review** is the artifact-first workspace at `/review`.
- **Settings** contains project and installation administration under
  `/review/settings`.

Both modes use the same React entry point, session, visual system, components,
and navigation model. Settings pages do not force administration into the
three-pane artifact viewer. The old application bundle and its screens are
removed, not reskinned or retained as a fallback.

The isolated artifact-content frame remains a separate document and origin.
That is a security boundary, not a second application.

## Goals

- Give a local developer or private team one coherent web experience.
- Preserve every supported administrative capability that exists in the old
  application.
- Keep Review focused on artifacts instead of adding a permanent admin rail.
- Make administrative routes direct, refresh-safe, accessible, and governed by
  the same server-side authorization as HTTP, CLI, and MCP.
- Remove legacy frontend code, assets, route handling, and tests once equivalent
  behavior exists in the canonical application.

## Information architecture

| Route | Purpose | Who can use it |
| --- | --- | --- |
| `/review` | Browse, inspect, review, and share artifacts. | Admitted humans and authorized service principals. |
| `/review/settings/projects` | List active and archived projects; create a project. | Admitted humans and principals with `project:manage`. |
| `/review/settings/projects/:projectId` | Rename, archive or unarchive, and manage optional Git history for one project. | Admitted humans and principals with `project:manage`. |
| `/review/settings/members` | List, admit, and deactivate installation members. | Installation administrators. |
| `/review/settings/api-keys` | Issue, rotate, and revoke scoped API keys. | Installation administrators. |
| `/review/settings/public-links` | Inventory active public links and make selected links account-required. | Installation administrators. |

`/review/settings` redirects to `/review/settings/projects`. Unknown settings
routes show the application's normal not-found state and do not fall back to
Review or another settings page.

## Navigation

Review keeps its current artifact-first layout.

The project picker adds two quiet actions after the project list:

- **Project settings** opens the selected project's settings route.
- **Manage projects** opens the project list.

The existing **New project** action remains in the picker.

A compact settings entry in the Review header opens the settings shell. It
does not add a permanent sidebar to Review. Installation-administration links
are shown only to an installation administrator, but hidden navigation is not
an authorization boundary.

Settings uses a simple page shell with:

- the Artifact Server mark;
- a **Back to Review** action that preserves the last valid Review URL during
  the current browser session;
- a compact settings section navigation;
- one page title and one primary action at most.

On a narrow viewport, settings navigation becomes a disclosure or menu above
the page. It must not create horizontal overflow or compress a data table below
its usable width; tables may scroll inside their own region.

## Project settings

### Project list

The page lists active projects before archived projects. Each row shows the
project name and state, opens the project settings route, and can return to that
project in Review. Stable IDs stay available as secondary copyable metadata,
not primary labels.

Creating a project uses the existing name contract. A successful create opens
the new project's settings page. Failure leaves the entered name in place and
shows the server error beside the action.

### One project

The page supports these existing operations:

- rename the project without changing its ID;
- archive it after confirmation;
- unarchive it;
- read its optional Git-history state;
- request a Git-history estimate before enabling it;
- enable Git history only after the user confirms that estimate;
- disable Git history without deleting primary or remote data.

Archiving explains that new artifacts and versions stop while existing reads,
links, and immutable history remain. The current project in Review may stay
selected after archive, but creation and publication affordances must reflect
the archived state.

Git history is absent when no provider is configured. When a provider is
configured but unavailable, the page shows its safe capability state and does
not offer enablement. The UI must not expose credentials, provider coordinates,
queue internals, or raw provider errors.

Project-specific members, roles, or access-control lists are not part of this
page. Projects use installation membership.

## Installation settings

### Members

This page uses the product's closed admission model. It does not claim to send
an invitation email.

An administrator can:

- list active and inactive members;
- admit a person by display name, verified-provider email, and role;
- deactivate an active member after confirmation.

The server continues to prevent self-deactivation, deactivation of the last
active administrator, and local-owner administrator deactivation. Durable
artifacts, comments, actions, and attribution remain after deactivation.

Role editing and member deletion are out of scope.

### API keys

An administrator can:

- list keys with name, prefix, owner, capabilities, expiration, and status;
- issue a key for an active member or service principal with one or more
  explicit capabilities and a required future expiration;
- rotate an active key;
- revoke an active key after confirmation.

The complete secret is displayed once after issue or rotation. Closing that
dialog discards the secret from frontend state. The interface never offers to
reveal an existing secret.

### Public links

An administrator can page through active public-link artifacts across all
projects, open their public and Review destinations, select up to the existing
server limit, and make the selection account-required.

The confirmation states that future origin access stops but downloaded or
externally cached copies cannot be recalled. Partial success remains visible;
failed stale items can be refreshed and retried without rolling back successful
items.

Public-link creation stays with an artifact's Share surface. This page is an
installation-wide inventory and shutdown surface only.

## Shared interaction contract

Every settings page must provide:

- a stable URL that survives refresh and browser history;
- an explicit loading state that does not erase already loaded data;
- a useful empty state;
- an inline failure with a bounded retry;
- disabled or progress-labelled controls while one mutation is pending;
- confirmation for destructive or access-reducing changes;
- a success result visible without relying on color alone;
- focus placement and announcements suitable for keyboard and screen-reader
  use;
- server error text translated into product language without hiding request IDs
  needed for support.

Authorization is always enforced by product services. A direct request by a
non-administrator to installation settings fails with the normal forbidden
state. The application does not redirect that user to a misleading empty page.
Service principals may use project settings only with `project:manage`; they do
not receive installation-administration access through that capability.

## Route migration

The server stops serving the old application. These compatibility redirects
remain so bookmarks do not strand users:

| Old route | Redirect |
| --- | --- |
| `/?...` | `/review?...` |
| `/workbench?...` | `/review?...` |
| `/projects` | `/review/settings/projects` |
| `/projects/:projectId/artifacts` | `/review?project=:projectId` |
| `/projects/:projectId/artifacts/:artifactId` | `/review?project=:projectId&artifact=:artifactId` |
| `/projects/:projectId/artifacts/:artifactId/versions/:versionId/review` | `/review?project=:projectId&artifact=:artifactId&version=:versionId&view=focus` |
| `/administration/members` | `/review/settings/members` |
| `/administration/api-keys` | `/review/settings/api-keys` |
| `/administration/public-links` | `/review/settings/public-links` |

Redirects preserve a valid encoded identity and query context. They never
resolve an identifier by reading catalog pagination and never substitute a
different project, artifact, or version. `/workbench` remains a route alias
only; the name does not remain in visible product copy.

## Legacy capability parity

The old application also remains the only browser surface for several
non-administrative product operations. They cannot disappear as a side effect
of deleting the bundle.

The canonical application receives the smallest coherent version of each:

| Existing operation | Canonical home |
| --- | --- |
| Compare two immutable versions. | A **Compare** action in Versions opens comparison results in the inspector. |
| Read immutable action history. | An **Activity** inspector tab with bounded pagination. |
| Tombstone an artifact. | A secondary destructive action in Details with typed-name confirmation. |
| Read linked-source freshness and capture changed bytes. | A **Linked source** section in Details with **Capture now** when drifted. |
| Open the local linked artifact's live view. | A capability-gated **Open live view** action in the same Linked source section. |
| Send comment threads to connected agents and see presence. | Existing dispatch and presence controls integrated into Comments without changing the comment contract. |

These moves reuse existing API client calls and shared components. They do not
create new backend operations or new top-level routes. Unsupported deployment
capabilities remain absent, not disabled-looking promises.

If a product operation is intentionally retired instead, its product and
conformance contracts must be changed explicitly before the legacy screen is
deleted. Removing a screen is not, by itself, a decision to remove the product
behavior.

## Removal scope

The implementation removes:

- the legacy Vite `index.html` entry and `src/main.tsx` application entry;
- the legacy router and shell in `src/app.tsx`;
- legacy project, artifact list, artifact detail, Review, member, API-key, and
  public-link screens after equivalent canonical coverage lands;
- CSS and components used only by those screens;
- HTTP behavior that serves the legacy document;
- browser captures and tests whose only purpose is the old interface.

The implementation retains:

- the API client schemas and operations needed by the new settings routes;
- product services, HTTP APIs, CLI, MCP, and audit behavior;
- shared UI primitives that the canonical application uses;
- `review-frame.html` and the separate-origin content protocol;
- compatibility redirect tests.

The production build has exactly two HTML documents: the Artifact Server
application and the isolated Review frame.

## Delivery order

1. Add the shared settings route parser and shell to the canonical application.
2. Move project list and project settings behavior, then add picker navigation.
3. Move Members, API keys, and Public links without changing their backend
   contracts.
4. Move the remaining supported browser operations through the parity table,
   reusing their existing components and contracts.
5. Replace old HTTP routes with compatibility redirects.
6. Move browser proof to the canonical routes.
7. Delete the legacy entry, screens, styles, dead components, and build input.
8. Run the complete iteration gate and confirm that no production asset or
   visible copy refers to the legacy application or Workbench.

The migration may land in small commits, but a release must not ship with both
applications.

## Engineering assessment

This is a medium-to-large frontend migration with low backend risk. The API and
product operations already exist. Most work is route composition, moving UI
behavior, preserving authorization and recovery states, replacing browser
proof, and then deleting more code than the migration adds.

The parity step is the largest slice because the initial administration-only
inventory was incomplete. The settings shell itself should stay small and
should not introduce a routing framework, global state library, or new service
abstraction unless the current application proves unable to express the routes.

## Non-goals

- A dashboard, admin home, or analytics page.
- A permanent administration rail in Review.
- Project-specific membership or roles.
- Editing identity-provider, deployment, storage, or billing configuration in
  the browser.
- Adding, deleting, or changing backend administration contracts solely for the
  frontend migration.
- Replacing the separate-origin artifact frame.

## Acceptance summary

The work is complete when a clean build serves one Artifact Server application;
all supported project, member, API-key, public-link, and optional Git operations
are available from its canonical settings routes; old URLs redirect safely; an
unauthorized direct route fails closed; equivalent browser behavior is proved;
and no legacy React entry or screen is present in the shipped bundle.
