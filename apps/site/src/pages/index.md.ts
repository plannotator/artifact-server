export const prerender = true;

const markdown = `# Artifact Server

Open-source infrastructure for publishing, reviewing, and sharing immutable browser artifacts.

Artifact Server gives the documents, prototypes, reports, and sites created by people and agents a stable home. Every publication creates an immutable version. Review comments stay attached to the exact version and target. People and agents use the same artifact record through the CLI, MCP, HTTP API, and browser review.

## Product model

- An installation belongs to one person, team, or company.
- Projects contain artifacts.
- Artifacts have stable links and moving current-version pointers.
- Versions keep immutable identity and bytes.
- The trusted application origin is separate from isolated artifact content origins.

## Start

- [Documentation](https://artifactserver.com/docs/index.md)
- [Get started locally](https://artifactserver.com/docs/get-started/index.md)
- [Cloudflare deployment](https://artifactserver.com/docs/deploy/cloudflare/index.md)
- [Source](https://github.com/plannotator/artifact-server)
`;

export function GET(): Response {
  return new Response(markdown, {
    headers: {"Content-Type": "text/markdown; charset=utf-8"},
  });
}
