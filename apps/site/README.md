# Artifact Server public site

`apps/site` is the public Artifact Server home and documentation surface. It is
a static Nimbus site deployed independently from the authenticated management
application in `apps/web`.

## Run locally

From the repository root:

```sh
pnpm dev:site
```

The site runs at `http://127.0.0.1:4321`. The header's call to action is the
GitHub repository; the public site has no application behind it. A team that
hosts these docs beside its own installation can add an **Open app** link by
setting the explicit seam:

```sh
PUBLIC_ARTIFACT_SERVER_APP_URL=https://artifacts.example.com/review pnpm dev:site
```

## Verify

```sh
pnpm typecheck:site
pnpm --filter @artifact-server/site lint:docs
pnpm build:site
pnpm --filter @artifact-server/site verify:agents
```

The static build includes the landing page, Nimbus documentation, search,
Open Graph images, per-page Markdown or MDX alternates, `/llms.txt`,
`/llms-full.txt`, a sitemap, and robots metadata.

Every indexable HTML page has a sibling `index.md`, advertises it with
`rel="alternate" type="text/markdown"`, and points at its most specific
covering `llms.txt` with `rel="describedby"`. The agent-surface verifier checks
that parity after every production build and before deployment.

## Deploy to Cloudflare

Set `ARTIFACT_SERVER_SITE_ORIGIN` to the public canonical origin and
`PUBLIC_ARTIFACT_SERVER_APP_URL` to the trusted application origin, then run:

```sh
pnpm --filter @artifact-server/site deploy
```

Nimbus is pre-1.0, so its package is pinned exactly. Review generated changes,
the landing page, documentation routes, search, agent surfaces, and both themes
before changing that version.

The architecture decision and production boundary live in
`project/spec/decisions/0027-public-site-and-nimbus-docs.md`.
