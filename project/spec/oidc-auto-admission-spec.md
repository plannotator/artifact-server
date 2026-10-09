# OIDC automatic browser admission

**Status:** Accepted; local behavior verified — packaged deployment evidence remains to be recorded.
**Date:** October 9, 2026
**Companion documents:** [OIDC browser login](./oidc-interactive-login-spec.md),
[Generic OIDC decision](./decisions/0020-generic-oidc-login.md),
[Conformance ledger](./conformance.yml)

## Purpose

An installation may delegate membership eligibility to its configured OIDC issuer.
For example, Dex may already restrict authentication to a corporate directory or
email domain. Such an installation can opt into admitting new users after a
validated browser login instead of requiring a separate manual admission for each
person. Explicit admission remains the default.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `ARTIFACT_SERVER_OIDC_AUTO_ADMIT` | `false` | Exactly `true` enables automatic admission; exactly `false` disables it. Other values fail startup. |
| `ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS` | Empty | Comma-separated exact email domains for new automatic registrations. An empty or whitespace-only value trusts the configured issuer's eligibility rules. |
| Helm `identity.oidcAutoAdmit` | `false` | Boolean equivalent of the environment switch. |
| Helm `identity.oidcAllowedEmailDomains` | `[]` | Array rendered as the comma-separated environment value. |

Domains are trimmed and lowercased. Each entry must be a valid hostname, without
wildcards, empty entries, or a trailing dot. Matching uses the complete normalized
email domain: `example.com` accepts `person@EXAMPLE.COM`, but does not accept
`person@sub.example.com` or `person@otherexample.com`.

The environment variables belong to the OIDC configuration family. Setting either
requires a complete OIDC issuer/client configuration and remains mutually exclusive
with WorkOS, even when the switch is `false`. Malformed domain values fail startup
even when automatic admission is disabled. These settings are not credentials.

## Admission behavior

The policy applies only after the configured browser OIDC flow has validated its
handshake cookie, single-use state, PKCE exchange, issuer, audience, signature,
expiry, nonce, and identity claims. It matches the issuer-qualified identity
provider, not the generic login-attempt discriminator. An explicit
`email_verified: false` remains denied; an absent claim keeps the existing
configured-issuer trust rule.

Resolution looks for the same installation's issuer/subject binding before email.
With automatic admission enabled, both lookups include inactive members, so a
deactivated subject cannot evade the decision by changing its email, including to
another active member's email. An inactive email match is denied as well. Existing
active members keep their member ID and role; the registration-domain list does
not restrict explicitly admitted members.

The first-member bootstrap rule remains unchanged: when the installation has no
members, only the configured bootstrap administrator may enter, and that member
receives the administrator role. The optional domain list does not restrict this
bootstrap. Once the installation has members, an unknown identity is admitted as
a normal member only when the policy is enabled for that issuer and the domain
list is empty or contains the complete email domain. Repeated or simultaneous
logins must converge on the same member and binding. Successful admission issues
the ordinary application session; denial creates no new member or session.

The policy does not extend WorkOS admission, local-owner bootstrap, or MCP bearer
admission. A bearer identity cannot automatically register a normal member through
this setting. No schema migration, group mapping, administrator promotion, or
directory synchronization is introduced.

## Conformance

| ID | Acceptance |
| --- | --- |
| AUTH-029-B | Enable the policy and complete a real signed browser OIDC login for an unknown eligible person; receive a normal member session, reuse the member and binding on repeat/concurrent login, preserve first-administrator bootstrap and explicitly admitted roles, and accept an exact allowed domain after normalization. |
| AUTH-029-F | Keep automatic admission off by default; reject malformed policy configuration, an unknown person outside the exact domain list, another issuer, an explicitly unverified email, or an invalid token without creating a member/session; refuse inactive email/subject matches even after email changes, while retaining installation and issuer scope. |

The acceptance tests use real services, HTTP OIDC boundaries, signed tokens, and
storage adapters:

- `tests/conformance/oidc-auto-admission.test.ts` covers browser admission,
  bootstrap, repeat/concurrent login, token rejection, domain boundaries, preserved
  roles, and inactive identities with SQLite.
- `tests/conformance/oidc-admission-configuration.test.ts` covers parsing and the
  loaded policy through a real browser login.
- `tests/conformance/auth-029-identity-repository.test.ts` covers status-inclusive
  lookups and installation/issuer scope with SQLite.
- `tests/conformance/oidc-admission-boundary.test.ts` covers bearer-only and WorkOS
  admission boundaries through real services and SQLite.
- `tests/integration/external-storage-runtime.test.ts` covers compiled and
  in-process PostgreSQL replicas, simultaneous logins, and inactive-subject refusal.
- `deploy/cloudflare/tests/oidc-login-runtime.test.ts` covers Worker configuration
  and a signed browser callback using D1.

The ledger records passing local behavior evidence in `project/evidence/local-foundation.json`.
Helm rendering and the complete packaged deployment matrix also require their
normal verification gates; a passing local fixture alone does not prove production
login against an operator's issuer.
