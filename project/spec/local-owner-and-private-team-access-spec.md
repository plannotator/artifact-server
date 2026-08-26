# Local owner and private team access

- **Status:** Accepted; implementation underway — generic OIDC (`AUTH-019` through `AUTH-021`) and bounded authentication caching (`AUTH-022`) are behavior-verified; local-owner and private-team access (`AUTH-023` through `AUTH-028`) work in the current Node and browser suites but remain `implementing` for the deployment and hostile-matrix gaps recorded in the ledger
- **Date:** 2026-08-23
- **Decision:** [ADR 0025](./decisions/0025-local-owner-and-private-team-access.md)
- **Owners:** authorization, web application, CLI, deployment

## Required outcome

Artifact Server has two supported first-release access modes.

1. A developer opens a direct local installation in any browser profile and
   receives a normal owner session without running a login command or handling
   a credential.
2. A team deploys Artifact Server behind HTTPS, signs in through its identity
   provider, admits teammates individually, and uses scoped credentials for
   agents and automation.

Both modes use the existing principal, session, CSRF, authorization,
attribution, audit, and content-session services. The implementation changes
how the first human identity reaches those services. It does not create an
authentication-free product path.

## Current state and gap

The repository already has most of the private-team identity model:

- server-side application sessions with digested credentials;
- host-only application and CSRF cookies;
- exact-origin and Fetch Metadata checks for browser mutations;
- generic OIDC and WorkOS interactive identity providers;
- first-administrator bootstrap by verified email;
- explicit member admission, administrator and member roles, and deactivation;
- administrator-issued, scoped user and service API keys;
- compact Compose, external-storage Compose, and Helm deployment shapes;
- separate management and wildcard content origins.

The current local browser path is the main usability gap. `artifactserver open`
uses a private file credential to mint a one-time token, puts that token in a
browser URL, and opens one operating-system browser profile. Another profile
has no session and sees a sign-in screen. The Vite development origin has the
same problem in a fresh profile.

The private-team pieces also lack one complete release contract. A compact
server can currently start without OIDC or WorkOS and can retain a local
browser-bootstrap credential. The deployment documentation leaves the proxy,
DNS, and certificates to the operator, and the conformance ledger does not yet
prove an install-to-use team workflow behind real TLS and wildcard routing.

## Scope

### Included

| Area | Required work |
| --- | --- |
| Runtime selection | Make the access mode an explicit property supplied by each runtime entry point. |
| Local browser access | Add a credential-free, loopback-only exchange that creates a normal local-owner session. |
| Browser application | Discover the access mode, establish a local session automatically, and show team sign-in only in private-team mode. |
| Local CLI | Make `artifactserver open` open the application URL without minting or placing a credential in the URL. |
| Development server | Make both `127.0.0.1:5173` and the compiled local application work in a fresh browser profile. |
| Team startup | Require exactly one browser identity provider and disable local-owner and legacy installation credentials. |
| Team onboarding | Prove first-admin login, explicit teammate admission, individual sessions, roles, logout, deactivation, and scoped non-browser credentials. |
| Team ingress | Specify and test the management hostname, wildcard content hostname, TLS, proxy, and hostile-host boundary. |
| Packaging | Apply the team contract to compact Compose, external-storage Compose, and Helm. |
| Release proof | Add conformance requirements and one complete local and team evidence matrix. |

### Deferred

- Tailscale identity headers and any other private-network identity adapter;
- an embedded identity provider, passwords, passkeys, or email magic links;
- SCIM, directory sync, group-to-role mapping, and automatic member creation;
- self-service personal API-key issuance by non-administrator members;
- MCP OAuth for a generic browser-only OIDC provider;
- public sign-up, invitations sent by Artifact Server, and an organization
  switcher;
- automatic DNS changes or general certificate issuance for every DNS
  provider;
- a public Funnel deployment or a claim that VPN reachability is identity.

Teams may use Tailscale or another private network for reachability in the
first release. They still configure OIDC or WorkOS for browser identity and
still provide two valid HTTPS origins. A private-network-specific identity
adapter requires a separate specification and conformance tests.

## Access-mode contract

The runtime passes one required value to the HTTP and authentication adapters:

```ts
type AccessMode = "local_owner" | "private_team";
```

The value is selected by the entry point, not inferred from `Host`, forwarded
headers, the configured identity provider, or storage type.

| Entry point | Access mode | Storage |
| --- | --- | --- |
| `artifactserver start` | `local_owner` | SQLite and host filesystem |
| Managed service started by `artifactserver open` or `artifactserver connect` | `local_owner` | SQLite and host filesystem |
| `pnpm dev` backend | `local_owner` | SQLite and host filesystem |
| `artifactserver start-compact` | `private_team` | SQLite and attached filesystem |
| `artifactserver start-external-storage` | `private_team` | Postgres and configured object storage |
| Helm and direct-cloud runtime adapters | `private_team` | Their configured durable providers |

There is no public `ARTIFACT_SERVER_ACCESS_MODE=local_owner` override for a
team command. A remote entry point cannot be converted into local-owner mode by
setting an environment variable.

`artifactserver config check` and the non-secret support manifest report the
selected access mode. They never report a session token, local API credential,
identity-provider secret, or development-proxy secret.

## Local-owner mode

### Startup invariants

The direct local process starts only when all of these conditions are true:

- the listener is `127.0.0.1` or `::1`;
- the management origin is direct loopback HTTP;
- the content domain is `localhost`;
- no OIDC or WorkOS browser-login variables are configured;
- no remote trusted application origin is configured;
- the entry point selected `local_owner`.

The local command does not accept `0.0.0.0`, a LAN address, a tailnet address,
or a public hostname. A person who needs access from another device uses a
private-team entry point even when the process runs on their laptop.

### Public authentication context

The management origin exposes one unauthenticated, read-only endpoint:

```http
GET /auth/context
Cache-Control: private, no-store
```

Local-owner response:

```json
{
  "accessMode": "local_owner",
  "login": {"kind": "local_owner"}
}
```

Private-team response:

```json
{
  "accessMode": "private_team",
  "login": {"kind": "oidc"}
}
```

Both responses use `200 OK`. Requests from a content host receive `404`.
The only private-team `login.kind` values are `oidc` and `workos`. The endpoint
does not return an issuer URL, client ID, bootstrap email, admitted-member
state, installation credential, or deployment secret. Content hosts do not
serve this endpoint.

### Local session exchange

The browser creates a local owner session with:

```http
POST /auth/local-owner
Origin: http://127.0.0.1:8787
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
```

The request has no body, query, bearer credential, or cookie requirement. A
successful response is `204 No Content` and sets the ordinary application
session and CSRF cookies. It also sends `Cache-Control: private, no-store` and
`Referrer-Policy: no-referrer`.

The HTTP adapter calls a trusted application operation that finds or creates
the stable local administrator member and issues a normal application session.
The operation does not inspect addresses or headers. The HTTP and runtime
adapters establish the local trust boundary before calling it.

The route succeeds only when:

- the configured access mode is `local_owner`;
- the request host is exactly `localhost`, `127.0.0.1`, or `[::1]`, with the
  listener's port;
- `Origin` exactly matches the request origin;
- `Sec-Fetch-Site` is `same-origin`;
- `Sec-Fetch-Mode` is `cors` or `same-origin`;
- no `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
  `X-Forwarded-Proto`, or `X-Real-IP` header is present;
- the request did not arrive through an untrusted development proxy.

A DNS name that resolves to loopback does not qualify. The route returns a
`403 AUTHORIZATION_DENIED` response for missing or conflicting browser request
metadata. A request with a body returns `422 INVALID_INPUT`. The route returns
`404` in private-team mode so that the remote application does not advertise a
local login surface. Every failure creates no member, login attempt, or session
and clears no existing cookie.

### Local member and session behavior

The local principal keeps the current stable identity:

- display name: `Local administrator`;
- email: `local-administrator@artifactserver.invalid`;
- role: `administrator`;
- principal kind: `human`;
- installation: the current installation ID.

On the first exchange, the application creates this member only when the
installation has no members. Later browser profiles reuse the same member and
receive separate application sessions. If the local administrator is inactive,
or the installation contains members but no matching local administrator, the
exchange fails and names the operator recovery action. It never creates a
second administrator to bypass existing membership state.

Session cookies, CSRF cookies, expiry, storage digests, authentication caches,
authorization, attribution, and audit behavior remain unchanged. Clearing
cookies or reaching session expiry causes the browser to establish a new local
session on its next bootstrap attempt.

Logout is not an access boundary in local-owner mode because any process that
can open the loopback application is already inside the mode's trust boundary.
The web application hides the logout control and labels the principal `Local
owner`. The existing logout endpoint may revoke the current session, but the
next application bootstrap can create another one. To remove local access, the
user stops the server or runs a private-team deployment.

### Browser bootstrap behavior

The application starts these requests in parallel:

1. `GET /auth/context`;
2. `GET /api/v1/session`.

If the session request succeeds, the application continues normally. If it
returns `401` and the context is `local_owner`, the application calls
`POST /auth/local-owner` once, retries `GET /api/v1/session` once, and then
loads projects. It does not render a sign-in prompt during this exchange.

If the exchange fails, the application shows the returned request ID and a
local recovery message. It does not suggest OIDC login or tell the user to copy
a token.

The application repeats the same bounded recovery after a local session
expires. It never enters an infinite login or reload loop.

### `artifactserver open`

`artifactserver open` performs these steps:

1. find or start the managed local service;
2. verify that the service reports `local_owner`;
3. open its plain management origin in the system browser;
4. print the origin without a query credential.

It no longer reads the local browser-bootstrap credential or calls the current
two-step `/auth/local` token exchange. The existing credentialed exchange may
remain for one compatibility release and for explicit recovery tooling, but it
is disabled in private-team mode and is not used by the web application,
`artifactserver open`, documentation, or tests of the normal path.

### Vite development origin

The development frontend is a narrowly trusted local proxy, not a supported
deployment proxy.

`scripts/run-web-development.ts` creates an ephemeral random proxy credential
for each run and passes it to the backend and the Vite configuration through a
non-public environment value. Vite adds the credential only to its proxied
local-session exchange as `X-Artifact-Server-Development-Proxy`. The credential
is not placed in a `VITE_` variable, client bundle, URL, browser storage, log,
or diagnostic response.

The backend accepts this adapter only when it is in `local_owner`, both
processes are loopback-bound, and the proxy credential matches. Other proxies,
forwarded identity headers, and a missing or stale proxy credential fail. A
fresh browser profile can therefore open either `http://127.0.0.1:5173` or the
compiled local application origin and receive its own owner session.

Production runtime entry points do not configure or accept a development-proxy
credential.

## Private-team mode

### Startup contract

A private-team process reports ready only when all of these are configured and
valid:

- exactly one browser identity provider, generic OIDC or WorkOS;
- `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL`;
- an HTTPS `ARTIFACT_SERVER_ORIGIN`;
- a separate registrable `ARTIFACT_SERVER_CONTENT_DOMAIN`;
- the provider's complete required variable family;
- the storage and operational configuration required by the selected runtime.

Private-team mode rejects:

- absent browser identity configuration;
- both OIDC and WorkOS configuration;
- `ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN`;
- the generated compact browser-bootstrap credential as login authority;
- the legacy local installation bearer as HTTP API or MCP authority;
- an HTTP management origin;
- loopback as the advertised management or content domain;
- application and content hosts with the same registrable domain;
- a listener or proxy configuration that cannot enforce the trusted host
  boundary.

This requirement supersedes the no-provider startup behavior recorded in ADR
0020 for private-team entry points. An absent provider can still produce an
unavailable interactive-login service in application-layer tests, but a
private-team process cannot report ready in that state.

The storage runtime can continue to use internal deployment credentials that
are not request authority. Managed `as_key_` credentials and a compatible
external OAuth verifier are the only non-browser request authorities in
private-team mode.

`artifactserver init` for a new compact team installation records the
bootstrap administrator email and installation ID. It does not print a browser
login credential. Existing compact bootstrap files may remain on disk during a
migration, but private-team authentication ignores them.

### Browser identity and admission

The existing OIDC and WorkOS flows remain authoritative:

1. The provider verifies the external identity.
2. Artifact Server requires a usable email under the provider-specific rules.
3. With no members, only the verified bootstrap-administrator email can create
   the first member. That member receives the administrator role.
4. After the first member exists, an administrator must admit each teammate by
   normalized email and choose `administrator` or `member`.
5. A teammate's first successful provider callback binds the provider and
   subject to the admitted member and creates an Artifact Server session.
6. Later logins reuse that binding.

There is no just-in-time member creation after the first administrator. An
identity known to the provider but not admitted to Artifact Server receives no
session and creates no member record.

The private-team browser experience has these states:

| State | Browser result |
| --- | --- |
| No application session | Show one provider-neutral **Sign in** action. |
| Successful provider callback | Return to the validated application path and load the session. |
| Verified but unadmitted identity | Show that the account is not admitted and instruct the person to contact an installation administrator. |
| Deactivated member | Show that access has been removed. Do not offer local login. |
| Provider unavailable | Keep the installation signed out, show a retry action and request ID, and create no partial session. |
| Expired application session | Return to the team sign-in state. |
| Logout | Revoke the Artifact Server session, clear application cookies, and return to the team sign-in state. |

Authentication errors are rendered on the management origin. They do not put
authorization codes, tokens, provider responses, or raw exceptions in the URL,
page, logs, or telemetry.

### Members, roles, and deactivation

The existing permission model remains:

- admitted human members can work with artifacts in every installation
  project;
- only human administrators can admit and deactivate members or manage API
  keys;
- service principals act only through explicit capabilities.

Deactivating a member blocks new provider logins, application sessions, and
member-owned API keys. Same-process caches evict immediately. Other replicas
must refuse the member within the existing maximum authentication-cache
staleness window. The member's artifacts, actions, comments, and attribution
remain durable.

An administrator cannot deactivate the member represented by their current
session. The service also refuses any operation that would leave the
installation without an active administrator. An administrator who wants to
leave must first admit another administrator and have that administrator
perform the deactivation. Local-owner mode never permits deactivation of its
stable local administrator.

The first-release administration surface remains email-based admission. It
does not send an invitation email. The administrator communicates the server
URL through the team's normal channel.

### CLI, MCP, and automation

Browser OIDC does not make a generic identity provider an MCP authorization
server.

| Client | First-release authority |
| --- | --- |
| Browser | OIDC or WorkOS followed by an Artifact Server session |
| MCP or CLI against a compatible configured OAuth server | The existing browser OAuth flow and audience-bound access token |
| MCP or CLI against a generic OIDC-only team server | An administrator-issued, scoped user API key |
| CI and unattended agents | An administrator-issued, scoped service API key in the deployment's secret manager |

API-key secrets are returned once, never printed at startup, and never stored
in project files. The first release does not add member self-service key
issuance. A later change can add that behavior without changing the access-mode
boundary.

### Team ingress and content origins

A supported team installation has two externally resolvable boundaries:

```text
https://artifacts.example.com
https://<version-token>.artifacts-content.example.net
```

The example names use different registrable domains. The first host serves the
management application, login, callback, API, and MCP. The wildcard host serves
only the content bootstrap exchange and read-only artifact files.

The ingress must:

- terminate a valid certificate for the exact management host;
- terminate a valid wildcard certificate for the content domain;
- route both hosts to Artifact Server;
- preserve or overwrite `Host` and forwarded protocol according to the
  documented trusted-proxy contract;
- prevent direct public access to the backend listener;
- reject every other host before it reaches application or storage selection;
- preserve streaming, range, cookie, and cache headers;
- impose upload limits no smaller than the advertised Artifact Server limits.

Compose continues to support an operator-owned gateway. The release package
must include at least one tested copyable reference configuration using
pre-provisioned certificates. The Helm chart continues to reference existing
Ingress and TLS secrets. It does not install a DNS server, certificate
authority, identity provider, Postgres, or object store.

A tailnet-only deployment can route these names through private DNS and a
tailnet-reachable gateway. It still needs both names and certificates and uses
OIDC or WorkOS for Artifact Server identity. Tailscale Funnel and Tailscale
identity headers are outside this release scope.

## Shared security requirements

Both access modes preserve these rules:

- application sessions are opaque random credentials stored only as digests;
- application cookies are host-only, HttpOnly for the session, and never sent
  to content hosts;
- browser mutations require the existing CSRF, Origin, and Fetch Metadata
  checks;
- a local-owner session and a provider-created team session produce the same
  provider-neutral principal shape;
- every mutation records the effective principal and applicable authorizing
  human;
- content hosts expose no management, authentication, API, or MCP routes;
- request paths, hostnames, forwarded headers, tokens, and installation IDs
  never select raw storage locations;
- no credential appears in a normal browser URL, Referrer header, startup log,
  structured log, trace, support manifest, or diagnostic response.

## Configuration and packaging changes

| Surface | Change |
| --- | --- |
| Direct `start` | Hard-code local-owner mode and keep an exact-loopback listener. Refuse interactive-provider configuration. |
| `open` | Open the plain local origin. Stop minting a browser URL token. |
| `start-compact` | Select private-team mode and require one browser identity provider. |
| `start-external-storage` | Select private-team mode and require one browser identity provider. |
| Compact initialization | Stop returning a browser bootstrap credential for new team installations. |
| Runtime configuration summary | Add non-secret `accessMode`. |
| HTTP app dependencies | Add explicit access mode, login kind, and optional trusted development-proxy verifier. |
| Local runtime | Provide the trusted local-owner session operation and retain the hidden local API credential only for local CLI and MCP. |
| External-storage runtime | Disable local bootstrap and legacy local bearer authority. |
| Compose environment and documentation | Make provider, HTTPS origin, and wildcard content domain required. Add the tested ingress recipe. |
| Helm values and schema | Require one identity provider, remove local bootstrap as a supported secret, and validate both TLS hosts. |
| Browser API client | Add the authentication-context schema and local-session exchange. |
| Browser shell | Implement the bounded local-owner session exchange and mode-specific login and logout states. |
| Development runner and Vite proxy | Add the ephemeral server-side proxy credential without exposing it to browser code. |

## Migration behavior

### Existing direct local installations

Existing local databases, artifacts, members, local API credentials, and
application sessions remain valid. `artifactserver open` changes to the plain
origin. The old local browser-bootstrap file may remain for one compatibility
release and can then be removed by a separate migration.

If an existing local installation has a valid local administrator member, new
browser profiles reuse it. An inconsistent or deactivated local administrator
fails closed and requires an explicit repair command. Automatic local login
does not rewrite member state.

### Existing compact team installations

Before upgrading to the new team contract, an operator must:

1. configure OIDC or WorkOS;
2. verify that the configured bootstrap email matches the intended active
   administrator;
3. sign in and create any API keys needed to replace the legacy installation
   bearer;
4. run `artifactserver config check`;
5. test both management and wildcard content hosts.

An existing local-bootstrap-created administrator can bind to OIDC or WorkOS
through the existing verified-email match. Existing application sessions may
remain valid until their normal expiry. The bootstrap credential and legacy
installation bearer stop creating new authority in private-team mode.

Startup fails with a migration message when the team identity provider is
missing or a prohibited local credential is still configured as request
authority. It does not start in a partially compatible mode.

## Implementation order

Each work package ends with its named conformance tests. Later packages depend
on the behavior above them.

| Order | Work package | Completion condition |
| --- | --- | --- |
| 1 | Access-mode configuration | Every runtime entry point supplies a mode, `config check` reports it, and unsafe combinations fail before listening. |
| 2 | Local-owner session operation | The application service reuses or creates the stable local administrator and issues an ordinary session without locality logic. |
| 3 | HTTP authentication context and local exchange | The two endpoints match this specification and pass direct, hostile-header, host, mode, and cookie tests. |
| 4 | Browser bootstrap and local UI | Fresh, expired, and cleared-cookie profiles recover once without a sign-in screen; local logout is not presented. |
| 5 | CLI and development proxy | `artifactserver open`, the compiled origin, and Vite work without URL credentials; stale and forged proxy credentials fail. |
| 6 | Private-team enforcement | Team entry points require one provider and reject every local browser and legacy installation authority. |
| 7 | Team browser workflow | Real OIDC proves administrator bootstrap, admission, two roles, logout, denial, deactivation, and session behavior. |
| 8 | Team non-browser workflow | Managed user and service keys prove CLI, MCP, rotation, expiry, revocation, and least capability. |
| 9 | Packaging and ingress | Compact Compose, external-storage Compose, and Helm pass behind real TLS and wildcard routing. |
| 10 | Recovery and release evidence | Restart, backup, restore, upgrade, mobile browser, hostile ingress, and multi-replica revocation evidence is attached to the ledger. |

Before implementing Effect services or layers, the engineer must read
`node_modules/effect/AGENTS.md` completely as required by the repository.

### Repository work map

| Concern | Primary files or directories |
| --- | --- |
| Runtime mode and validation | `src/cli/main.ts`, `src/cli/lifecycle-commands.ts`, `src/lifecycle/runtime-configuration.ts`, `src/local/create-local-runtime.ts`, `src/external-storage/create-external-storage-runtime.ts` |
| Local principal and session lifecycle | `src/application/installation-access.ts`, `src/application/authentication.ts`, identity repository conformance tests |
| HTTP boundary and cookies | `src/http/create-http-app.ts`, local HTTP and conformance tests |
| Browser bootstrap and mode-specific UI | `apps/web/src/api/client.ts`, `apps/web/src/review/review-app.tsx`, Playwright fixtures and browser tests |
| Local open and development proxy | `src/cli/open-management-command.ts`, `scripts/run-web-development.ts`, `apps/web/vite.config.ts`, CLI and release-package tests |
| Team packaging and startup | `packaging/compose`, `packaging/helm/artifact-server`, compact, external-storage, and Helm release tests |
| OIDC team qualification | `tests/integration/oidc-keycloak.test.ts`, Keycloak runner, TLS and wildcard gateway fixture |
| Release records | `project/spec/conformance.yml`, evidence JSON files, product and operator documentation |

## Verification matrix

### Local-owner acceptance

- Start from an empty data directory and open the compiled application in a
  browser context with no cookies.
- Open the Vite origin in a different fresh browser context.
- Confirm both contexts receive separate sessions for the same stable local
  administrator member.
- Clear cookies, expire a session, reload a deep link, and observe one bounded
  automatic recovery without a sign-in prompt.
- Confirm normal CSRF and content-origin isolation on every mutation.
- Confirm `artifactserver open` opens a URL with no query or fragment.
- Confirm URLs, browser history, Referrer headers, logs, telemetry, and support
  output contain no local session or bootstrap credential.
- Refuse non-loopback binds, DNS aliases to loopback, forwarded headers,
  provider configuration, remote origins, missing browser metadata, and forged
  or stale development-proxy credentials.
- Confirm the local-owner route is absent in private-team mode.

### Private-team acceptance

The release test uses a real Keycloak process as generic OIDC, a real TLS
gateway, an exact management host, and a wildcard content host on a separate
registrable domain. It creates two human identities and one service principal.

The run must prove:

- first login admits only the configured bootstrap administrator;
- an unadmitted verified identity receives no member or session;
- the administrator admits a teammate as a member;
- the teammate signs in and uses artifacts but cannot administer members or
  keys;
- self-deactivation and deactivation of the last active administrator fail
  without changing membership or sessions;
- the administrator issues a least-capability service key and its secret is
  returned once;
- CLI or MCP uses the scoped key without a browser cookie or legacy bearer;
- logout revokes the current team session;
- member deactivation blocks provider login, sessions, and member-owned keys
  within the documented replica-cache bound;
- private multi-file content loads through the wildcard host and cannot reach
  management routes;
- hostile Host and forwarded-header requests cannot change routing, cookie,
  principal, installation, or storage scope;
- committed identities, sessions, keys, artifacts, versions, and bytes survive
  restart and the documented backup and restore path;
- the supported upgrade path preserves identity bindings and refuses an old
  local credential;
- the workflow passes on compact Compose, external-storage Compose, and a
  two-replica Helm installation;
- the management and private-content flows work in Chromium, Firefox, WebKit,
  and a physical iPhone Safari run before phone access is advertised.

The WorkOS path keeps its existing provider-specific tests. Generic OIDC
evidence cannot stand in for WorkOS token or MCP OAuth evidence, and WorkOS
evidence cannot stand in for the self-hosted OIDC team path.

## Conformance requirements

The ledger adds these requirements with `specified` status until their named
tests and evidence exist.

| ID | Requirement | Deployments |
| --- | --- | --- |
| `AUTH-023` | A fresh local browser establishes a normal stable local-owner session without a visible credential or sign-in step. | local |
| `AUTH-024` | Local-owner authority is available only through the exact loopback and trusted-development boundaries and fails closed for remote, proxied, or ambiguous requests. | local |
| `AUTH-025` | Private-team entry points require one browser identity provider and accept neither local browser bootstrap nor the legacy installation bearer as request authority. | single server, Kubernetes |
| `AUTH-026` | The browser discovers the access mode without secrets and follows the bounded local-owner or private-team login behavior. | local, single server, Kubernetes |
| `AUTH-027` | Deactivating a member stops that member's provider login, sessions, and member-owned keys within the cache bound while preserving attributed records. | single server, Kubernetes |
| `AUTH-028` | Membership administration cannot deactivate the current member or leave an installation without an active administrator. | local, single server, Kubernetes |
| `REL-007` | The first release is not declared until both the local-owner and private-team release gates pass. | local, single server, Kubernetes |

Existing `AUTH-001`, `AUTH-008` through `AUTH-022`, `DEP-005`, `DEP-006`,
`DEP-014` through `DEP-017`, `MCP-013`, `MCP-018`, `GATE-001`, `GATE-002`,
`REL-001`, `REL-002`, and `REL-006` remain part of the proof. This specification
does not mark any of them verified.
