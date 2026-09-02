export const prerender = true;

const markdown = `# Artifact Server

The open-source, self-hostable alternative to Claude Code artifacts.

Artifact Server gives people and agents one place to publish, review, comment on, version, and share the artifacts they create while building products. Its built-in MCP server gives agents direct access to the same work. Every publication creates an immutable version; review comments stay attached to the exact version and target. Run it on a laptop for one developer, or deploy it for a private team on Cloudflare, one server, Kubernetes, AWS, or Google Cloud.

## Product model

- An installation belongs to one person, team, or company.
- Projects contain artifacts.
- Artifacts have stable links and moving current-version pointers.
- Versions keep immutable identity and bytes.
- The trusted application origin is separate from isolated artifact content origins.

## Review with coding agents

- A coding agent connects through an extension in its own harness and appears in the review with a live presence avatar.
- The comment panel's main control sends every open comment on a version to that agent in one click ("Send all open (N) to <agent>").
- The agent receives the bundle as follow-up work, replies in each thread, resolves what it fixed, and publishes the next version.
- Pi, OpenCode, and Claude Code (channel) receive bundles in the running session; any MCP client (Claude Code, Codex, Cursor, Copilot) picks them up from an inbox, prompted by a nudge on every tool result.
- Extensions are thin adapters over the MIT @plannotator/agent-bridge client.

## License

Open source under the GNU Affero General Public License v3.0 (AGPL-3.0-only): use, self-host, and modify freely; if you modify it and offer it over a network, publish your modified source under the same license. The agent-bridge client and the agent extensions are MIT.

## Start

- [Documentation](https://artifactserver.com/docs/index.md)
- [Get started locally](https://artifactserver.com/docs/get-started/index.md)
- [Built-in MCP server](https://artifactserver.com/docs/mcp/index.md)
- [Review with coding agents](https://artifactserver.com/docs/agents/index.md)
- [Deploy for a team](https://artifactserver.com/docs/deploy/index.md)
- [Cloudflare deployment](https://artifactserver.com/docs/deploy/cloudflare/index.md)
- [Compose deployment](https://artifactserver.com/docs/deploy/compose/index.md)
- [Kubernetes deployment](https://artifactserver.com/docs/deploy/kubernetes/index.md)
- [AWS deployment](https://artifactserver.com/docs/deploy/aws/index.md)
- [Google Cloud deployment](https://artifactserver.com/docs/deploy/google-cloud/index.md)
- [Source](https://github.com/plannotator/artifact-server)
`;

export function GET(): Response {
  return new Response(markdown, {
    headers: {"Content-Type": "text/markdown; charset=utf-8"},
  });
}
