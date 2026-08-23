# 0025: Local owner and private team access are separate first-release modes

- **Status:** Accepted
- **Date:** 2026-08-23

## Decision

Artifact Server will ship two first-release access modes: **local owner** and
**private team**. Both are launch requirements. They share the same product
authorization model, but they have different trust boundaries and onboarding
flows.

| Mode | Intended use | Identity entry point | First-use experience |
| --- | --- | --- | --- |
| Local owner | One developer using Artifact Server on their own machine | Exact-loopback access on the host | Opening the local app establishes an owner session without a sign-in step |
| Private team | A self-hosted installation used by teammates and agents | Configured OIDC or WorkOS login, with an optional trusted private-network adapter | Each admitted teammate signs in with their own identity |

These are access modes, not storage modes. Local owner normally uses the
host-filesystem and SQLite composition. A private team can use either the
compact single-server composition or the external-storage composition.

### Local owner removes the login ceremony, not the security model

A direct request to an exact-loopback local installation may establish a
normal Artifact Server session for the local owner automatically. The session
maps to a stable local administrator principal and continues to use the normal
session, CSRF, authorization, attribution, and audit paths.

The local browser must not require the user to copy a token, run a separate
sign-in command, or depend on a particular browser profile. Opening the local
application URL is sufficient.

Implicit local-owner access is valid only when all of these conditions hold:

- the management server is bound to an exact loopback address;
- the configured application origin is local;
- the request arrives directly, without a reverse proxy or forwarded identity;
- the installation is explicitly running in local-owner mode.

The process must refuse an unsafe local-owner configuration instead of
silently weakening these conditions. A shared machine, a non-loopback bind, a
remote browser, or a proxied deployment must use private-team authentication.

Local-owner mode does not remove principals or make authenticated and
unauthenticated code paths equivalent. It only supplies the owner identity at
the trusted local boundary.

### Private team is a day-one deployment, not a later enterprise add-on

A team must be able to deploy Artifact Server remotely, authenticate multiple
people, and use the same installation without sharing credentials.

The private-team baseline includes:

- an HTTPS management origin;
- a separate wildcard content origin with matching DNS, certificate, and
  routing;
- configured browser identity through generic OIDC or WorkOS;
- a verified bootstrap administrator;
- explicit admission of teammates;
- one Artifact Server session and principal per person;
- administrator and member roles;
- member deactivation and session revocation;
- scoped credentials for non-browser clients;
- backup, restore, upgrade, and health procedures for the supported deployment
  shapes.

There is no public sign-up, invitation marketplace, or multi-organization
switcher in the baseline. The first administrator admits teammates to the
installation. The identity provider proves who a person is; Artifact Server
decides whether that identity is admitted and what it can do.

Browser login must not be reused as API authority. CLI and MCP clients use a
compatible OAuth flow where the configured provider supports the required
contract. Otherwise they use administrator-issued, scoped user or service
credentials. A team installation must not rely on a shared bootstrap token or
credentials copied from server logs for normal operation.

### Private networking is an optional ingress, not the authorization model

Tailscale or another private network can reduce deployment exposure and may
provide a verified user identity through a trusted adapter. Network
reachability by itself does not grant Artifact Server access.

An adapter that accepts identity from a private-network proxy must have its own
explicit ingress boundary. It must not proxy through the listener that grants
implicit local-owner access, because the proxy's loopback connection is not
proof that the end user is the local owner.

Private-network support does not replace the remote content-origin contract.
A phone or another machine still needs resolvable management and wildcard
content hostnames, valid certificates, and routing for both origins.

### The two-origin sandbox remains mandatory in both modes

Authentication convenience must not weaken artifact isolation.

- Local owner uses the management origin and `*.localhost` content origins.
- Private team uses the management origin and a distinct wildcard content
  domain.
- Untrusted artifact bytes are never served from the management origin as a
  path-based shortcut.

### Local and team behavior need separate release evidence

Local-owner evidence must prove automatic access in a fresh browser profile,
normal session and CSRF behavior, stable attribution, and refusal of unsafe
bind, origin, and proxy configurations.

Private-team evidence must exercise a real identity provider and at least two
human identities plus a non-browser client. It must cover bootstrap,
admission, login, authorization, deactivation, session revocation, private
artifact delivery, scoped client credentials, restart, backup, restore, and
upgrade behavior behind real TLS and wildcard routing.

The compact server deployment and the external-storage or Kubernetes
deployment can have separate operational evidence. Neither deployment shape
may claim private-team readiness from configuration parsing alone.

## Consequences

- The current token-to-browser `open` flow can remain a compatibility or
  recovery tool, but it is not the primary local browser experience.
- Local development must behave consistently across browser profiles because
  each profile establishes its own normal local-owner session.
- Deployment documentation must ask operators to choose an access mode
  explicitly. The word "local" must not also mean "remotely reachable from one
  person's laptop."
- Existing release and conformance entries must be reconciled so private-team
  support is a first-release requirement rather than optional later work.
- Team packaging must document the complete ingress contract, including the
  management hostname, wildcard content hostname, DNS, TLS, proxy trust, and
  identity-provider configuration.

## Follow-up specification and proof

These items remain to be specified or proved. They are not decided by this
record:

- the exact HTTP exchange used to establish a local-owner session;
- the recovery and logout behavior while implicit local-owner mode is enabled;
- whether admitted members can issue and rotate their own personal API keys;
- the pairing experience for CLI and MCP clients that cannot use browser OAuth;
- the first supported Tailscale or other private-network identity adapter;
- how much remote ingress setup is automated by Compose and Helm;
- the conformance requirement IDs and migration of existing release-ledger
  entries.

## Rejected alternatives

### Disable authentication locally

Rejected because it creates a second product logic path without principals,
CSRF protection, attribution, or auditable sessions. Local convenience should
come from a trusted identity boundary, not from removing authorization.

### Treat every loopback connection as the owner

Rejected because reverse proxies also connect over loopback. Local-owner trust
requires a direct listener with configuration checks, not an address check in
shared request handling.

### Treat VPN membership as Artifact Server membership

Rejected because private-network access and product authorization answer
different questions. The network can deliver a verified identity, but Artifact
Server still owns admission, roles, revocation, and audit.

### Require a hosted identity vendor for every team

Rejected because self-hosted teams need a generic OIDC path. WorkOS remains a
supported provider, not a deployment prerequisite.

### Serve remote artifact content under the management hostname

Rejected because it breaks the two-origin sandbox and makes untrusted content
part of the management application's authority.

### Defer private-team support until after the initial release

Rejected because a remotely deployed installation with individual teammate
authentication is part of the day-one product contract.
