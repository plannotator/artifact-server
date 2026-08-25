import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const siteDirectory = resolve(import.meta.dirname, "..");
const outputDirectory = join(siteDirectory, "dist");
const canonicalOrigin = "https://artifactserver.com";

assert.ok(existsSync(outputDirectory), "Build apps/site before verifying agent surfaces.");

const files = walk(outputDirectory);
const htmlFiles = files.filter((file) => file.endsWith(".html") && !file.endsWith(`${sep}404.html`));
const markdownFiles = files.filter((file) => file.endsWith(".md"));
const llmsFiles = files.filter((file) => file.endsWith(`${sep}llms.txt`));
const llmsCorpus = llmsFiles.map((file) => readFileSync(file, "utf8")).join("\n");

assert.ok(htmlFiles.length > 0, "Expected at least one public HTML page.");
assert.equal(markdownFiles.length, htmlFiles.length, "Every public HTML page must have exactly one Markdown companion.");
assert.ok(llmsFiles.some((file) => file === join(outputDirectory, "llms.txt")), "Missing /llms.txt.");

const rootLlms = readFileSync(join(outputDirectory, "llms.txt"), "utf8");
assert.match(rootLlms, /^# Artifact Server\n\n> /, "/llms.txt must start with an H1 and project summary blockquote.");

for (const htmlFile of htmlFiles) {
  const html = readFileSync(htmlFile, "utf8");
  const htmlPath = publicPath(htmlFile);
  const expectedMarkdownFile = htmlFile.endsWith(`${sep}index.html`)
    ? join(dirname(htmlFile), "index.md")
    : htmlFile.replace(/\.html$/, ".md");
  const expectedMarkdownPath = publicPath(expectedMarkdownFile);

  assert.ok(existsSync(expectedMarkdownFile), `${htmlPath} is missing ${expectedMarkdownPath}.`);

  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
  const markdownLink = links.find((link) =>
    attribute(link, "rel") === "alternate" && attribute(link, "type") === "text/markdown"
  );
  assert.ok(markdownLink, `${htmlPath} does not advertise a Markdown alternate.`);

  const markdownHref = attribute(markdownLink, "href");
  assert.ok(markdownHref, `${htmlPath} has an empty Markdown alternate.`);
  assert.equal(new URL(markdownHref, canonicalOrigin).pathname, expectedMarkdownPath);

  const describedByLink = links.find((link) => attribute(link, "rel") === "describedby");
  assert.ok(describedByLink, `${htmlPath} does not point to a covering llms.txt.`);

  const describedByHref = attribute(describedByLink, "href");
  assert.ok(describedByHref, `${htmlPath} has an empty describedby link.`);
  const llmsPath = new URL(describedByHref, canonicalOrigin).pathname;
  const expectedLlmsPath = htmlPath.startsWith("/docs/") ? "/docs/llms.txt" : "/llms.txt";
  assert.equal(llmsPath, expectedLlmsPath, `${htmlPath} does not use its most specific llms.txt index.`);
  assert.ok(llmsPath.endsWith("/llms.txt"), `${htmlPath} describedby does not target llms.txt.`);
  assert.ok(existsSync(join(outputDirectory, llmsPath.slice(1))), `${htmlPath} points at missing ${llmsPath}.`);

  const absoluteMarkdownUrl = new URL(expectedMarkdownPath, canonicalOrigin).href;
  assert.ok(llmsCorpus.includes(absoluteMarkdownUrl), `${expectedMarkdownPath} is absent from the llms.txt indexes.`);
}

for (const markdownFile of markdownFiles) {
  const markdown = readFileSync(markdownFile, "utf8");
  const markdownPath = publicPath(markdownFile);
  const expectedHtmlFile = markdownFile.endsWith(`${sep}index.md`)
    ? join(dirname(markdownFile), "index.html")
    : markdownFile.replace(/\.md$/, ".html");

  assert.ok(existsSync(expectedHtmlFile), `${markdownPath} has no public HTML companion.`);
  assert.match(markdown, /^# /m, `${markdownPath} has no H1.`);

  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1];
    let url;
    try {
      url = new URL(href, canonicalOrigin);
    } catch {
      continue;
    }
    if (url.origin !== canonicalOrigin) continue;

    assert.ok(
      !url.pathname.endsWith("/"),
      `${markdownPath} links to HTML route ${url.pathname}; link to its index.md alternate.`,
    );

    if (url.pathname.endsWith(".md") || url.pathname.endsWith(".mdx")) {
      assert.ok(
        existsSync(join(outputDirectory, url.pathname.slice(1))),
        `${markdownPath} links to missing ${url.pathname}.`,
      );
    }
  }
}

process.stdout.write(
  `Verified ${htmlFiles.length} HTML/Markdown route pairs, internal Markdown links, and ${llmsFiles.length} llms.txt indexes.\n`,
);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function publicPath(file) {
  return `/${relative(outputDirectory, file).split(sep).join("/")}`;
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1] ?? null;
}
