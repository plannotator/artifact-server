# 0027: The public site uses Nimbus beside the Artifact Server application

**Status:** Accepted

## Context

Artifact Server needs an open-source product home, human documentation, and
agent-readable documentation. It also ships an authenticated React review,
HTTP and MCP control planes, and wildcard content origins for untrusted
artifacts. Putting every surface in the existing application bundle would mix
public marketing, authenticated product state, and content-delivery security
policies.

Cloudflare Nimbus is an Astro documentation system that writes visible layouts,
components, content, and design tokens into the consuming repository. Its
package keeps the content integration, search, Markdown alternates, structured
metadata, and agent indexes behind a small framework boundary. Nimbus emits a
static site and has a first-class Cloudflare Workers Assets deployment.

Nimbus is pre-1.0. Its public surface may change between minor releases, so an
unbounded dependency would make the public site move independently from the
Artifact Server product.

## Decision

Artifact Server owns two deployable web surfaces in one repository:

1. `apps/site` is the public product home and documentation. It is an
   Artifact Server-branded Nimbus/Astro site with owned source, owned design
   tokens, `/docs` content, per-page Markdown alternates, `/llms.txt`,
   `/llms-full.txt`, search, metadata, and a static Cloudflare deployment.
2. `apps/web` remains the authenticated product application. The existing
   application Worker continues to own `/review`, `/projects`, `/api`,
   `/mcp`, authentication, and isolated artifact delivery.

The production default is a public site at `artifactserver.com` and an
installation-specific application origin such as `app.artifactserver.com`.
Local development uses the Nimbus site on port 4321 and the product application
on port 5173. `PUBLIC_ARTIFACT_SERVER_APP_URL` is the explicit link between the
two surfaces; it defaults to the local review and is set to the deployed
installation URL for a hosted build.

Nimbus is infrastructure, not product identity:

- the site uses the Artifact Server mark, typography, square geometry, and
  purple product tokens;
- the homepage is an owned Astro page, not a Nimbus-branded template;
- docs layouts are allowed to use Nimbus interaction patterns while sharing
  the same Artifact Server header, footer, tokens, and content voice; and
- `@cloudflare/nimbus-docs` is pinned exactly until it reaches a stable release
  and upgrades pass the site build, typecheck, content lint, responsive review,
  Markdown-twin review, and Cloudflare preview.

The public-site Worker and Artifact Server Worker deploy independently. The
public site does not proxy application API, MCP, authentication, or content
requests. The application Worker does not serve Nimbus files.

## Consequences

- The public home and docs can evolve without adding marketing code to the
  authenticated review or weakening its content-security policy.
- Artifact Server gets Nimbus search, authoring checks, Markdown twins,
  `llms.txt`, structured data, and Cloudflare static deployment while retaining
  complete control of the visual source.
- A deployed open-source installation can point its "Docs" link at the central
  public site without bundling a second framework into the application image.
- A hosted offering can point the public site's "Open app" action at its own
  application origin without changing the site bundle.
- Development and deployment require two processes and two Cloudflare Workers.
  That cost is intentional because the surfaces have different trust,
  caching, routing, and release boundaries.
- The site must not claim a deployment is generally available before the
  applicable conformance and release gates have passing evidence.

## Rejected alternatives

### Replace the React review with Nimbus

Nimbus is a static Astro documentation system, not the stateful application
shell. Replacing the review would discard its API client, polling, comment,
preview, and sandbox behavior.

### Serve Nimbus from the Artifact Server Worker

This would make a public documentation release part of the application runtime
and force public pages, authenticated routes, MCP, API, and wildcard content to
share one asset and routing lifecycle.

### Copy Nimbus's brand onto Artifact Server

Nimbus explicitly provides owned source and tokens. Keeping its default visual
identity would make the product look like a Nimbus demo and break continuity
with the Artifact Server review.

## References

- [Nimbus repository](https://github.com/cloudflare/nimbus)
- [Nimbus documentation](https://nimbus-docs.com/)
- [Artifact Server Cloudflare deployment](../../../deploy/cloudflare/README.md)
