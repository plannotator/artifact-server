# Deploy Artifact Server

Artifact Server supports local, single-server, Kubernetes, and managed-cloud deployments.

## Choose a deployment

| Deployment | Data layer | Detailed guide |
| --- | --- | --- |
| Cloudflare | D1 and R2 | [Cloudflare](../deploy/cloudflare/README.md) |
| Compact Compose | SQLite and one file volume | [Compose](../packaging/compose/README.md) |
| External-storage Compose | PostgreSQL and S3-compatible storage | [Compose](../packaging/compose/README.md) |
| Kubernetes | PostgreSQL and object storage | [Helm](../packaging/helm/artifact-server/README.md) |
| AWS | ECS, RDS, and S3 | [AWS Pulumi](../deploy/pulumi/aws/README.md) |
| Google Cloud | Cloud Run, Cloud SQL, and Cloud Storage | [Google Cloud Pulumi](../deploy/pulumi/gcp/README.md) |

## Configure the shared boundaries

Each remote deployment needs these boundaries:

1. Configure one HTTPS application origin.
2. Configure a separate wildcard content domain.
3. Configure WorkOS or one generic OIDC provider.
4. Admit team members through Artifact Server, or enable OIDC automatic admission.
5. Store service credentials outside source control.
6. Back up the database and artifact files.
7. Pin release deployments to an immutable image digest.

The application origin serves Artifact Server, its API, and its MCP endpoint. The content domain serves untrusted artifact files.

## Select storage

Compact Compose uses one SQLite database and one file volume. Run only one application process with this data layer.

External-storage deployments use PostgreSQL and object storage. These deployments support replaceable application processes and horizontal scaling.

## Configure authentication

Local-owner access works only on an exact loopback origin. Do not use it for remote access.

Remote deployments use WorkOS or a generic OIDC provider. Network access and application authorization remain separate controls.

### Admit members through OIDC browser login

By default, a successful identity-provider login still requires an active Artifact
Server membership. For an issuer that already restricts who may sign in, such as
Dex with a corporate-domain filter, set `ARTIFACT_SERVER_OIDC_AUTO_ADMIT=true` to
admit new browser users as normal members after OIDC token validation succeeds.
The switch accepts exactly `true` or `false` and defaults to `false`.

Leave `ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS` unset or empty to trust the
configured issuer's access restrictions. To restrict new registrations further,
set a comma-separated list such as `example.com,example.org`. Domains are trimmed
and lowercased, then matched against the complete email domain: `example.com`
does not accept `sub.example.com`, `otherexample.com`, or wildcard entries.

The domain list applies only to new automatic registrations. Explicitly admitted
members keep their roles and can sign in outside that list. A deactivated member
cannot regain access by changing the email attached to the same issuer and subject.
The first member still must be the configured bootstrap administrator; automatic
admission does not replace that bootstrap step or grant administrator privileges.
An explicitly unverified email remains denied. WorkOS, local-owner login, and MCP
bearer authentication keep their existing admission rules.

Both policy variables require a complete OIDC configuration, even when automatic
admission is disabled. Invalid switch values or malformed domain lists fail startup.
For Helm, use `identity.oidcAutoAdmit` and `identity.oidcAllowedEmailDomains`.

### Use a generic OIDC issuer for MCP

The issuer configured for browser login also protects `/mcp`. Agents present an
end-user access token, and the server records the person who obtained it. The
server never issues client credentials and never runs an authorization server of
its own.

The issuer must provide four things:

- an OpenID Connect discovery document at `<issuer>/.well-known/openid-configuration`;
- access tokens signed as JWTs with RS256 or ES256, verifiable against the
  published JWKS;
- the authorization code flow with S256 PKCE;
- an access token whose `aud` contains the exact `<ARTIFACT_SERVER_ORIGIN>/mcp`.

The audience is the one step an operator must configure. Providers do not bind a
resource URL on their own. In Keycloak, add a client scope with an audience
mapper whose included custom audience is that exact URL, and assign the scope to
the client the agents use. Okta sets the audience on a custom authorization
server. A provider that supports RFC 8707 resource indicators can bind it per
request instead.

Microsoft Entra ID cannot protect `/mcp` this way. Its v2.0 access tokens name
the API's client ID in `aud`, not a URL, and its userinfo endpoint accepts only
Microsoft Graph tokens. Entra installations keep browser login and use API keys
for MCP.

On first use, the token or the issuer's userinfo response must carry the
person's `email` with `email_verified: true`. A person who already signed in
through the browser is recognized by issuer and subject and needs neither.

Register the client the agents use in one of two supported ways:

- the issuer offers RFC 7591 dynamic client registration, its discovery document
  advertises `registration_endpoint`, and each client registers itself;
- an administrator registers one client in the issuer and gives its client ID to
  the agents that need it.

Artifact Server publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` naming the issuer, and answers an
unauthenticated MCP request with `401` and a `resource_metadata` challenge, so a
compliant client finds the issuer without further configuration.

Clients that cannot complete OAuth keep using administration-issued API keys.
Tokens that name another resource are refused. ID tokens and other JWTs that are
not access tokens are refused too: a JOSE `typ` other than `at+jwt` or `JWT`,
or an ID-token claim such as `nonce` or `at_hash`.

The server reads the issuer's discovery document once at startup. If the issuer
cannot be reached then, the server logs a warning and starts with browser login
and API keys only. MCP OAuth stays off until the next restart.

## Back up the installation

Back up metadata and artifact files as one coordinated recovery set. Use the procedure in the selected deployment guide.

Do a restore test before the first production release. Then repeat the test after a storage or deployment change.
