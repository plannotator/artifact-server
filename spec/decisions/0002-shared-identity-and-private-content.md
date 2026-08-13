# Decision 0002: Use one principal and authorization policy

Status: accepted for the local foundation

## Decision

Every supported credential is converted once into a provider-neutral
`Principal`. Application services receive that principal and enforce
installation, membership, ownership, and capability policy before performing
an operation.

HTTP, MCP, CLI, browser login, and Plannotator adapters do not define separate
permission rules. Each adapter verifies its credential format, obtains a
principal through `AuthenticationService`, and calls the same authorized
application operations.

The local API token currently maps to one named service principal in the local
installation. It has explicit artifact-creation, publication, and
content-session capabilities. This preserves the local workflow without
turning possession of an API token into an implicit boolean bypass.

## Artifact ownership and attribution

New artifacts persist the creating principal as their owner. Publication
commands carry the effective principal through the application service and
SQLite transaction. Action records store that principal instead of a
hard-coded actor.

Human owners and installation administrators may publish a new version.
Service principals require an explicit capability. A principal from another
installation fails before storage is selected.

## Private browser delivery

An authenticated principal may request a bootstrap for the artifact's current
immutable version. The server:

1. authorizes the principal against the artifact;
2. creates a random bootstrap token and stores only its SHA-256 digest;
3. binds the record to the principal, artifact, version, and content hostname;
4. expires the bootstrap after two minutes;
5. exchanges it once on the bound content hostname;
6. stores only the digest of a new version-scoped content-session token; and
7. sets that token as a Secure, HttpOnly, host-only, SameSite cookie that
   expires after fifteen minutes.

The clean content URL contains no credential. The content hostname accepts
only `GET` and `HEAD`. Private HTML and every relative asset require the exact
session and use `Cache-Control: private, no-store`. Public current-version
responses keep immutable public caching.

Bootstrap and content-session records use SQLite in the local deployment, so
both survive a process restart. Cloud deployments must implement the same
atomic exchange and lookup port with their chosen database.

## Security boundary

Raw bearer, bootstrap, and session tokens are wrapped as Effect `Redacted`
values after parsing. Secret values are unwrapped only inside credential,
hashing, cookie, and URL adapters. SQLite stores token digests, never raw
private-content credentials.

Application routes are unavailable on content hostnames. Application cookies
are not used for content delivery. Content JavaScript cannot read the HttpOnly
session or use it to call a mutation route.

## Deliberate exclusions

This iteration does not add:

- human account storage or browser login;
- WorkOS, OIDC, or MCP OAuth token verification;
- API-key issuance, rotation, revocation, or expiration;
- artifact access-setting changes;
- earlier-version browsing or session issuance; or
- a claim that the private-content flow has passed the required major-browser
  compatibility gate.

The bootstrap URL is a short-lived, single-use bearer credential. Its database
record retains the authorizing principal, but possession of the unredeemed URL
is the browser's proof during exchange. Browser behavior, URL handling, and the
remaining viewer-binding threat model must pass the private-delivery release
gate before a team deployment is marked supported.

## Verification

The local foundation verifies:

- credentials produce a provider-neutral principal;
- ownership and action attribution persist with publication;
- membership, ownership, capability, and installation policy fail closed;
- private HTML and root-relative assets require one exact session;
- bootstrap exchange is single-use and hostname-bound;
- tampered, replayed, expired, and cross-host tokens fail;
- sessions expire server-side and survive restart before expiration;
- content sessions cannot authorize writes or application routes; and
- private responses are not publicly cacheable.
