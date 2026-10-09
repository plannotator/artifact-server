# 0029: OIDC provider claim mapping for Microsoft Entra ID

**Status:** Accepted
**Date:** October 8, 2026

Amends "The audience is the MCP URL, and nothing else" in
[0028: MCP OAuth through the configured OIDC issuer](0028-oidc-mcp-oauth.md).

## Decision

A generic OIDC installation can now name three provider-specific facts that
were fixed before, each through one optional variable whose default keeps
today's behavior:

| Variable | Default | What it changes |
| --- | --- | --- |
| `ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM` | `sub` | The ID-token and access-token claim that binds a person to a member |
| `ARTIFACT_SERVER_OIDC_MCP_AUDIENCE` | `<origin>/mcp` | The one `aud` value an MCP access token must contain |
| `ARTIFACT_SERVER_OIDC_MCP_SCOPES` | none | The scopes advertised as `scopes_supported` in the MCP protected-resource metadata |

Discovery also stops refusing an issuer that leaves
`code_challenge_methods_supported` out. An issuer that lists its methods
without `S256` is still refused, and both browser login and MCP clients always
send `S256`.

All three variables belong to the `ARTIFACT_SERVER_OIDC_*` family, so they take
part in the all-or-nothing and WorkOS-exclusion checks like the existing ones.

## Why

Microsoft Entra ID is the identity provider of many companies that would run
Artifact Server as a private-team installation, and 0028 recorded that it
"cannot protect `/mcp` this way". Tested against a real Entra tenant with
Claude Code as the MCP client, four facts stood in the way, and each maps to
one change:

1. **Discovery omits the PKCE methods.** Entra supports S256 but its v2.0
   discovery document has no `code_challenge_methods_supported`, so startup
   turned MCP OAuth off with "OIDC discovery does not advertise S256 PKCE".
2. **`aud` is the API's client ID.** Entra v2.0 access tokens always name the
   resource application's client ID in `aud`, never a URL, whatever the
   client requested.
3. **Clients must ask for the API's own scope.** Without one, Entra issues a
   Microsoft Graph token that no third party can verify. An MCP client learns
   which scope to request from `scopes_supported`, which this server did not
   publish.
4. **`sub` is pairwise per app registration.** The same person has a different
   `sub` for every application, while `oid` is stable across the tenant. An
   installation that moves to a new app registration, or splits browser and
   MCP into two, would otherwise orphan every member binding.

One fact needs no code. An MCP client sends the protected resource URL as the
RFC 8707 `resource` parameter, and Entra refuses a `resource` that does not
match the requested scope's application (`AADSTS9010010`). The fix is on the
Entra side: the API's Application ID URI is set to `<origin>/mcp`, so the
scope reads `<origin>/mcp/<scope>` and matches. The deployment guide records
this step.

With these changes, Claude Code completed browser approval against Entra
(authorization code with S256 PKCE, a pre-registered client, and the
`resource` parameter) and called `/mcp` as the member who signed in through
the browser. That is the browser-approval half of MCP-013-B that the ledger
listed as unproved for a generic OIDC issuer.

## Recorded decisions

### The configured audience replaces the resource URL

When `ARTIFACT_SERVER_OIDC_MCP_AUDIENCE` is set, it is the only accepted
audience; `<origin>/mcp` is no longer accepted beside it. Accepting both would
widen the resource server to tokens minted for a second audience nobody
configured. Membership in a multi-valued `aud` is still enough, as 0028
records for Keycloak.

The protected-resource metadata keeps naming `<origin>/mcp` as the resource.
MCP clients compare it with the URL they connected to and refuse a mismatch,
so only the verified audience changes, not the advertised resource.

### An ID token stays refused when it shares the audience

With the client ID as the MCP audience, an ID token issued to the same client
carries the same `aud`. 0028 already refuses any JWT typed or shaped as an ID
token (`nonce`, `at_hash`, `c_hash`, payload `typ` of `ID`), and Entra ID
tokens always carry `nonce` for this flow. AUTH-029-F proves the refusal with
the configured audience.

### The subject claim applies to both paths at once

One variable sets the claim for browser login and for MCP tokens, because the
binding `oidc:<issuer>` plus subject must match whichever way a person
arrives. A token or ID token without the configured claim, or with a blank
one, names nobody and is refused. The userinfo fallback still compares the
userinfo `sub` with the access token's own `sub`, because userinfo answers
with `sub` whatever claim binds the person here.

Changing the claim on an installation that already has members creates new
bindings on the next login. The deployment guide says to choose it before the
first login.

### No email fallback

Entra access tokens carry no `email` and no `email_verified`. This decision
does not map `preferred_username` to an email address. 0028's rule stands: an
access token must carry a verified email before it can link a member or claim
the bootstrap administrator. A person who signed in through the browser once
is recognized on the MCP path by issuer and subject alone, which is the normal
case for an installation whose members sign in to the interface first.

## What stays excluded

- Cloudflare. Its worker has no generic OIDC MCP path, and its deployment
  contract does not carry these variables yet.
- Any Entra-specific code path or provider name. The variables are generic;
  Entra is the case that motivated them.

## Rejected alternatives

### Advertise the client ID as the protected resource

MCP clients refuse protected-resource metadata whose `resource` does not match
the server URL they connected to, so this breaks every compliant client.

### Accept `<origin>/mcp` and the configured audience together

This accepts tokens for an audience the operator did not choose and gives no
benefit: an installation either binds the URL or configures something else.

### Use `oid` automatically when the issuer is Microsoft's

This hides an identity decision behind a hostname match, does not help other
providers with pairwise subjects, and would silently rebind existing
installations on upgrade.
