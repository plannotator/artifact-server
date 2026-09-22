# 0028: MCP OAuth through the configured OIDC issuer

**Status:** Accepted
**Date:** September 14, 2026

Supersedes the "MCP OAuth" exclusion recorded in
[0020: Generic OIDC browser login](0020-generic-oidc-login.md).

## Decision

An installation that configures a generic OIDC issuer for browser login now
also accepts end-user access tokens from that issuer at `/mcp`. A second
implementation of the existing `ExternalMcpBearerVerifier` port,
`OidcMcpBearerVerifier`, sits beside the WorkOS one. Managed API keys keep
working and are still checked first, so nothing an installation already uses
changes.

0020 excluded this on the reading that a bare enterprise identity provider is
not an authorization server MCP clients can register against. Keycloak, Entra,
Okta, and Auth0 all publish `/.well-known/openid-configuration`, most of them
offer dynamic client registration, and an MCP client that reads RFC 9728
protected-resource metadata reaches the issuer on its own. What the exclusion
actually costs is real: without it every agent on a self-hosted installation
shares one API key, and the server records one author for everyone behind it.

## What it does

Startup fetches the issuer's OIDC discovery document, validates it, and keeps
three things: the JWKS URI, the userinfo endpoint, and the document itself. The
document is served back at `/.well-known/oauth-authorization-server`, and
`/.well-known/oauth-protected-resource/mcp` names the issuer as the
authorization server for the `<origin>/mcp` resource. An unauthenticated MCP
request answers 401 with `resource_metadata`, which is the whole handshake an
MCP client needs.

A presented token is verified against the discovered JWKS: signature, RS256 or
ES256, exact issuer, audience, expiry, and a non-empty subject, with the same
thirty-second clock tolerance browser login uses. The member binding is
`oidc:<normalized issuer>` paired with `sub`, the same binding browser login
writes, so one person keeps one membership whichever way they arrive.

Identity on first use comes from the token's own `email`, `name`,
`given_name`, `family_name`, and `preferred_username` claims. An installation
whose access tokens carry no email falls back to the discovered userinfo
endpoint, called once with the presented token. Both paths end at the existing
admission gate, which still decides who may enter.

## Recorded decisions

### The audience is the MCP URL, and nothing else

`aud` must contain `<ARTIFACT_SERVER_ORIGIN>/mcp`, per the MCP specification,
and there is no setting that accepts a different value. Membership in a
multi-valued `aud` is enough: Keycloak names `account` beside the requested
audience, and refusing that would refuse Keycloak. Binding the resource URL is
the operator's step, through an audience mapper or an RFC 8707 resource
indicator, and the deployment guide says so.

### An ID token is not an MCP credential

MCP-013-F requires that an ID token cannot substitute for an MCP credential.
Audience binding refuses most ID tokens, because their `aud` is a client ID.
It does not refuse them when an operator names a client after the resource
URL, so the verifier also refuses a JWT that is typed or shaped as something
other than an access token:

- a JOSE header `typ` that is present and is not `at+jwt` or `JWT`, compared
  case-insensitively with an optional `application/` prefix. RFC 9068 `at+jwt`
  is the preferred type; `JWT` and a missing header stay accepted because
  Keycloak and many other issuers still send them. This refuses logout tokens,
  security event tokens, and ID-JAG assertions from the same issuer;
- a payload that carries `nonce`, `at_hash`, or `c_hash`, which OIDC defines
  for ID tokens only;
- a payload `typ` of `ID`, which Keycloak writes into its ID tokens.

The MCP specification itself only requires OAuth 2.1 resource-server
validation and audience binding. These checks follow RFC 9068 section 4 and
the explicit-typing advice of RFC 8725 so that the ledger promise holds for
every issuer, not only Keycloak.

### An access token's email must be verified before it links a member

Browser login treats a missing `email_verified` claim as verified, and
decision 0020 keeps that rule. The MCP path does not: an access token, or the
userinfo profile it falls back to, must carry `email_verified: true` before its
email can link the token to an admitted member or claim the bootstrap
administrator on a fresh installation. Otherwise the admission gate refuses it.

The paths differ because their risks differ. Access-token profile claims are
often configurable fields, not verified addresses. Entra's optional `email`
claim, for example, is mutable and arrives with no `email_verified` claim. On
this path the first presented token can bind the bootstrap administrator, and
any client registered at the issuer, including a dynamically registered one,
can present such a token. A subject that is already bound, by an earlier browser login or MCP
token, is recognized by `oidc:<issuer>` and `sub` alone and needs no email.

### An issuer that cannot serve its keys is unavailable, not a bad token

A key-set response that is not 200 arrives from `jose` as a generic error, which
would otherwise read as an invalid token and answer 401. The key-set fetch
therefore raises its own failure, and the endpoint answers with a provider
failure instead of blaming the credential.

### Discovery runs at startup, and a down issuer only turns MCP OAuth off

The protected-resource document cannot be served without the discovery
document, so it is read once at startup, like the WorkOS path reads its
authorization-server metadata. Unlike that path, a discovery failure is not
fatal: the process writes one warning to stderr and starts with browser login
and managed API keys, which is exactly the behavior an installation had before
this change. An identity provider that is briefly down must not take the
artifact server down with it, and browser login keeps its own lazy discovery
anyway.

### The credential travels to identity resolution

`resolveIdentity` now receives the credential beside the verified claims. The
WorkOS implementation ignores it and reads its own API. The OIDC implementation
needs it, because an issuer's userinfo endpoint answers the presenter of the
token, not a server credential.

### Client registration belongs to the issuer

The installation registers one client, or the issuer offers RFC 7591 dynamic
registration and clients register themselves. Artifact Server advertises
whatever `registration_endpoint` the issuer publishes and issues no client
credentials of its own, which keeps MCP-014 intact: no embedded authorization
server appears here.

## What stays excluded

- OAuth on the HTTP API. `apiOAuthResource` and `externalApiBearerVerifier`
  stay unset, so `/api/` keeps accepting managed API keys only. Advertising an
  authorization server for a resource that cannot accept its tokens would be a
  false promise.
- Scope checks. The resource-bound audience grants MCP access, matching the
  rule MCP-011 already records for WorkOS.
- Dynamic client registration by Artifact Server. The issuer owns registration;
  Artifact Server only points clients at it.

## Rejected alternatives

### Keep MCP on API keys for OIDC installations

This is the status quo 0020 recorded. It gives every agent the same identity,
makes revocation all-or-nothing, and puts a long-lived shared secret into every
client configuration, including gateways that forward other people's requests.

### Cache the profile claims from `verify` for `resolveIdentity` to read

This avoids the port change by keeping token claims in a map between two calls
of the same request. It adds a cache with an eviction policy, a race, and a
failure mode that only appears under load, to avoid passing a value that the
caller already holds.

### Accept any audience and rely on the issuer check

An access token minted for another service in the same realm would then open
this one. Audience binding is the property that makes a resource server safe to
point several clients at.
