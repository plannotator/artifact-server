# Artifact Server

**Product and architecture proposal**
**Status:** Decision draft
**Date:** August 14, 2026

Artifact Server publishes finished browser files and gives each published item a stable link and saved history. It accepts a complete client-side site or one ordinary file. It does not build source code or run backend code for an artifact.

The first release runs locally. Later releases add one-server, Kubernetes, Cloudflare, AWS, GCP, and Azure deployments without changing the artifact, version, access, or MCP contracts.

## Product summary

| Question | Decision |
| --- | --- |
| What does it publish? | Finished HTML, CSS, JavaScript, images, fonts, and other files needed by a client-side site, or one ordinary file such as an image, PDF, audio recording, video, text file, or ZIP archive. |
| What does a user or agent select? | One actual file or one finished directory. Public API and MCP arguments do not contain raw HTML, CSS, JavaScript, Markdown, or base64-wrapped file contents. The publishing client handles the upload details. |
| What does it execute? | Only code that a browser can run. Artifact Server does not install packages, compile source code, run Node.js or Python for an artifact, connect an artifact to a database, execute server functions, or perform server-side rendering. |
| How are files displayed? | Artifact Server sends the correct HTTP headers and lets the browser handle formats it already understands. The first release has no custom document viewer, media converter, thumbnail service, ZIP extractor, Markdown renderer, or syntax-highlighting interface. |
| How is work organized? | One installation represents one person, team, or company. It contains projects, and every artifact belongs to one project. A new installation creates a default project. There is no organization switcher or separate Artifact Store object. |
| What is an artifact? | One published item with a stable ID, owner, access setting, optional tags, current version, and immutable saved versions. |
| Who can read it? | Exactly two settings: account required, or public link. On a standalone installation, account required means every person admitted to that one installation may read it. A public link opens only the current version; history and comparisons remain account-required. |
| Who can change it? | Its owner and installation administrators. A service principal can perform only the actions granted to its API key. |
| How do agents use it? | Through MCP or the normal HTTP API. The `publish-artifact` Agent Skill handles routine publishing and opening. The optional `operate-artifact-server` skill handles deployment and administration. |
| Where does it run? | Local first. Then one server and Kubernetes. Then Cloudflare. Official AWS, GCP, and Azure installers follow the same container and storage contracts. |
| What stays outside it? | Building source code, artifact backends, comments, annotations, review workflow, workspace collaboration, and general-purpose Git hosting. Plannotator owns review and collaboration. |

## Supported content

Artifact Server accepts a complete directory of finished client-side files or one ordinary file.

| Content | First-release behavior |
| --- | --- |
| Static site or client-side application | Serve the published directory without rebuilding it. |
| HTML | Open in the browser. |
| Image | Let the browser display it. |
| PDF | Let the browser display or download it. |
| Audio or video | Let the browser play it and support byte-range requests. |
| Text, Markdown, JSON, and source code | Send the correct text type. No custom renderer or syntax highlighting. |
| ZIP, office document, or unknown file | Download it. |

The server supports `GET`, `HEAD`, byte ranges where applicable, a stable `ETag`, an explicit media type, `X-Content-Type-Options: nosniff`, and a safe `Content-Disposition`. It does not transcode, inspect, repair, or execute uploaded media and documents.

Client-side sites may load scripts, styles, fonts, images, and data from other websites. Normal browser rules still apply. A remote service must allow the artifact's origin, and a private network may block internet access. Artifact Server does not copy dependencies loaded from other websites.

## Project, artifact, and version model

One installation represents one person, team, or company. It contains projects. An artifact belongs to one project and keeps one identity over time. A version is one immutable saved manifest and its referenced file bytes.

The core records are:

- **Project:** stable ID, installation ID, name, creation time, and archive state.
- **Artifact:** stable ID, project ID, name, owner, access setting, zero to 20 tags, current version, created time, and deletion state.
- **Version:** stable ID, artifact ID, version number, canonical manifest digest, entry file, routing mode, publisher, and created time.
- **Manifest entry:** normalized path, byte length, media type, SHA-256 fingerprint, and file disposition.
- **Blob:** immutable file bytes addressed internally by SHA-256 fingerprint.
- **Action record:** publish, restore, access change, tag change, ownership change, or deletion with the responsible principal and idempotency key when applicable.

Tags are optional artifact metadata for exact filtering. The server trims whitespace,
normalizes Unicode, folds case, removes duplicates, sorts the result, and stores no more
than 20 tags of 40 characters each. Tags apply to the artifact, not to one saved version,
so publishing or restoring a version does not change them. Replacing the complete tag set
is an authorized, idempotent, audited metadata operation. The first release does not add
tag categories, nesting, per-version tags, or a separate tag-management system.

### Project rules

- A new installation creates one default project. Local publishing selects it automatically.
- Every artifact belongs to exactly one project. An artifact cannot move between installations.
- Projects use the installation's existing membership group. The first release has no project-specific members, roles, or access-control lists.
- Account-required artifacts remain readable by every admitted installation member. Artifact ownership, administrator authority, and scoped service credentials control mutations.
- Project identity is enforced by the repository, authorization service, uploads, idempotency records, browser sessions, HTTP API, MCP tools, audit records, backup, and restore.
- Archiving a project stops new artifacts and versions but preserves existing artifacts, links, history, comparisons, and immutable version bytes.
- The first release does not destructively delete a nonempty project. Project-wide deletion needs a separate retention and recovery decision.
- A project is a logical database and authorization boundary. It does not require a separate filesystem, bucket, database, Git service, Artifact Store, or Namespace object.

Existing installations migrate into one default project without changing installation, artifact, version, manifest, action, or content identities.

### Portable path rules

Every manifest path uses a normalized, relative POSIX path.

- Reject absolute paths, `.` and `..` segments, `.git` path components, backslashes, NUL characters, empty segments, and percent-encoded path separators.
- Reject symlinks, device files, sockets, and other special filesystem entries.
- Reject two paths that collide after Unicode normalization or case folding.
- Require the entry file to be one of the manifest paths.
- Resolve requests only through the manifest. Never join an untrusted request path directly to a storage directory.

The canonical manifest includes the sorted paths, each file fingerprint and size, the entry file, routing mode, and serving metadata. Its digest identifies the complete saved version, not just its individual blobs.

### Publishing and retry behavior

Each intentional publish uses a new idempotency key and creates a new version, even when its manifest matches an earlier version. Retrying the same publish with the same key and input digest returns the original result and never creates another version. Reusing the key with different input is rejected.

A publish that moves the current-version pointer states which version it started from. If another publish moved the pointer first, the server returns a conflict and the actual current version. It never silently overwrites newer work.

Restoring an earlier version moves the current-version pointer to that existing version and records a restore action. It does not modify the version or create duplicate file bytes.

## Links, site routing, and browser isolation

The application and published content never share an origin.

- The **application origin** handles login, MCP, artifact metadata, mutations, and stable artifact links.
- A **version content origin** serves one immutable artifact version and has no mutation endpoints.

Every version receives a unique content hostname, for example:

```text
https://app.example.com/artifacts/ARTIFACT_ID
https://VERSION_TOKEN.content.example.net/
```

The stable application link resolves the current version, checks access, and opens the exact version origin. A local installation uses a unique `*.localhost` hostname. Hosted and external-storage installations require wildcard DNS and a wildcard certificate for the content domain.

One origin per version provides four properties:

1. Root-relative assets such as `/assets/app.js` stay inside the correct version.
2. A service worker installed by one version cannot control a later version.
3. Public immutable files can be cached without mixing versions.
4. JavaScript from two artifacts does not share an origin.

Each site declares one routing mode when it is published:

- **Static:** a missing path returns 404.
- **Single-page application:** an HTML navigation request for a missing path returns the entry HTML file. Missing scripts, styles, images, and other assets still return 404.

## Reading account-required content

An account-required site must authorize its HTML and every relative asset without giving artifact JavaScript the application login.

1. The stable application link checks that the viewer belongs to the installation.
2. It creates a short-lived, single-use bootstrap token bound to one project, artifact, version, content hostname, and viewer.
3. The version content origin exchanges that token for a host-only, `Secure`, `HttpOnly` content cookie and redirects to a clean URL.
4. The cookie is valid only for that immutable version origin and read-only `GET` and `HEAD` requests.
5. The content origin has no endpoint that can change application or artifact data.

Private responses are not stored in a shared CDN cache in the first release. The current public version may use immutable CDN caching.

Publishing a new current version or changing a public artifact back to account required stops new unauthenticated origin requests to the previous public version and purges supported CDN caches. It cannot revoke bytes that someone already downloaded or copied while the version was public. The interface must say this before making an artifact public.

## Browser security contract

Published code is untrusted.

- Application cookies are host-only. They are never scoped to the content domain.
- Cookie-authenticated application mutations require a CSRF token and reject the content origin using `Origin` and Fetch Metadata checks.
- The application does not grant credentialed CORS access to a content origin.
- The content origin exposes only read-only artifact files and the private-content bootstrap exchange.
- OAuth callbacks and MCP authorization remain on the application origin.
- Published responses set explicit media types and `X-Content-Type-Options: nosniff`.
- Tests include a malicious artifact that attempts forms, fetches, frames, service workers, and cross-origin requests against the application.

A separate registrable content domain is required for hosted and external-storage deployments. Local development uses isolated `*.localhost` hosts. A same-site subdomain of the application domain is not the supported security boundary.

## Access and mutation policy

The two access settings control reading:

1. **Account required:** every admitted member of this standalone installation may read the artifact.
2. **Public link:** no account is required. Anyone who can reach the server and has the link may read it.

A public link removes sign-in. It does not open a firewall, create a tunnel, or put a private server on the internet. An administrator can disable public links for the installation.

Public links use unpredictable identifiers and send `X-Robots-Tag: noindex, nofollow` by default. They are unlisted, not secret: anyone who obtains the link can copy and redistribute it, and search-engine directives are not access control.

The public link opens only the artifact's current version. Version lists, comparisons, and earlier saved versions remain account-required. When a new version becomes current, the old public version is removed from supported CDN caches and stops serving to new unauthenticated origin requests. Copies already downloaded or retained elsewhere cannot be recalled.

The mutation policy is separate from the two read settings:

| Action | Owner | Installation administrator | Other admitted member | Scoped service principal |
| --- | --- | --- | --- | --- |
| Read account-required artifact | Yes | Yes | Yes | Only with read capability |
| Publish a new version | Yes | Yes | No | Only with publish capability for that artifact or for newly created artifacts |
| Restore a version | Yes | Yes | No | Only with restore capability |
| Change account required/public link | Yes | Yes | No | Only with visibility capability |
| Reassign ownership | No | Yes | No | No |
| Delete the artifact | Yes | Yes | No | Only with explicit delete capability |

An interactive agent acts as the signed-in person. An API key belongs to one named user or service principal, one installation, an expiry and revoke state, and explicit capabilities. A key with artifact access can use any project in that installation; projects do not add a second access-control list. Every mutation records the effective principal and, when present, the human who authorized the agent connection.

## Versions, comparisons, and optional Git

Comparisons use the primary version manifests, not Git.

- Compare normalized manifest paths to report files added, removed, or changed.
- Detect a rename only when an added path and removed path have the same fingerprint.
- For bounded text files, show a line comparison.
- For binary files, report the old and new size and fingerprint and provide links to both versions.
- The first release has no image comparison interface, PDF comparison, media analysis, or archive inspection.

Git history is an optional private copy chosen when the server is installed. It never supplies the files used to render an artifact.

| Deployment | Optional history provider |
| --- | --- |
| Laptop or one server | One private Git repository per artifact on persistent disk |
| Kubernetes or a major cloud | Configured private Git server or an optional internal history service |
| Cloudflare | Cloudflare Artifacts when enabled and available |

Each saved version maps to at most one Git commit. Large files may remain only in primary blob storage while the Git manifest records their paths, sizes, and fingerprints. A Git failure never blocks or deletes the saved version.

Cloudflare Artifacts remains optional while it is in closed beta. Current documented limits include 10 GB per repository. The product does not depend on Git LFS support.

## Storage commit and lifecycle

Publishing uses this order:

1. Create an expiring upload record bound to the principal and installation.
2. Upload files into a staging namespace.
3. Verify size, fingerprint, canonical path, manifest, and entry file.
4. Make immutable blobs available under their fingerprints.
5. In one database transaction, create the version, its manifest entries, the idempotency result, and the conditional current-version update.
6. Queue the optional Git copy after the version is committed.

The initial release deletes only expired staging uploads that were never committed. It does not automatically delete committed blobs or blobs left by a publish race. This may waste storage, but it cannot delete bytes referenced by an immutable version. A later garbage collector requires a durable lease or mark-and-sweep design with a concurrency and crash-recovery test before it is enabled.

Initial lifecycle rules:

- A committed version cannot be edited or individually deleted.
- Deleting an artifact tombstones its ID and stops all application and origin access.
- Physical blob reclamation waits for a backup-aware garbage collector.
- Automatic version expiry is not part of the initial release.
- Backup and restore must preserve installation, project, artifact, version, and action IDs.
- The one-server release requires a documented, tested database-and-blob backup and restore procedure before it is supported for teams.

## Plannotator integration

One Artifact Server installation can connect to one Plannotator organization in the first Plannotator integration release. The installation is that organization's artifact service. The administrator selects **Connect to Plannotator**, signs in to Plannotator, chooses the organization, and approves the connection. The systems store a connection record and verification keys; they do not copy users or exchange browser login cookies.

Each Plannotator project maps to one Artifact Server project. Plannotator workspaces inside that project reference its artifacts and exact versions; workspaces do not own artifact storage. Moving, unfiling, or deleting a workspace does not move or delete a project artifact.

Plannotator owns WorkOS sign-in, its organization, project and workspace records, workspace permissions, comments, annotations, replies, review state, notifications, and agent provenance. Artifact Server owns its paired project records, artifact IDs, immutable versions, manifests, blobs, browser delivery, comparisons, and artifact access settings. It does not add an organization table or a second workspace permission model.

Plannotator checks whether the caller may use the project or workspace before sending Artifact Server a short-lived, audience-restricted request. Project-library operations name the paired project and allowed action. A workspace reference may request read-only access to one artifact and exact version. That narrow access cannot list the project library or publish, restore, change visibility, reassign ownership, or delete an artifact. A public or `link_edit` workspace therefore cannot mutate a project artifact.

Artifact Server validates the paired installation and project, scope, signature, expiration, and request ID through its normal authorization service. It never receives a WorkOS token, Plannotator browser cookie, or reusable user credential. Connected projects use the same Artifact Server project, artifact, version, storage, audit, backup, and access rules as standalone projects; there is no separate managed storage area.

To open an account-required version, Plannotator requests a single-use browser URL. Artifact Server consumes that URL, sets a short-lived, host-only, Secure, HttpOnly content session, and redirects to the clean version address. The artifact opens as a top-level page so private delivery does not depend on third-party iframe cookies.

Review mode is a separate, explicit response. Artifact Server serves the same stored version through an isolated review address and adds a small review bridge to HTML responses for that session only. The bridge can identify the route, selected text, and selected page element, then exchange bounded messages with Plannotator. It receives no reusable credential. Normal responses, stored files, fingerprints, manifests, downloads, and optional Git history remain unchanged.

Plannotator stores each comment with the Artifact Server installation ID, project ID, artifact ID, exact version ID, route, and anchor. A comment on version 12 continues to load version 12 after version 13 is published. Artifact Server stores no comment, reply, notification, or review-state record.

A public or otherwise reachable Artifact Server needs no extra network component. A private installation needs a customer-provided route or an optional outbound-only connector limited to the paired Artifact Server service. Connecting Plannotator does not change a firewall or make an artifact public.

The detailed connection, authorization, review, lifecycle, acceptance-test, and work-split specification is in [Plannotator and Artifact Server integration](./plannotator-artifact-server-integration-spec.md).

## MCP and Agent Skills

The detailed MCP wire and authorization contract is in [Artifact Server MCP baseline](./artifact-server-mcp-baseline.md). MCP, the browser, and the HTTP API call the same product and authorization services.

### Official MCP connection paths

| Condition | What the person does |
| --- | --- |
| Local, single user | Install Artifact Server and run `artifactserver connect`. There is no browser sign-in, visible token, copied key, Docker requirement, or startup-log step. |
| Hosted or team server with compatible MCP OAuth | Add or select the server's `/mcp` address, sign in and approve in the browser, then return to the AI client. The client renews authorization automatically until it is revoked or disconnected. |
| Private-network team server with compatible MCP OAuth | Connect to the required company network or VPN, then use the same server-address and browser-sign-in flow. Signing in does not change network access. |
| Self-hosted server without compatible MCP OAuth | An administrator creates a scoped API key in the administration interface or administrator CLI. The developer enters it once through the AI client's secret input. Keys never come from startup logs. |
| CI, scripts, or unattended agents | An administrator creates a scoped service API key and stores it in the deployment's secret manager. No browser is involved. |

`artifactserver connect` registers the local `artifactserver mcp` stdio bridge
through the selected client's normal configuration and verifies it with a real
discovery call. The bridge reaches the existing authenticated loopback `/mcp`
endpoint. Its private local credential remains in a user-only file and is never
shown to the user, stored in client configuration, or passed as a process
argument. `artifactserver disconnect` removes the client registration, and
`artifactserver doctor` diagnoses the local service and connection without
revealing credentials.

Account-required artifact links use normal Artifact Server browser sign-in.
Public artifact links require no sign-in. MCP credentials never become browser
cookies.

These paths are release requirements. Each advertised client must pass clean
connection, repeat connection, disconnect, stale-state recovery, and hostile
credential tests. Remote OAuth paths must also pass renewal and revoke tests. A
local release cannot ship with manual token copying. API-key issuance must use
an administration surface, never startup output.

The initial tool surface is:

```text
artifact_capabilities
artifact_list
artifact_get
artifact_open
artifact_create_upload
artifact_commit_upload
artifact_set_visibility
artifact_set_tags
artifact_version_list
artifact_diff
artifact_restore_version
artifact_delete
```

The MCP server never accepts an arbitrary client filesystem path. The bundled
publishing client or skill reads a local file or directory, rejects symlinks and
special files, computes its portable manifest, and sends the actual bytes
through the server-issued upload plan. Server-side download from an arbitrary
URL is not part of the initial release.

Publishing starts from one actual file or one finished directory on the client's
filesystem. MCP does not accept raw HTML, CSS, JavaScript, Markdown, or base64
file contents as arguments. The publishing skill or client helper uploads the
selected bytes through the server-issued upload plan and commits the result. It
hides upload IDs, fingerprints, manifests, and size thresholds from the user.
Each upload address is a short-lived, single-file capability, so the helper can
stream the selected bytes without receiving or copying the MCP bearer
credential. An exact retry after a lost response is safe.

Artifact Server ships two portable Agent Skills:

- **`publish-artifact`:** publish, update, open, share, list, and compare artifacts through MCP.
- **`operate-artifact-server`:** an optional, separately installed administrator skill for install, deploy, upgrade, backup, restore, inspect, and repair work through the Artifact Server CLI.

The publishing skill resolves its target in this order: an explicit address or link, the server recorded in the artifact reference, current conversation context, project default, then user default. If more than one server remains possible, it asks and never guesses. Project configuration may name a server profile but never contains a credential.

## Deployment architecture

The portable product is the container or local process, database schema, blob-storage interface, URL and manifest contract, API, MCP tools, migrations, health checks, backup format, and conformance tests. Infrastructure tools are replaceable deployment adapters.

Every deployed process records request counts, handling time, and spans. It writes a configurable sample of normal request logs and always logs server failures and requests that take at least one second. It creates a server request ID, returns it in `X-Request-Id`, and uses it to connect HTTP or MCP work to Effect spans. Operators can export logs, metrics, and traces to any standard OTLP collector with OpenTelemetry environment variables. Telemetry records HTTP method, matched route pattern, status, protocol, deployment mode, and installation identity. It does not record authorization values, cookies, query strings, file contents, raw artifact IDs, or raw unbounded paths.

`/health` answers only whether the process is alive. `/ready` answers whether an external-storage process can use its validated configuration, completed migrations, database, and object storage. A dependency failure changes `/ready` to HTTP 503 but does not make `/health` fail.

| Target | Runtime and records | Blob storage | Official deployment surface |
| --- | --- | --- | --- |
| Laptop | One process running directly on the host and SQLite. A local container is optional. | Local disk | Downloadable package and `artifactserver start` |
| One server, compact | One container and SQLite | One persistent data directory | Compact Docker Compose |
| One server, external storage | One or more stateless containers and Postgres | Object storage through a supported adapter | External-storage Compose |
| Kubernetes | Stateless containers and Postgres | S3, GCS, Azure Blob, or compatible store | Helm chart |
| Cloudflare | Workers and D1 | R2 | Alchemy-backed Artifact Server installer |
| AWS | Container service or managed Kubernetes and Postgres | S3 | Pulumi-backed Artifact Server installer |
| GCP | Cloud Run or GKE and Cloud SQL Postgres | Google Cloud Storage | Pulumi-backed Artifact Server installer |
| Azure | Container Apps or AKS and Azure Database for PostgreSQL | Azure Blob Storage | Pulumi-backed Artifact Server installer |

Customers use one Artifact Server CLI. They choose a target, not an infrastructure framework. Pulumi, Alchemy, Helm, and Docker Compose remain internal or optional customization surfaces. Artifact Server does not require Pulumi Cloud; a Pulumi-backed installer can keep state in the customer's cloud.

Local use runs directly on the host by default and does not require Docker. The
one-server Compose package has two explicit profiles. Compact Compose runs one
application container with SQLite and one persistent data directory. It does
not claim failover or support multiple application writers. External-storage
Compose uses the same image but connects it to existing Postgres and object
storage through a supported adapter; it can run multiple application processes.
Kubernetes uses that external-storage runtime and never stores artifact data on pod-local
filesystems. The packages do not bundle a production database, object-storage
server, ingress controller, DNS server, or certificate authority.

Local use on the same computer uses loopback and `*.localhost`; it needs no
reverse proxy, DNS setup, wildcard certificate, or Caddy. A one-server
installation opened from other devices needs HTTPS routing for the application
origin and wildcard content origin. Caddy is the reference only when the team
does not already have a conforming reverse proxy. Kubernetes uses its Ingress
or Gateway, and managed-cloud packages use their provider edge.

The executable packaging scope, upgrade rules, recovery procedures, and test
matrix are defined in
[`phase-6-packaging.md`](./phase-6-packaging.md).

The blob interface can accept any provider for which a tested adapter exists.
The first external-storage package supports AWS S3 and Cloudflare R2 through its S3
adapter. Another S3-compatible service is supported only after it passes the
same contract tests. Native Google Cloud Storage and Azure Blob drivers ship
with their cloud packages; GCP and Azure do not depend on an S3 compatibility
layer.

## Executable conformance checklist

Every product promise, security rule, exclusion, deployment claim, and unresolved release gate in this specification has a stable ID in [`conformance.yml`](./conformance.yml). Each entry names its owning module, normal acceptance test, hostile or failure test, applicable deployments, dependencies, current status, and recorded evidence.

A requirement is complete only when both tests pass on every applicable deployment and the evidence is recorded. The validator and release-gate commands are documented in [`CONFORMANCE.md`](./CONFORMANCE.md).

## Release sequence

### Release 1: local product

- One process, SQLite, and local blob storage.
- One installation with one default project, project-scoped artifacts, and no organization or Artifact Store layer.
- Single-file and complete-site publishing.
- Browser-native file handling.
- Immutable versions, canonical manifests, text comparison, restore, and two read settings.
- `artifactserver connect`, the credential-hidden local stdio bridge, HTTP API, modern MCP, and `publish-artifact` skill.
- Unique `*.localhost` version origins and the browser security tests.
- Optional local Git history.
- No automatic committed-blob garbage collection.

### Release 2: private teams

- One digest-pinned Docker image for compact and external-storage profiles.
- Compact Compose for a one-server install plus External-storage Compose that
  connects to existing Postgres and object storage.
- Browser login, scoped API keys, Postgres and native blob drivers.
- Helm chart for Kubernetes. The chart deploys Artifact Server and connects to
  existing Postgres and object storage; it does not hide durable providers
  inside the application release.
- Private multi-file content bootstrap, backup and restore, upgrades, separate health and readiness checks, structured logs, OTLP export, and `operate-artifact-server` skill.
- Conformance tests on one server and multi-replica Kubernetes.

The optional Plannotator connection builds on this release. Public or already reachable servers support browser approval, signed operation requests, and top-level private opening first. The review bridge and private outbound connector have their own security and compatibility gates.

### Release 3: hosted Cloudflare

- Workers, D1, R2, WorkOS-hosted MCP authorization, public CDN delivery, and optional Cloudflare Artifacts.
- A trusted installation directory maps each request to its installation and storage assignment. The request cannot supply an unverified installation ID.
- Abuse controls, quotas, rate limits, audit logs, deletion, and support procedures.

The hosted service starts with one D1 database only after load and failure tests show it is suitable. The architecture does not claim that adding more D1 bindings is an automatic sharding system. Before a second database is needed, choose and test either a D1 installation directory and binding rollout process or an external Postgres control plane.

### Release 4: major-cloud installers

- AWS, GCP, and Azure installers behind the same Artifact Server CLI.
- Native object storage on each cloud.
- Upgrade, rollback, state recovery, backup, restore, private-network, and managed-Kubernetes tests.
- The official Helm chart remains available when customers prefer Kubernetes over a provider-specific container service.

## Release gates

The local release is ready when the complete local workflow passes. Hosted OAuth and Cloudflare tests are not local-release blockers; they gate their own releases.

Every applicable release must prove:

- one HTML file and one complete client-side site publish and open;
- root-relative assets and SPA navigation stay inside the exact version origin;
- a service worker from one version cannot control another version or the application;
- account-required HTML and all relative assets require the version-scoped content session;
- an artifact cannot submit an authenticated application mutation;
- unsafe manifest paths, symlinks, hash mismatches, oversized uploads, and stale publishes are rejected;
- retrying the same idempotency key returns the original result;
- an intentional identical publish with a new key creates a new version;
- Git-off comparison works and Git failure does not affect the saved version;
- public-to-private changes stop new origin access and attempt the configured CDN purge;
- backup and restore preserve IDs before a deployment is called team-ready;
- local/team target resolution never guesses between configured servers.
- local MCP setup requires no browser, visible token, copied key, Docker requirement, or startup-log inspection;
- remote MCP with OAuth connects from only the `/mcp` address and completes browser approval, renewal, revoke, and reconnect;
- self-hosted and automation API keys are issued through an administration surface and never exposed in startup or diagnostic logs;
- every advertised Codex, Claude Code, Cursor, and VS Code connection path passes from clean and stale client state.

## Known risks and decisions still required

These items can change implementation cost or hosting viability and must be resolved before their named release:

1. **Private multi-file delivery:** prototype the bootstrap token and version-scoped content cookie in current browsers before the team release.
2. **Wildcard content hosts:** document DNS, certificate, localhost, reverse-proxy, and private-network requirements. Decide whether path-based compatibility mode is worth its limitations.
3. **Hosted database growth:** load-test D1 and choose the control-plane and second-shard design before hosted scale requires it.
4. **Cloudflare Artifacts:** confirm access, pricing, limits, failure behavior, and Git compatibility before making it a supported optional provider.
5. **WorkOS MCP authorization:** complete live token, consent, refresh, revoke, CIMD, DCR, and stale-client tests before the hosted release.
6. **Embedded self-hosted OAuth:** ship Better Auth only after its beta MCP path passes the security, compatibility, migration, and recovery matrix.
7. **Cross-cloud installers:** prove create, upgrade, rollback, state recovery, backup, and delete on AWS, GCP, and Azure before calling those targets supported.
8. **Public hosting abuse:** define quotas, executable-file policy, malware response, phishing and copyright reporting, domain-reputation protection, suspension, and deletion before public artifactserver.com links launch.
9. **Capacity and cost:** choose default and maximum file count, file size, artifact size, version count, text-diff size, retention, rate, and egress limits from measured tests.
10. **Recovery promises:** choose support tiers, availability target, backup frequency, restore-time target, and acceptable data-loss window for hosted and self-hosted team deployments.
11. **Encryption and customer controls:** decide requirements for storage encryption keys, regional placement, audit export, legal hold, and permanent deletion before selling to regulated teams.
12. **Custom domains:** decide whether customer-owned content domains are supported and how certificates, cookies, abuse handling, and version origins work.
13. **Plannotator review bridge:** test the isolated review response against hostile artifact JavaScript, strict content policies, multi-page sites, single-page routes, service workers, anchor stability, session expiry, and browsers without third-party cookies. Use a browser extension if the injected bridge cannot pass without exposing a reusable credential.
14. **Existing project binding:** decide how an existing Artifact Server project pairs with a Plannotator project, including name conflicts, existing artifacts, unlinking, rollback, archival, and reconnect behavior. Pairing must not silently move artifacts or change IDs.
15. **Private Plannotator route:** choose the first supported path among customer-provided networking, Cloudflare Tunnel, or a product-owned connector. Define health, upgrades, replicas, egress addresses, and failure behavior before advertising one-click private connection.

## Deliberately not included

- Source-code builds or package installation.
- Backend code, databases, server functions, or server-side rendering for an artifact.
- Custom PDF or office-document viewers.
- Media conversion, adaptive streaming, thumbnails, or transcription.
- ZIP extraction or archive browsing.
- Markdown rendering or syntax-highlighting UI.
- Image, PDF, audio, video, or archive comparison engines.
- Comments, annotations, replies, review status, notifications, and workspace collaboration.
- General-purpose source-code hosting.
- Arbitrary add-ons that run inside Artifact Server.
- Automatic firewall changes or a general-purpose tunnel into the customer's network. An optional connector may expose only the paired Artifact Server service.
- Server-side fetching of arbitrary URLs.
