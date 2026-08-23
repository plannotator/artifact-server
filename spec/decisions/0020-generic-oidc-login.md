# 0020: Generic OIDC browser login

**Status:** Accepted
**Date:** August 18, 2026

## Decision

Artifact Server browser login accepts any spec-compliant OpenID Connect
provider. A second implementation of the existing interactive identity port,
`OidcIdentityProvider`, sits beside the WorkOS plug. The port, sessions, CSRF,
admission, members, API keys, and the deployment token do not change. OIDC only
answers who a person is; explicit member admission still decides whether they
may enter.

An installation selects its browser-login provider by configuring one variable
family. `ARTIFACT_SERVER_OIDC_ISSUER`, `ARTIFACT_SERVER_OIDC_CLIENT_ID`, the
optional `ARTIFACT_SERVER_OIDC_CLIENT_SECRET` or its `_FILE` form, and the
optional `ARTIFACT_SERVER_OIDC_SCOPES` are loaded all-or-nothing, exactly like
the WorkOS variables. Configuring both families fails startup. Configuring
neither keeps today's behavior: browser login is unavailable, and local login
and API keys still work.

```text
Artifact Server installation
└── One browser-login provider
    ├── WorkOS AuthKit          (hosted flavor)
    └── Generic OpenID Connect  (self-host flavor)
```

The login itself is the ordinary authorization-code flow. Discovery is lazy and
cached, the discovery document's issuer must normalize back to the configured
issuer, and every discovered endpoint must be an HTTPS URL with no credentials
and no fragment. Plain `http` is accepted only for `localhost`, `127.0.0.1`,
and `::1`, so a developer can run an issuer on a laptop. The redirect is always
`<ARTIFACT_SERVER_ORIGIN>/auth/callback`; nothing caller-supplied reaches it.
The request carries S256 PKCE, the existing single-use digested state, and a
nonce. The token exchange is form-encoded, sends the client secret only when one
is configured, and must return an `id_token`. The id_token is verified against
the discovered JWKS for the discovered issuer and the configured client, with a
fixed thirty-second clock tolerance for self-hosted clock drift, and its nonce
must equal the nonce stored on the login attempt.

The nonce is the one real change to the shared seam. Login attempts gain a
nullable nonce in every identity repository, and the port carries it through
`start` and `complete`. WorkOS accepts and ignores it. The column arrives as an
additive migration in each backend: SQLite schema 5 to 6, Postgres 4 to 5, and
D1 3 to 4.

Artifact Server uses the Workspaces OIDC vocabulary. Issuer, client ID, client
secret, and scopes mean here what `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and `OIDC_SCOPES` mean there, and the issuer
normalization, discovery validation, PKCE, nonce, and claim rules are the same
rules. The value taken from Workspaces is the shared model and vocabulary only.

A verified identity is `sub` plus a required non-empty `email`, with a display
name taken from `name`, else `given_name` and `family_name`, else the email.
The durable member binding is `oidc:<normalized issuer>` paired with `sub`,
because a subject is unique only inside its issuer. Changing issuer therefore
stops matching old bindings by design; login then falls through to the existing
active-member email match, which rebinds the member to the new issuer identity.
No data migration exists for an issuer change.

The provider uses only `fetch` and `jose`, so it runs on every deployment: local,
one server, Compose, Kubernetes, the direct clouds, and the Cloudflare Worker.
Typed configuration surfaces cover local, single server, Compose, Helm, and the
Cloudflare Worker. The direct-cloud Pulumi packages (`deploy/pulumi/aws`,
`deploy/pulumi/gcp`) expose typed inputs for WorkOS only today; OIDC still runs
there through container environment variables, and typed Pulumi OIDC inputs are
a scoped follow-up, not part of this change.

## Recorded decisions

### An absent `email_verified` claim means verified

Only an explicit `email_verified: false` refuses the login, and the existing
admission gate does the refusing. There is no escape-hatch variable. This is an
open-source self-host path, so it must work out of the box with every mainstream
identity provider, with no extra configuration and no invented guardrails. The
operator already declared this issuer the trust anchor by configuring it;
requiring a claim that Microsoft Entra and several Keycloak realms omit would
break those installations for nothing. An issuer that explicitly disavows an
address is a different statement, and honoring it costs nothing.

### No mode refusals

Nothing blocks a self-hosted installation from using WorkOS, and nothing blocks
a hosted deployment from using generic OIDC. The documentation states the
typical pairing, WorkOS for the Plannotator-hosted service and OIDC for
self-host, and the software refuses neither. The only refusal is configuring
both at once. Anyone already using WorkOS keeps using it unchanged.

### Signing out stays local

Signing out revokes the Artifact Server session only. That is the normal
behavior for an application connected to a single sign-on provider. RP-initiated
logout at the identity provider is a small later addition if a customer's
security team asks for it; discovery already reads the document that advertises
the end-session endpoint.

## What stays excluded

- MCP OAuth. The MCP bearer path needs an authorization server that clients can
  register against and whose tokens it can introspect. A bare enterprise
  identity provider is generally not that server, so MCP authorization stays
  WorkOS-only and OIDC installations use administration-issued API keys, which
  already work everywhere.
- Directory sync, SCIM, role and group mapping, and provisioning beyond the
  existing bootstrap-administrator rule. Admission stays explicit.
- Refresh tokens and `offline_access`. Sessions are server-side records with
  their own lifetime, and the id_token is used once at login.
- A cookie secret. Workspaces needs one because its session is a stateless
  signed cookie; Artifact Server sessions are server-side records with digested
  tokens, so there is no new secret to manage and no variable to port.

## Rejected alternatives

### Keep WorkOS as the only browser login

A customer who already runs Okta, Microsoft Entra, Google Workspace, or
Keycloak would have to buy and operate a second identity product to let their
own people sign in to their own self-hosted server.

### Introduce an authentication-mode variable

A mode variable is a second source of truth that can disagree with the
credentials actually present. The presence of one variable family already names
the provider, absence of both already means what it means today, and the
mutual-exclusion check catches the only ambiguous case.

### Invent a separate OIDC vocabulary

Two products describing the same protocol with different words creates
translation work at every boundary and in every support conversation. Borrowing
the Workspaces names and rules costs nothing here.

### Bind members by subject alone

Subjects are unique only inside their issuer, so a bare subject would let two
issuers collide on one member record. The issuer-qualified binding also gives an
issuer migration a safe, self-healing path through the verified email match.

### Derive the nonce from the stored PKCE verifier

This avoids a column by hashing a value that exists for another purpose. A
nullable nonce column is boring, auditable, and additive in all three identity
repositories.

### Require `email_verified` to be present and true

This is the strictest reading of the claim, and it refuses logins from
mainstream identity providers that never send it. The recorded decision above
takes the industry-standard posture instead.
