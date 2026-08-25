# Generic OIDC browser login

**Status:** Accepted; implemented — AUTH-019, AUTH-020, and AUTH-021 behavior-verified on the local deployment, and the real-IdP round trip proven by the `test:oidc` Keycloak suite, now part of `verify:iteration` (August 18, 2026)
**Date:** August 18, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.md), [Conformance ledger](./conformance.yml), Workspaces self-host auth (`apps/rooms/src/auth/providers/oidc.ts` in the canonical Workspaces checkout)

## 1. What this adds and why

Self-hosted Artifact Server browser login today supports exactly one identity provider: WorkOS (`src/identity/workos-identity-provider.ts`, the only implementation of the `InteractiveIdentityProvider` port). A customer who runs their own OpenID Connect provider — Okta, Microsoft Entra, Google Workspace, Keycloak — cannot point Artifact Server at it directly.

The sibling Workspaces product already ships this: its self-host default is `AUTH_MODE=oidc` against any OpenID Connect provider, with WorkOS reserved for the hosted Cloudflare flavor (`SELF-HOST.md:83` refuses `AUTH_MODE=workos` in self-host). This spec brings Artifact Server to parity by adding a second, generic OIDC implementation of the existing provider port, deliberately mirroring Workspaces' configuration vocabulary, flow, and validation rules so the two products describe OIDC the same way.

Nothing else about identity changes. The port stays as it is; sessions, CSRF, admission, members, API keys, and the deployment token are untouched. OIDC only answers "who is this person"; explicit member admission still decides "may they enter."

## 2. Goal and non-goals

| In scope | Out of scope, and why |
| --- | --- |
| Browser login (`/auth/login` → provider → `/auth/callback`) through any spec-compliant OIDC provider, on every deployment. | **MCP OAuth.** The MCP bearer path (`WorkOsMcpBearerVerifier`, `workos-oauth-metadata.ts`) assumes an OAuth authorization server that MCP clients can register against and that can introspect access tokens. A bare enterprise IdP is generally not that server. The WorkOS MCP verifier stays WorkOS-only; OIDC deployments use managed API keys for MCP, which already work everywhere. |
| Mirroring Workspaces' env-var vocabulary and validation. | **Replacing WorkOS.** The WorkOS plug remains the hosted flavor and keeps working unchanged. |
| A nonce on login attempts (small additive schema change, section 5). | **Directory sync, role mapping, SCIM, JIT provisioning beyond the existing bootstrap-administrator rule.** Admission stays explicit. |
| RP-initiated logout is **deferred** (open decision 3). | **Refresh tokens / offline_access.** Artifact Server sessions are server-side with their own lifetime; the id_token is used once at login. |

API keys, the deployment token, local browser login (`/auth/local`), and content sessions are unaffected.

## 3. Configuration

New variables, mirroring Workspaces' `OIDC_*` names under this repo's `ARTIFACT_SERVER_` prefix and secret conventions (`loadOptionalCredential` supports `<NAME>` xor `<NAME>_FILE`, `src/lifecycle/runtime-configuration.ts:554-595`):

| Variable | Required | Rule |
| --- | --- | --- |
| `ARTIFACT_SERVER_OIDC_ISSUER` | yes | `https://` origin-or-path URL, trailing slashes stripped, query/hash refused. Plain `http://` allowed only for `localhost`, `127.0.0.1`, `::1` (development), exactly Workspaces' `normalizeIssuer` rule. |
| `ARTIFACT_SERVER_OIDC_CLIENT_ID` | yes | Non-empty string. |
| `ARTIFACT_SERVER_OIDC_CLIENT_SECRET` / `…_FILE` | no | Optional: a public client using PKCE alone is valid, as in Workspaces. When set, sent as `client_secret` in the token-request form body (`client_secret_post`, what Workspaces does). |
| `ARTIFACT_SERVER_OIDC_SCOPES` | no | Default `"openid email profile"` (Workspaces' default). |
| `ARTIFACT_SERVER_ORIGIN` | yes (shared) | Already required for WorkOS login; the redirect URI is exactly `<origin>/auth/callback`. |
| `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL` | yes (shared) | Already required for WorkOS login; unchanged meaning. |

Rules, enforced at startup by an all-or-nothing loader mirroring `loadWorkOsConfiguration` (`src/cli/workos-configuration.ts:27-62`):

1. **Partial configuration fails startup** with a message naming every required variable, exactly like the WorkOS loader and the worker's `workOsAuthentication` guard (`deploy/cloudflare/src/worker.ts:190-204`).
2. **WorkOS and OIDC are mutually exclusive.** If any `ARTIFACT_SERVER_WORKOS_*` and any `ARTIFACT_SERVER_OIDC_*` variable are both set, startup fails: one installation has one browser-login provider. The check is presence-based over the raw environment (`assertOneBrowserLoginProvider`, run before either loader), so a leftover `ARTIFACT_SERVER_WORKOS_ISSUER` beside a complete OIDC family fails on the CLI exactly as it already did on the worker. This mirrors Workspaces' single `AUTH_MODE`, without introducing a mode variable — presence of a variable family selects the provider, absence of both means what it means today.
3. **No provider configured** keeps the provider-neutral application-layer behavior: `InteractiveLoginService` is constructed with `provider: null` and `/auth/login` answers `InteractiveLoginUnavailable` (`src/application/interactive-login.ts:105-106`). [The access-mode specification](./local-owner-and-private-team-access-spec.md) supersedes the old process-startup behavior for private-team entry points: they require one provider and do not enable `/auth/local` or the legacy installation bearer.
4. There is **no cookie-secret variable**. Workspaces needs `OIDC_COOKIE_SECRET` because its session is a stateless signed cookie; Artifact Server sessions are server-side records with digested tokens (`installation-access.ts` sessions), so no new secret exists to manage. Deliberate divergence, documented so nobody "ports" the variable.
5. `interactiveIdentityProvider` in runtime inspection widens from `"local" | "workos"` to `"local" | "workos" | "oidc"` (`src/lifecycle/runtime-configuration.ts:128`, `:478`).

## 4. The provider implementation

One new class, `OidcIdentityProvider` (`src/identity/oidc-identity-provider.ts`), implementing the existing port unchanged in role:

```
InteractiveIdentityProvider
  name: "oidc"                     // the login_attempts discriminator
  start(): { authorizationUrl, codeVerifier, state, nonce }
  complete(code, codeVerifier, nonce): ExternalIdentity
```

Flow, matching Workspaces' `providers/oidc.ts` decision for decision:

- **Discovery** is lazy at first login and cached per process: `GET <issuer>/.well-known/openid-configuration`, `issuer` echo must normalize to the configured issuer, `authorization_endpoint` / `token_endpoint` / `jwks_uri` required and validated as `https://` URLs with no credentials or fragment (local `http` only for local issuers). Discovery failure produces one operator-actionable log line naming the issuer and cause — the Workspaces `discoveryFailure` precedent — and surfaces to the browser as the existing generic `IdentityProviderFailure`.
- **Authorization redirect**: `response_type=code`, `client_id`, `redirect_uri=<origin>/auth/callback`, `scope`, `state` (256-bit random, digested into the attempt row exactly as today), `nonce` (128-bit random), `code_challenge` = S256(codeVerifier), `code_challenge_method=S256`. The service, not the provider, keeps owning attempt persistence: `start()` mints the values, `InteractiveLoginService.start` stores `{stateDigest, codeVerifier, nonce, provider: "oidc", returnTo, expiresAt}` (`interactive-login.ts:103-118`).
- **Token exchange**: form-encoded `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, plus `client_secret` when configured. Response must contain an `id_token`.
- **id_token verification** with `jose` (already a dependency, `package.json:84`): signature against a cached `createRemoteJWKSet(discovery.jwks_uri)`, `issuer` = discovery issuer, `audience` = client id, `exp`/`nbf` with a fixed 30-second `clockTolerance` (divergence from Workspaces, which uses jose's zero default; self-hosted IdPs drift), and the `nonce` claim strictly equal to the attempt's stored nonce.
- **Claim mapping** to the existing `ExternalIdentity`:
  - `subject` = `sub` (required, non-empty).
  - `email` = `email` claim (required, non-empty; login fails without it — scope must include `email`).
  - `emailVerified` = the `email_verified` claim; **absent means `true`** (the operator configured this issuer as the trust anchor, and requiring the claim would break IdPs that omit it — Entra, some Keycloak realms — out of the box). An **explicit `email_verified: false`** maps to `false`, and the existing admission gate then refuses the login (`installation-access.ts:401-404`) — that is the IdP itself flagging the address, and honoring it costs nothing. This is the industry-standard posture (decided by the owner, August 18, 2026): trust the configured IdP, no extra configuration, refuse only what the IdP explicitly disavows. No `ASSUME_EMAIL_VERIFIED` variable exists.
  - `displayName` = `name`, else `given_name` + `family_name`, else the email — the same cascade as the WorkOS plug (`workos-identity-provider.ts:80-88`).
  - `provider` = **`"oidc:" + normalized issuer`** (e.g. `oidc:https://idp.example.com`). This is the durable half of the `(provider, subject)` member binding (`bindExternalIdentity`, `installation-access.ts`), and `sub` values are only unique per issuer, so the issuer belongs in the binding. Note the split: the *port's* `name` stays the constant `"oidc"` (it discriminates login-attempt rows), while the *identity's* `provider` is issuer-qualified (it discriminates people). If a deployment later changes issuer, existing `(provider, subject)` bindings stop matching by design; login then falls through to the active-member **email match**, which re-binds the member to the new issuer identity (`resolveExternalMember` always writes the binding after resolution, `installation-access.ts:442-448`) — so an issuer migration self-heals through verified email, and no data migration is needed.

**Nonce storage** is the one real port change: `InteractiveAuthorization` and `LoginAttempt` gain `nonce: string | null` (null for WorkOS, whose SDK handles its own flow), and `complete()` gains the nonce parameter, ignored by the WorkOS plug. `login_attempts` gains a nullable `nonce` column in all three identity repositories — additive migrations, SQLite schema 5→6, Postgres 4→5 (record + `expectedHistory`), D1 3→4 (upgrade statements). Rejected alternative: deriving the nonce from a hash of the stored `codeVerifier` avoids the column but is nonstandard cleverness; the column is boring and auditable.

## 5. Security requirements

- Redirect URI is exactly `<ARTIFACT_SERVER_ORIGIN>/auth/callback`; nothing caller-supplied ever reaches it. `returnTo` keeps the existing same-origin sanitizer, which validates the path **after** WHATWG normalization as well as before it: `/..//host` normalizes to the scheme-relative pathname `//host`, and a normalized path whose second character is `/` falls back to `/api/v1/session`.
- State is single-use and expiring (existing `consume` semantics, digest-matched); nonce is single-use by riding the attempt row; the code is single-use at the IdP and bound to the PKCE verifier.
- The callback is bound to the browser that started the login. `/auth/login` sets a short-lived `HttpOnly`, `SameSite=Lax` handshake cookie (`artifact_login`, `__Host-artifact_login` on HTTPS origins) carrying the raw `state`; `/auth/callback` refuses with `LoginAttemptRejected` unless the cookie matches the `state` query parameter under a constant-time comparison, before the attempt is consumed and before the provider is called. Without it, anyone could mint a state, authenticate as themselves, and drive a victim's top-level navigation to `/auth/callback` — planting the attacker's session in the victim's browser (RFC 6749 §10.12, OIDC Core §15.5.2). The cookie is cleared on completion.
- Discovery and token requests never follow redirects (`redirect: "manual"`; a 3xx is a provider failure) and carry a five-second budget, so no redirect can replay the client secret, authorization code, and PKCE verifier to an unvalidated host, and a stalled issuer cannot pin `/auth/callback` requests open.
- `login_attempts` rows created by the unauthenticated `/auth/login` are bounded: every insert first deletes the attempts that have passed `expires_at` in all three identity repositories.
- No id_token is accepted from any issuer other than the configured one; the JWKS is fetched only from the discovered `jwks_uri` under the issuer's validated origin rules; `alg` is whatever the JWKS key advertises via jose's verification (no `alg: none`, jose refuses it structurally).
- HTTPS-only endpoints except explicit local-development hosts (section 3 rule).
- Logged: provider name, issuer, and cause on discovery/exchange failure. Never logged: authorization codes, tokens, verifiers, client secret, id_token contents, email addresses at failure paths (match the existing generic `IdentityProviderFailure` message discipline).
- Admission unchanged and last: a verified OIDC identity that is not an admitted active member (or the bootstrap administrator on first contact, `installation-access.ts:417-440`) is refused with `IdentityAdmissionDenied`.

## 6. Deployment surface

The provider uses only `fetch` and `jose` — both Workers-safe — unlike the WorkOS plug's `@workos-inc/node`. Private-team single-server, Kubernetes, Compose, external-storage, and Cloudflare deployments can use it. Direct local-owner mode deliberately refuses an external browser provider.

| Deployment | Change |
| --- | --- |
| Private-team CLI / single server / compose / Helm | `loadOidcConfiguration` sits beside `loadWorkOsConfiguration`; private-team entry points require WorkOS xor OIDC (neither or both → startup error). Direct `artifactserver start` stays local-owner mode and refuses either provider. Compose and Helm document and validate the same provider variables. |
| Cloudflare worker | `WorkerEnvironment` gains the `ARTIFACT_SERVER_OIDC_*` bindings; the existing `workOsAuthentication` guard becomes a provider selection with the same all-or-nothing and mutual-exclusion rules. Hosted Plannotator deployments keep configuring WorkOS. |
| Hosted recommendation, not refusal | Workspaces hard-refuses `AUTH_MODE=workos` in self-host because WorkOS there is coupled to hosted billing and multi-org membership. Artifact Server has no such coupling — one installation, one membership list — so this spec **documents** WorkOS as the hosted flavor and OIDC as the self-host flavor but refuses neither combination. The only refusal is configuring both at once. |

Docs to update: `.env.example`, `packaging/compose/README.md`, Helm chart values and README, `project/spec/cloud-deployment-contract.md` (login variables table), product spec sharing/login prose.

## 7. Conformance

Module `authorization`, three new requirements in the existing ledger style (source: this file; statuses start `specified`, empty evidence):

| ID | Kind | Behavior (short) | -B acceptance | -F acceptance |
| --- | --- | --- | --- | --- |
| AUTH-019 | behavior | A deployment configured with a generic OIDC issuer completes browser login through discovery, auth-code with PKCE and nonce, id_token verification, and normal admission, on every deployment kind. | Sign in against a real stub OIDC provider; an admitted member gets a session, the bootstrap administrator is admitted on first contact, display name and issuer-qualified binding are recorded, and a second login reuses the binding. | An unadmitted verified identity, an unverified email, and a missing email are refused without creating members or sessions. |
| AUTH-020 | security | The OIDC callback fails closed on every token-validation defect. | Valid logins succeed under a 30-second clock skew. | Wrong signature, wrong issuer, wrong audience, expired token, replayed or unknown state, expired attempt, and wrong nonce are each refused; no session or member is created; codes and tokens never appear in logs. |
| AUTH-021 | constraint | OIDC configuration is all-or-nothing, mutually exclusive with WorkOS, and issuer/endpoint URLs obey the HTTPS rules. | A complete OIDC configuration boots and reports `interactiveIdentityProvider: "oidc"`; absence of both providers keeps login unavailable while keys still work. | Partial OIDC configuration, WorkOS-plus-OIDC together, a non-HTTPS non-local issuer, and discovery documents with a mismatched issuer or credentialed/fragmented endpoint URLs each fail startup or login without weakening the running server. |

**Test plan** (repo rules: no module mocks, real boundaries): a stub OIDC provider in `tests/support/stub-oidc-provider.ts` — a real in-process HTTP server that serves `/.well-known/openid-configuration`, a JWKS for a freshly generated ES256 key, an authorize endpoint that redirects with `code` and echoes `state`, and a token endpoint that signs real id_tokens with configurable claims (`nonce`, `aud`, `iss`, `exp`, `email_verified`). Workspaces' module-level `setOidcFetchForTesting` seam is exactly what this repo's no-module-mocking rule forbids; the stub server replaces it. Conformance tests drive the real HTTP app: `GET /auth/login` → follow the redirect to the stub → callback → assert session cookie, member records, and the failure matrix. Local `http://127.0.0.1` issuers are legitimate under the section-3 rule, so the stub needs no TLS.

## 8. Touch list

New: `src/identity/oidc-identity-provider.ts`, `src/cli/oidc-configuration.ts`, `tests/support/stub-oidc-provider.ts`, `tests/conformance/auth-019-oidc-login.test.ts`, `auth-020-oidc-validation.test.ts`, `auth-021-oidc-configuration.test.ts`, `project/spec/decisions/0020-generic-oidc-login.md`.

Edited: `src/application/interactive-login.ts` (nonce on `InteractiveAuthorization`, `complete` signature), `src/core/installation-identity.ts` (`LoginAttempt.nonce`), `src/identity/workos-identity-provider.ts` (accept-and-ignore nonce), `src/storage/sqlite-identity-repository.ts` + `sqlite-schema.ts` (5→6), `src/storage/postgres-identity-repository.ts` + `postgres-migrations.ts` (4→5 + `expectedHistory`), `deploy/cloudflare/src/d1-identity-repository.ts` + `d1-migrations.ts` (3→4) , `src/lifecycle/runtime-configuration.ts` (provider union), `src/cli/main.ts`, `src/cli/lifecycle-commands.ts`, `deploy/cloudflare/src/worker.ts`, `.env.example`, `packaging/compose/README.md`, Helm values, `project/spec/cloud-deployment-contract.md`, `project/spec/conformance.yml`, product spec login prose.

## 9. Confidence notes: verified against source vs. assumed

Verified (file:line, both repos):

- Workspaces generic OIDC: env names and rules (`OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET(optional)/SCOPES/COOKIE_SECRET≥32B/SESSION_MAX_AGE 300..604800`, `apps/rooms/src/auth/providers/oidc.ts:236-267`, `:436-447`); HTTPS-only issuer with localhost-http escape (`:405-433`); discovery validation incl. issuer echo and credential/fragment refusal (`:288-321`, `:466-489`); PKCE S256 + 128-bit nonce + sealed state cookie (`:224-233`, `provider.ts:315-326`); `client_secret_post` (`:337-344`); id_token required, JWKS-verified with `issuer`+`audience`, nonce strict-equal, `sub`+`email` required (`:117-133`); identity `oidc:<issuer>:<sub>` (`:191`); no `email_verified` check anywhere in that file; `AUTH_MODE` set `workos|cloudflare_access|oidc|dev-session`, default `workos`, dev-session production refusal (`config.ts:13-62`); self-host default `oidc` and `AUTH_MODE=workos` refused (`SELF-HOST.md:81-94`).
- Artifact Server seam: port shape and service-owned PKCE state (`src/application/interactive-login.ts:24-38`, `:103-118`); `provider: null` ⇒ login unavailable (`:105`); `returnTo` sanitizer (`:141-160`); admission refuses unverified email and unadmitted people, binds `(provider, subject)`, falls back to email match, bootstrap-admits the first administrator (`src/application/installation-access.ts:391-440`); WorkOS plug shape and display-name cascade (`src/identity/workos-identity-provider.ts`); all-or-nothing WorkOS loader with `_FILE` secret convention (`src/cli/workos-configuration.ts:27-62`, `src/lifecycle/runtime-configuration.ts:554-595`); worker guard (`deploy/cloudflare/src/worker.ts:190-204`); `login_attempts` columns today have no nonce (`src/storage/sqlite-identity-repository.ts:545-556`); `jose@6.2.9` already in dependencies (`package.json:84`); `interactiveIdentityProvider: "local" | "workos"` (`src/lifecycle/runtime-configuration.ts:128`, `:478`); AUTH ids currently end at AUTH-018 (`project/spec/conformance.yml:1323`); CMT entries establish the precedent of citing a `.md` spec as ledger source.
- Workers compatibility: the generic provider needs only `fetch` + `jose`; the WorkOS plug's `@workos-inc/node` is not involved. The worker already constructs hosted authentication via the same seam (`worker.ts:205-217`).

Resolved during implementation:

- The provider imports only jose/effect/zod (zero `node:` imports) and compiles under the worker tsconfig; worker tests cover configuration selection. Cold-start JWKS refetch is accepted behavior.
- Helm plumbing needed real template work (`packaging/helm/artifact-server/templates/_helpers.tpl` validation guards, secret item, runtime env block), delivered with the values. `scripts/verify-helm-chart.sh` does not yet assert the three OIDC render-failure guards — cheap follow-up.

## 10. Decisions recorded (owner, August 18, 2026)

1. **`email_verified`:** absent means verified; only an explicit `email_verified: false` refuses the login. No escape-hatch variable. Rationale: this is an open-source self-host path — it must work out of the box with every mainstream IdP, with no extra configuration and no invented guardrails. Section 4 carries the behavior.
2. **No mode refusals:** nothing blocks a self-hoster from using WorkOS or a hosted deployment from using generic OIDC. The docs state the typical pairing (WorkOS for Plannotator-hosted, OIDC for self-host); the software refuses neither. Anyone who wants WorkOS can keep using it.
3. **Logout stays local:** signing out revokes the Artifact Server session only — the normal behavior for SSO-connected applications. RP-initiated IdP logout (`end_session_endpoint`) is a small later addition if a customer's security team asks for it; discovery already fetches the document that advertises it.
