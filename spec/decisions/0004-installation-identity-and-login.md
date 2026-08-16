# ADR 0004: Installation-owned identity and login adapters

Status: accepted

## Context

One Artifact Server installation represents one closed group: one person or one
team. The installation must work on a laptop without a hosted identity service,
on a private network with local accounts or an existing identity provider, and
as a hosted service with WorkOS AuthKit. Plannotator may connect one
organization to the installation and pair its projects with Artifact Server
projects. Plannotator's user accounts, workspace records, and workspace
permissions are not copied into Artifact Server's authorization model.

Authentication and authorization are separate decisions. A login provider can
prove which person returned from a browser login. Only Artifact Server can decide
whether that person was admitted to this installation and what they may do.

## Decision

Artifact Server stores its own installation members, browser sessions, and API
keys. Every supported credential is converted once into the provider-neutral
`Principal` already used by the application services.

The first member can be created only through an installation bootstrap:

- local mode accepts a high-entropy token on a loopback request and creates the
  configured local administrator;
- hosted mode accepts the configured bootstrap administrator email only after a
  successful external login;
- after the first member exists, external login succeeds only for a pre-admitted
  email or an identity already bound to a member.

There is no public sign-up, organization switcher, or automatic import of
provider organizations. Administrators explicitly admit and deactivate members.
Every active member may read and manage artifacts in the installation's
projects. Service principals act only through explicit capabilities.

Browser sessions are opaque random credentials stored only as SHA-256 digests.
The application session cookie is host-only, HttpOnly, Secure outside loopback,
and SameSite=Lax. Browser mutations also require a matching CSRF token, an exact
application origin, and same-origin Fetch Metadata. Published-content hosts do
not expose application, authentication, or callback routes.

Managed API keys are opaque credentials with an unmistakable prefix. The server
stores only a digest, returns the secret once, and records a name, expiration,
explicit capabilities, issuer, revocation, and rotation. Managed-key parsing and
the legacy local token verifier are separate dispatch paths; a failed managed key
never falls through to another verifier.

Interactive login is an application port. The WorkOS adapter owns WorkOS SDK
calls and PKCE. A successful callback returns only an external subject, verified
email, and display name to the identity service. Artifact Server then applies its
local admission policy and issues its own application session. WorkOS tokens and
cookies never reach artifact storage or application services.

Bearer verification has a separate deployment port. Managed Artifact Server
keys are parsed first and never fall through. The local installation token is
checked second. A deployment may then configure one compatible external
access-token verifier, which must return the same provider-neutral principal.
Artifact Server does not treat an arbitrary OpenID Connect ID token or browser
session token as API authority.

For the hosted product, Artifact Server uses a dedicated WorkOS environment with
its own client ID, API secret, redirect URIs, users, and grants. Plannotator
Workspaces staging and production environments are never reused.
AuthKit self-sign-up is disabled in every Artifact Server environment. WorkOS
may know additional users, but Artifact Server still rejects any verified person
who is not admitted to the installation.

The checked-in example contains names only. WorkOS API keys, browser sessions,
bootstrap tokens, and managed API-key secrets stay in deployment secrets or
local mode-`0600` files and never enter source control.

## Consequences

- Local, private-network, and hosted deployments share one authorization model.
- Changing login providers does not change project or artifact identity.
- A customer can later connect Plannotator without migrating artifact identity or
  replacing the customer's Artifact Server login.
- Disabling an installation member immediately blocks new sessions and API use,
  regardless of whether the external identity provider still recognizes them.
- Artifact Server must back up identity records together with artifact metadata.
- Hosted deployments must configure a public application origin and exact WorkOS
  callback URI before interactive login can be enabled.
