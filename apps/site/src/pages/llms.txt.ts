// Root /llms.txt — sectioned index for AI agents.
import { getIndexedTopLevel } from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export async function GET() {
  const { leaves, groups } = await getIndexedTopLevel();

  const lines = [
    `# ${config.title}`,
    "",
    `> ${config.description ?? "Documentation index for AI agents."}`,
    "",
    "Artifact Server gives agent-made documents, prototypes, reports, and sites a durable, reviewable home. Start with the product overview, then use the documentation index to fetch only the detail needed for the current task.",
    "",
    "## Product",
    "",
    `- [Artifact Server home](${new URL("/index.md", config.site).href}) — Product overview, mental model, and routes into the application and documentation.`,
  ];

  // Sort leaves + groups alphabetically into a single stable list.
  type Row = { key: string; line: string };
  const rows: Row[] = [];

  for (const leaf of leaves) {
    const description = leaf.description ? ` — ${leaf.description}` : "";
    rows.push({
      key: leaf.url,
      line: `- [${leaf.title}](${new URL(leaf.markdownUrl, config.site).href})${description}`,
    });
  }

  for (const group of groups) {
    // Older doc versions have their own /<v>/llms.txt; don't list them here.
    if (group.kind === "version") continue;
    rows.push({
      key: `/${group.slug}`,
      line: `- [${group.label === "docs" ? "Artifact Server documentation" : group.label}](${new URL(`/${group.slug}/llms.txt`, config.site).href}) — Curated index of clean Markdown pages in this section.`,
    });
  }

  rows.sort((a, b) => a.key.localeCompare(b.key));
  lines.push("", "## Documentation", "");
  for (const row of rows) lines.push(row.line);

  lines.push(
    "",
    "## Optional",
    "",
    `- [Complete documentation corpus](${new URL("/llms-full.txt", config.site).href}) — Every documentation page combined into one file; use only when the full corpus is necessary.`,
    "- [Artifact Server source](https://github.com/plannotator/artifact-server) — Fair-source implementation (FSL-1.1-Apache-2.0), specifications, and deployment packages.",
    "- [@plannotator/agent-bridge](https://github.com/plannotator/agent-bridge) — MIT protocol client that coding-agent extensions use to receive review bundles and close comment threads.",
    "",
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
