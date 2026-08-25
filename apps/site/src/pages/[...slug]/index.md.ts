/**
 * Per-page `/<slug>/index.md` — the clean-markdown alternate for every
 * indexable entry of the primary `docs` collection.
 *
 * Non-primary collections (`api`, `blog`, …) mount under their own
 * URL namespace by convention; their `.md` alternates live at the
 * sibling route `pages/<collection>/[...slug]/index.md.ts`. This route
 * filters to the primary collection so multi-collection sites don't
 * generate conflicting `[...slug]` paths at root.
 */

import { getIndexedEntries, renderEntryAsMarkdown, type IndexedEntry } from "@cloudflare/nimbus-docs";
import { z } from "astro/zod";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const PRIMARY_COLLECTION = "docs";

interface SlugProps {
  item: IndexedEntry;
}

const socialMetadataSchema = z.looseObject({
  socialImage: z.string().min(1).optional(),
});

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === PRIMARY_COLLECTION)
    .map((item) => ({
      // Root index (`entry.id === "index"`) emits at `/index.md`; Astro's
      // rest-segment treats `undefined` as "no segment" so the URL is
      // `/index.md` rather than `/index/index.md`. Every other entry emits
      // at `/<entry.id>/index.md` — the convention `<page>/index.md`.
      params: {
        slug: item.entry.id === "index" ? undefined : item.entry.id,
      },
      props: { item },
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { entry, title, description, markdownUrl, sourceUrl, version } = item;
  const { socialImage: entrySocialImage } = socialMetadataSchema.parse(entry.data);
  const socialImage = entrySocialImage ?? config.socialImage;

  const markdown = rewriteInternalPageLinks(renderEntryAsMarkdown(entry));

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(socialImage
      ? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${new URL("/llms.txt", config.site).href}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${title}`,
    "",
    markdown,
    "",
    // Point at the authored source (`.mdx` twin) when it exists — the
    // `.md` alternate referencing itself was a placeholder.
    `Source: ${new URL(sourceUrl ?? markdownUrl, config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

function rewriteInternalPageLinks(markdown: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, href: string) => {
    let url: URL;
    try {
      url = new URL(href, config.site);
    } catch {
      return link;
    }

    if (url.origin !== new URL(config.site).origin || !url.pathname.endsWith("/")) {
      return link;
    }

    url.pathname = `${url.pathname}index.md`;
    const rewritten = href.startsWith("/")
      ? `${url.pathname}${url.search}${url.hash}`
      : url.href;
    return `](${rewritten})`;
  });
}
