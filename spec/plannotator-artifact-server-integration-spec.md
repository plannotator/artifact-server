# Plannotator and Artifact Server integration

**Status:** Proposed implementation baseline
**Date:** August 14, 2026
**Audience:** Plannotator Workspaces and Artifact Server engineering teams

## Decision

Plannotator can connect one organization to one Artifact Server installation and use it for project artifacts, saved versions, browser delivery, and comparisons.

The Artifact Server installation is the artifact boundary for that one Plannotator organization. Each Plannotator project maps to one Artifact Server project. Workspaces reference artifacts and exact versions from their project; workspaces do not own artifact storage.

Plannotator remains responsible for sign-in, its organization, project and workspace records, workspace permissions, comments, annotations, replies, notifications, and review state. Artifact Server stores the paired project record and remains responsible for artifact files, versions, delivery, comparison, and artifact access settings. It does not create another organization or workspace permission system.

A person should be able to connect a reachable Artifact Server to Plannotator from one approval screen. A server inside a private network also needs an outbound connection or a network route that Plannotator can use.

## What the customer sees

### Connect

1. An Artifact Server administrator selects **Connect to Plannotator**.
2. Artifact Server opens Plannotator in the browser.
3. The administrator signs in, chooses one Plannotator organization, and approves the connection.
4. Plannotator and Artifact Server save the connection.
5. Plannotator shows the server as available storage for that organization.

The products do not copy user accounts. Connecting the server does not forward a WorkOS token, Plannotator browser cookie, Artifact Server login cookie, or reusable user credential.

One Artifact Server installation can connect to one Plannotator organization in the first Plannotator integration release. Supporting several Plannotator organizations on one installation would introduce a multi-organization model that Artifact Server otherwise does not have.

### Use

After connection, an authorized Plannotator user or agent can:

- publish a new artifact to a paired project;
- publish another version of an existing artifact;
- open the current version or an exact earlier version;
- compare two versions;
- change whether the current version has a public link, when server policy allows it;
- open an exact version in Plannotator review mode.

Project-library operations require permission to use the Plannotator project. A workspace may reference an artifact from its project and request read-only access to that artifact or one exact version. Workspace access never grants project-library listing or mutation. Artifact Server verifies that every request came through the approved connection and is limited to the paired project, named operation, and named artifact or version when applicable.

## System responsibilities

| Responsibility | Responsible system |
| --- | --- |
| Sign-in and organization membership | Plannotator |
| Plannotator project and workspace records | Plannotator |
| Paired Artifact Server project records | Artifact Server |
| Workspace access rules | Plannotator |
| Comments, annotations, replies, review status, and notifications | Plannotator |
| Artifact identity and saved version identity | Artifact Server |
| Manifests, file bytes, browser delivery, and file comparison | Artifact Server |
| Public-link state and delivery | Artifact Server, changed through a permitted Plannotator project operation when connected |
| Normal Artifact Server accounts and standalone artifacts | Artifact Server |
| Connection trust, temporary browser sessions, and access audit | Both systems |

Artifact Server remains an enforcing service. It does not become an unauthenticated file bucket. Plannotator decides whether a user may act, and Artifact Server accepts only a short-lived request from the paired Plannotator organization and project.

## Project mapping and artifacts

The systems use this mapping:

```text
Plannotator organization -> Artifact Server installation
Plannotator project      -> Artifact Server project
Plannotator workspace    -> references to project artifacts and versions
```

Artifact Server has no separate Plannotator-managed storage area. Connected projects use the same project, artifact, version, storage, audit, backup, and access rules as projects created directly in Artifact Server.

Each paired project records:

- Artifact Server installation ID;
- Artifact Server project ID;
- Plannotator organization ID;
- Plannotator project ID;
- connection ID, creation time, state, and last successful synchronization time.

Each workspace reference records the Artifact Server installation, project, artifact, and exact version when the reference is version-specific. Comments and review anchors also record their route and anchor data. A workspace ID may appear in a delegated read request and audit record, but it does not change where the artifact is stored.

Connecting a server does not silently move existing artifacts. Pairing an existing Artifact Server project with a Plannotator project requires an explicit administrator action. The implementation must define name conflicts, unlinking, archival, and reconnect behavior before existing projects can be paired.

## Connection record

Artifact Server stores:

- the connection ID;
- the Plannotator organization ID;
- the approved Plannotator issuer and API origin;
- the public key or key-set address used to verify Plannotator requests;
- connection creation time, current state, and key version;
- the outbound-connector identity when one is used.
- the set of paired Artifact Server and Plannotator project IDs.

Plannotator stores:

- the same connection ID;
- the Artifact Server installation ID and application address;
- connection capabilities and health;
- the organization that owns the connection;
- the Artifact Server project ID paired to each connected Plannotator project.

Both products support disconnect, credential rotation, and an audit record of who approved each change.

## Authorization request

Plannotator sends Artifact Server a short-lived, signed request. The exact token format can use an audience-restricted OAuth access token or an equivalent signed assertion. It must contain:

- issuer;
- Artifact Server installation as the audience;
- connection ID;
- Plannotator organization ID;
- paired Artifact Server and Plannotator project IDs;
- workspace ID only when a workspace is requesting one referenced artifact or version;
- Plannotator user or service actor ID;
- permitted operation;
- artifact and version IDs when they already exist;
- issued time, expiration time, and unique request ID.

The token lifetime should not exceed five minutes. A token for reading one referenced version cannot list the project, publish, restore, change visibility, delete, or read another artifact. A token for project publishing cannot name a project from another connection or installation. Artifact Server records the external actor and, when present, referring workspace ID in its action log.

Plannotator credentials are never sent to artifact content, object storage, optional Git storage, or published JavaScript.

## Opening a private artifact

The browser uses an Artifact Server session rather than a Plannotator cookie.

1. The user selects an artifact in Plannotator.
2. Plannotator confirms that the workspace may reference the artifact from its project.
3. Plannotator requests a browser session for one project, artifact, and version.
4. Artifact Server returns a single-use URL with a short expiration.
5. The browser opens that URL as a top-level page.
6. Artifact Server consumes the one-use code, sets a host-only, Secure, HttpOnly, read-only content cookie, and redirects to a clean URL.
7. The version origin serves the HTML and every relative file required by that exact version.

The one-use code should expire in about 60 seconds. The content session should be short enough to limit access after revocation and long enough to read or review the artifact. Fifteen minutes is the initial value to test. The browser can obtain a new session from Plannotator when it expires.

Opening the artifact as a top-level page is the required baseline. It avoids reliance on third-party cookies inside a cross-site frame.

## Review mode

Review mode is explicit. It does not change the stored artifact and is not active on the normal artifact URL.

Artifact Server creates a separate review session and serves the same saved version through an isolated review address. In that response only, Artifact Server adds a small review bridge to HTML pages. The bridge can identify the current route, selected text, and a selected page element, then exchange bounded review messages with Plannotator.

Plannotator stores the comment and its anchor. The anchor includes the Artifact Server installation ID, project ID, artifact ID, exact version ID, route, and the selector or text information needed to find the reviewed content again. Opening the comment always requests the same saved version.

The bridge must not contain or receive a reusable Plannotator credential. Stored files, fingerprints, manifests, downloads, normal browser responses, and optional Git history remain unchanged. Review responses are private and are not placed in a shared CDN cache.

The implementation team must prototype the review channel before committing to its final UI. The prototype must test:

- cross-origin `postMessage` origin and session checks;
- hostile artifact JavaScript attempting to impersonate or modify the bridge;
- strict Content Security Policy and Trusted Types;
- multi-page sites, single-page applications, and route changes;
- service workers;
- text and element anchors after layout changes;
- session expiration and reconnection;
- browser behavior without third-party cookies.

If an injected bridge cannot meet the security and compatibility tests, the supported fallback is a Plannotator browser extension. The integration must not fall back to placing a reusable credential in artifact JavaScript.

## Private-network connection

A public or hosted Artifact Server needs no extra connector. Plannotator calls its application address directly.

A private Artifact Server uses one of these network arrangements:

1. A customer-provided route, VPN, private link, or tunnel that makes the Artifact Server application reachable from Plannotator.
2. An optional Artifact Server connector that opens an outbound-only connection to Plannotator.

The connector may expose only the paired Artifact Server service. It must not become a general proxy into the customer's network. It needs explicit egress addresses, health reporting, key rotation, revocation, reconnect behavior, and multiple replicas before the product makes a production availability claim.

The first Plannotator integration release may require a customer-provided route or Cloudflare Tunnel. A product-owned, cloud-independent connector is a later deliverable unless the team accepts its additional development and operating cost.

Connecting Plannotator never changes a firewall automatically and never makes an account-required artifact public.

## Failure and lifecycle behavior

- If Plannotator is unavailable, existing unexpired browser sessions may continue until they expire. New delegated Plannotator operations fail closed.
- If Artifact Server is unavailable, Plannotator keeps its artifact references and shows the connection failure. It does not create a second copy silently.
- Disconnecting disables new Plannotator requests immediately and prevents renewal of browser sessions. Existing short-lived sessions end at expiration.
- Key rotation accepts the previous verification key only for a bounded overlap period.
- Moving, unfiling, or deleting a Plannotator workspace removes or changes workspace references and review data according to Plannotator policy. It does not move or delete the project artifact or its versions.
- Deleting a Plannotator project does not silently delete Artifact Server artifacts. The first release unpairs and archives the Artifact Server project. A later destructive policy requires explicit confirmation, retention, restore, and deletion-proof behavior.
- Deleting the paired Plannotator organization disconnects the installation and stops new delegated operations. Artifact Server retains data according to its own administrator-controlled retention policy.
- Restoring either system from backup must preserve the connection ID, installation ID, project IDs, artifact IDs, and version IDs.
- Artifact Server administrators retain operational control over project records, access settings, backup, restore, storage limits, and connection removal.

## Work split

This estimate covers only the integration. It excludes the existing Plannotator organization model, Workspaces product, comment system, and normal Artifact Server product.

| Work | Primary repository | Estimated effort |
| --- | --- | ---: |
| Connection approval, records, disconnect, and key rotation | Both | 1–2 engineer-weeks |
| Signed operation requests and Artifact Server enforcement | Artifact Server | 1–2 engineer-weeks |
| Project pairing, publish, open, compare, and server-selection integration | Plannotator | 1–2 engineer-weeks |
| Browser bootstrap session and production security tests | Artifact Server | 1–2 engineer-weeks |
| Review bridge prototype and first supported implementation | Both | 3–6 engineer-weeks |
| Private networking using an established tunnel | Both | 2–4 engineer-weeks |
| Product-owned, cloud-independent connector | Both | 6–10 engineer-weeks |

The public connection, publishing, and opening path is approximately three to five engineer-weeks. Adding the first supported review bridge brings the integration to approximately six to eleven engineer-weeks. Private-network support adds two to four engineer-weeks when it uses an established tunnel.

The rows overlap and should not be added as independent totals. These are architecture estimates. The team should replace them after inspecting both repositories and completing the browser and networking prototypes.

## Required investigation

The Plannotator team should return a short findings document that answers:

1. Where the connection belongs in the current organization and administrator interface.
2. Whether one organization can already hold one Artifact Server connection without changing the membership model.
3. Which current project actions should pair, publish, list, open, compare, archive, and unpair artifacts and projects.
4. Whether Plannotator already has a service-token or signed-assertion facility suitable for audience-restricted Artifact Server requests.
5. How comments currently identify a page, version, route, selected text, and selected element.
6. Whether the first review bridge can reuse the current annotation client without exposing a reusable credential.
7. Whether the hosted Cloudflare deployment should use an internal Artifact Server core directly or exercise the same external connection protocol.
8. Which private-network path should ship first: customer-provided networking, Cloudflare Tunnel, or a product-owned connector.
9. The exact user experience for disconnect, unavailable server, expired session, project pairing, workspace references, and project archival.
10. Revised implementation estimates with responsible teams and the minimum test environment.
11. How the pairing callback validates the server identity and address without creating an open redirect, server-side request forgery path, or connection-claiming race.

## Acceptance tests

The integration is ready when these tests pass:

- An administrator connects one Artifact Server installation to one Plannotator organization from the browser.
- A second organization cannot reuse or claim that connection.
- No Plannotator user account is copied into Artifact Server.
- A Plannotator project pairs with exactly one Artifact Server project and preserves both stable IDs.
- An authorized organization member can publish to the paired project and open an exact artifact version.
- An authorized workspace viewer can open one referenced artifact version without gaining project-list or mutation access.
- A public or `link_edit` workspace cannot publish, restore, change visibility, or delete a project artifact.
- An unauthorized member, another project, an unreferenced artifact, another installation, and an expired signed request are rejected without revealing which identifier exists.
- A one-use browser URL cannot be replayed and leaves no credential in the clean artifact URL.
- Relative assets and client-side routes work for an account-required multi-file site.
- Disconnect stops new operations and browser-session renewal.
- Key rotation does not interrupt valid in-flight work and old keys stop working after the overlap period.
- A comment remains attached to the exact reviewed version after a later version is published.
- Hostile artifact code cannot obtain a reusable Plannotator or Artifact Server credential.
- A private deployment loses access when its connector stops and recovers without re-pairing when the connector returns.
- Moving, unfiling, or deleting a workspace does not move or delete its referenced project artifacts.
- Unpairing or deleting a Plannotator project cannot silently delete Artifact Server artifacts or versions.
- Audit records identify the connection, project, optional referring workspace, external user or service actor, artifact, version, operation, and outcome.

## Standards and precedents

The overall design follows established patterns:

- [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/info/rfc8693/) defines short-lived delegation to a backend resource.
- [AWS CloudFront signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html) provide temporary access to several private files without changing every asset URL.
- [Grafana Private Data Source Connect](https://grafana.com/docs/grafana-cloud/connect-externally-hosted/private-data-source-connect/) and [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) use outbound connections to reach customer services inside private networks.
- [The browser same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) prevents Plannotator from directly reading the DOM of an unrelated artifact frame.
- [Vercel Toolbar](https://vercel.com/docs/vercel-toolbar/in-production-and-localhost/add-to-production) uses an injected package or browser extension for page-level collaboration.
