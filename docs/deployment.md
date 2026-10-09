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
4. Admit team members through Artifact Server.
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

A provider that cannot bind the URL can name a different audience instead. Set
`ARTIFACT_SERVER_OIDC_MCP_AUDIENCE` to the exact value its access tokens carry;
it then replaces `<ARTIFACT_SERVER_ORIGIN>/mcp`. Set
`ARTIFACT_SERVER_OIDC_MCP_SCOPES` to the scopes a client must request for such
a token, and the server advertises them in its protected-resource metadata.

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

### Use Microsoft Entra ID

Entra ID works for browser login and for `/mcp` with one app registration that
represents Artifact Server:

1. Register a single-tenant web application. Add the redirect URI
   `<ARTIFACT_SERVER_ORIGIN>/auth/callback`, create a client secret, and in the
   manifest set `api.requestedAccessTokenVersion` to `2`
   (`accessTokenAcceptedVersion` in the older manifest format).
2. Under **Expose an API**, set the Application ID URI to exactly
   `<ARTIFACT_SERVER_ORIGIN>/mcp` and add a delegated scope, for example
   `access`. MCP clients send that URL as the RFC 8707 `resource` parameter, and
   Entra refuses a `resource` that does not match the scope's application
   (`AADSTS9010010`). An HTTPS Application ID URI must use a domain verified in
   the tenant.
3. Configure the issuer and the Entra-specific values:

   ```sh
   ARTIFACT_SERVER_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   ARTIFACT_SERVER_OIDC_CLIENT_ID=<application-client-id>
   ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
   ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM=oid
   ARTIFACT_SERVER_OIDC_MCP_AUDIENCE=<application-client-id>
   ARTIFACT_SERVER_OIDC_MCP_SCOPES=<ARTIFACT_SERVER_ORIGIN>/mcp/access
   ```

   Entra v2.0 access tokens always name the client ID in `aud`. Its `sub` differs
   for every app registration, while `oid` identifies the person across the
   tenant, so a later move to another registration keeps every membership.
   Choose the subject claim before the first login: changing it later creates
   new bindings.
4. Entra offers no dynamic client registration. Give agents the client ID, and
   add each client's loopback redirect URI to the app registration. For Claude
   Code, for example:

   ```sh
   claude mcp add --transport http --client-id <application-client-id> \
     --client-secret --callback-port 33418 artifact-server <ARTIFACT_SERVER_ORIGIN>/mcp
   ```

   with `http://localhost:33418/callback` registered as a web redirect URI.

Entra access tokens carry no `email` and no `email_verified`, and its userinfo
endpoint accepts only Microsoft Graph tokens. A person is therefore recognized
on `/mcp` after signing in through the browser once; a first contact through
MCP alone is refused by the admission rules above.

## Back up the installation

Back up metadata and artifact files as one coordinated recovery set. Use the procedure in the selected deployment guide.

Do a restore test before the first production release. Then repeat the test after a storage or deployment change.
