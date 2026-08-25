![Artifact Server](./docs/assets/banner.png)

# Artifact Server

**The self-hostable, open-source alternative to Claude Code artifacts.**

Artifact Server gives people and agents one place to publish, review, comment on, version, and share browser artifacts.

Run it on a laptop for one developer. Deploy it for a private team on Cloudflare, one server, Kubernetes, AWS, or Google Cloud.

## Contents

- [Why Artifact Server](#why-artifact-server)
- [Cloudflare and Artifact Server](#cloudflare-and-artifact-server)
- [Run it locally](#run-it-locally)
- [Deploy it for a team](#deploy-it-for-a-team)
- [Publish and review artifacts](#publish-and-review-artifacts)
- [Connect an AI agent](#connect-an-ai-agent)
- [Security model](#security-model)
- [Development and project records](#development-and-project-records)

## Why Artifact Server

Agents create useful work that does not belong in an application repository. Examples include reports, screenshots, prototypes, diagrams, and complete websites.

Artifact Server gives that work a durable home:

| Need | Artifact Server behavior |
| --- | --- |
| Revisit an earlier result | Every save creates an immutable version. |
| Share the latest result | A stable artifact link follows the current version. |
| Review one exact result | A review link opens that version full screen with comments. |
| Run generated HTML safely | Artifact content uses a separate browser origin. |
| Publish from an agent | MCP, CLI, and HTTP use the same product operations. |
| Keep control of data | Self-host the application and its storage. |

Artifact Server previews HTML, images, and video. It accepts one file or a complete directory.

Artifacts belong to projects. Each artifact contains immutable versions and one current-version pointer.

```text
Artifact Server installation
└── Project
    └── Artifact
        ├── Version 1 (immutable)
        ├── Version 2 (immutable)
        └── Current pointer → Version 2
```

## Cloudflare and Artifact Server

Cloudflare is the primary hosted deployment target. Workers run the application, D1 stores records, and R2 stores artifact files.

Cloudflare Artifacts adds optional Git history for selected projects. The integration is off by default, and Artifact Server remains the source of truth.

![Cloudflare Artifacts provides version storage through Workers bindings](./docs/assets/cloudflare-artifacts-git-handoff.svg)

- [Deploy Artifact Server on Cloudflare](./deploy/cloudflare/README.md)
- [Use Cloudflare Artifacts for optional Git history](./docs/cloudflare-artifacts.md)
- [Read the Cloudflare Artifacts documentation](https://developers.cloudflare.com/artifacts/)

Cloudflare is optional. Artifact Server also runs locally, on Compose, on Kubernetes, on AWS, and on Google Cloud.

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

Open the Workbench at `http://127.0.0.1:5173/workbench`.

Open the local application from another terminal:

```sh
node --import tsx src/cli/main.ts open --data .artifact-server
```

Publish an artifact:

```sh
node --import tsx src/cli/main.ts publish ./report.html \
  --data .artifact-server \
  --name "Release report"
```

The command returns the project, artifact, version, and browser links as JSON.

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

## Publish and review artifacts

The CLI accepts a finished file or directory. It uploads raw bytes through the staged upload protocol.

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

## Connect an AI agent

Artifact Server exposes the same projects, artifacts, versions, comments, and permissions through MCP.

Connect a local client:

```sh
artifactserver connect
artifactserver connect codex
artifactserver doctor codex
```

`artifactserver connect` supports Codex, Claude Code, Cursor, and VS Code. It does not place a visible credential in client configuration.

For a remote installation, add `https://artifacts.example.com/mcp` to the MCP client. The configured identity provider handles browser authorization.

After publication, the MCP result tells the agent to share `links.review` first. It also returns the stable and raw artifact links.

[Read the MCP guide](./docs/mcp.md) for connection flows, publishing steps, tool groups, and result contracts.

Install the portable publishing skill:

```sh
npx skills add plannotator/artifact-server
```

The skill uses the CLI for files on the developer machine. It uses MCP for server data and agent-held context.

## Security model

Artifact Server separates the trusted application from untrusted artifact content.

```text
Application origin
  Workbench, API, MCP, authentication, comments
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
