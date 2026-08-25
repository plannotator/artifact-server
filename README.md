![Artifact Server](./docs/assets/banner.png)

# Artifact Server

**The self-hostable, open-source alternative to Claude Code artifacts.**

Artifact Server gives people and agents one place to publish, review, comment on, version, and share browser artifacts. Its built-in MCP server gives agents direct access to the same work.

Run it on a laptop for one developer. Deploy it for a private team on Cloudflare, one server, Kubernetes, AWS, or Google Cloud.

## Contents

- [Why Artifact Server](#why-artifact-server)
- [Built for AI agents](#built-for-ai-agents)
- [Cloudflare and Artifact Server](#cloudflare-and-artifact-server)
- [Run it locally](#run-it-locally)
- [Deploy it for a team](#deploy-it-for-a-team)
- [Publish manually](#publish-manually)
- [Security model](#security-model)
- [Development and project records](#development-and-project-records)

## Why Artifact Server

HTML has become a practical format for much more than websites. Teams use it for plans, mockups, prototypes, reports, and working interfaces. The same process now produces images and videos.

Too much of this work stays locked inside the platform that created it. Teams deserve to own their artifacts, data, and design process.

Artifact Server gives this collaboration a home. Teams can store artifacts by project, share them, comment on exact versions, and return to earlier results. You can self-host Artifact Server and keep control of the files and data.

## Built for AI agents

<p>
  <img src="./apps/web/src/review/assets/agents/claude.svg" alt="Claude" width="30" height="30">
  &nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/web/src/review/assets/agents/codex-dark.svg">
    <img src="./apps/web/src/review/assets/agents/codex-light.svg" alt="Codex" width="30" height="30">
  </picture>
  &nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/web/src/review/assets/agents/cursor-dark.svg">
    <img src="./apps/web/src/review/assets/agents/cursor-light.svg" alt="Cursor" width="27" height="30">
  </picture>
  &nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/web/src/review/assets/agents/copilot-dark.svg">
    <img src="./apps/web/src/review/assets/agents/copilot-light.svg" alt="GitHub Copilot" width="37" height="30">
  </picture>
</p>

[![AI agents connect to Artifact Server through its built-in MCP server](./docs/assets/agent-native-mcp.svg)](./docs/mcp.md)

Artifact Server includes an MCP server at `POST /mcp` and a portable Agent Skill. Agents can publish artifacts, create versions, manage projects and tags, read comments, and share exact review links.

Connect an agent to a running local installation:

```sh
artifactserver connect
```

From this source checkout, use `pnpm artifactserver connect --data .artifact-server`. This command connects the agent to the same development service as `pnpm dev`. A team deployment exposes its MCP endpoint at `https://your-server.example/mcp`.

Install the Artifact Server skill in Claude, Codex, Cursor, or another Agent Skills client:

```sh
npx skills add plannotator/artifact-server
```

Then ask the agent to publish finished work. In clients that expose skills as slash commands:

```text
/artifact-server upload that HTML design doc
```

The skill uses the CLI for local files. It uses MCP for server data and work that already exists in the agent. After publication, the agent returns the full-screen review link first.

[Connect an agent with MCP](./docs/mcp.md) for setup, supported operations, permissions, and review-link behavior.

## Cloudflare and Artifact Server

Cloudflare is the main hosted deployment target. Cloudflare Artifacts adds optional Git history, but it is not generally available. You must sign up for access, so the integration is off by default.

[![Cloudflare Artifacts provides optional Git-backed version history through Workers bindings](./docs/assets/cloudflare-artifacts-git-handoff.svg)](./docs/cloudflare-artifacts.md)

- [Deploy Artifact Server on Cloudflare](./deploy/cloudflare/README.md)
- [Use Cloudflare Artifacts for optional Git history](./docs/cloudflare-artifacts.md)
- [Read the Cloudflare Artifacts documentation](https://developers.cloudflare.com/artifacts/)

Cloudflare is optional. Artifact Server also runs locally, on Compose, on Kubernetes, on AWS, and on Google Cloud.

[![Artifact Server supports Cloudflare, Docker Compose, Kubernetes, AWS, and Google Cloud](./docs/assets/supported-deployments.svg)](./docs/deployment.md)

## Run it locally

The local target stores records in SQLite and files on local disk. It grants local-owner access only on an exact loopback origin.

### Requirements

- Node.js 24.12 or newer
- pnpm 10.34.3
- Git

### Start from source

```sh
git clone https://github.com/plannotator/artifact-server.git
cd artifact-server
pnpm install
pnpm dev
```

Open the URL printed by the development command. The web application normally runs at `http://127.0.0.1:5173/review`, and the development API runs at `http://127.0.0.1:8787`.

`pnpm dev` is the source-development path. It already starts the application and API. Do not run `artifactserver open` as a second setup step. Contributors can run CLI commands from the checkout with `pnpm artifactserver <command>`.

An installed release uses a different local path: `artifactserver open` starts or finds its managed local service and opens Artifact Server in your browser.

CAUTION: Do not expose the local-owner target to another device. Use a private-team deployment for remote access.

## Deploy it for a team

Every remote deployment uses one trusted application origin and one isolated wildcard content domain.

| Deployment | Data layer | Guide |
| --- | --- | --- |
| Cloudflare | D1 and R2 | [Cloudflare guide](./deploy/cloudflare/README.md) |
| Compact Compose | SQLite and one file volume | [Compose guide](./packaging/compose/README.md) |
| External-storage Compose | PostgreSQL and S3-compatible storage | [Compose guide](./packaging/compose/README.md) |
| Kubernetes | PostgreSQL and object storage | [Helm guide](./packaging/helm/artifact-server/README.md) |
| AWS | ECS, RDS, and S3 | [AWS Pulumi guide](./deploy/pulumi/aws/README.md) |
| Google Cloud | Cloud Run, Cloud SQL, and Cloud Storage | [Google Cloud Pulumi guide](./deploy/pulumi/gcp/README.md) |

[Read the deployment guide](./docs/deployment.md) for shared requirements, storage choices, authentication, and backups.

## Publish manually

The installed `artifactserver` CLI accepts one finished file or a complete directory:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --public --name "Product prototype" --tag prototype
```

For a remote server, sign in once and save a named profile:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver publish ./dist --profile team
```

Publication returns these links:

| Link | Purpose |
| --- | --- |
| `links.review` | Opens the exact version full screen with comments. Share this link first. |
| `links.artifact` | Opens the stable link that follows the current version. |
| `links.version` | Opens the immutable raw version without the Artifact Server interface. |

To publish another version, provide the artifact ID and expected current version:

```sh
artifactserver publish ./dist \
  --artifact art_example \
  --expected-version ver_example
```

The expected version prevents an old client from replacing a newer current pointer.

## Security model

Artifact Server separates the trusted application from untrusted artifact content.

```text
Application origin
  Review, API, MCP, authentication, comments
        │
        │ sandboxed review protocol
        ▼
Content origin
  Immutable artifact files on isolated version hosts
```

The server also enforces these rules:

- Untrusted paths never select storage locations.
- Private content uses version-scoped browser sessions.
- Publication requires file sizes and SHA-256 fingerprints.
- Version bytes and IDs remain stable across retries and restarts.
- Administrative changes use capabilities, expected versions, and idempotency keys.

Read [SECURITY.md](./SECURITY.md) to report a vulnerability. Read the [security-boundary decision](./project/spec/decisions/0002-shared-identity-and-private-content.md) for the full model.

## Development and project records

Install dependencies and run the focused development checks:

```sh
pnpm install
pnpm check
pnpm test:web
```

Run the complete iteration gate before a handoff:

```sh
pnpm verify:iteration
```

Repository engineering rules live in [AGENTS.md](./AGENTS.md).

The [`project`](./project) directory contains specifications, conformance evidence, performance records, prototypes, and research. Start with:

- [Product specification](./project/spec/artifact-server-product-spec.html)
- [Conformance ledger](./project/spec/conformance.yml)
- [MCP baseline](./project/spec/artifact-server-mcp-baseline.md)
- [Performance findings](./project/performance/FINDINGS.md)
- [Project records index](./project/README.md)

Public guides live in the [documentation index](./docs/README.md).

[![Review Artifact Server with Plannotator](./docs/images/star-plannotator.svg)](https://github.com/backnotprop/plannotator)

[![Plannotator Workspaces is the planning context layer for your software factory](./docs/images/plannotator-workspaces.svg)](https://plannotator.ai/workspaces)
