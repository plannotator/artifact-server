import {expect, test, type Request} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  uploadEveryStagedFile,
  type PublishResponse,
} from "../support/publishing.js";
import {listThreadsOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";

function reviewUrl(fixture: BrowserFixture, publication: PublishResponse): string {
  return `${fixture.server.baseUrl}/review?project=prj_default&artifact=${publication.artifact.id}&version=${publication.version.id}`;
}

const richSource = `# Native document\n\nOriginal **formatted** text.\n\n[Jump to title](#native-document)\n\n| Name | Value |\n| --- | --- |\n| Markdown | Native |\n\n- [x] Complete\n- [ ] Pending\n\n~~~typescript\nconst answer: number = 42;\n~~~\n\n~~~mermaid\ngraph TD\n  Start --> Finish\n~~~\n\n## Foo\n\n## Foo\n\n## Foo-1\n`;

test.describe("Native Markdown review", () => {
  test("MDV-001-B: GFM preview, literal source, download and immutable history", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: richSource,
        idempotencyKey: "markdown-preview-rich", mediaType: "text/markdown; charset=utf-8",
        name: "Native Markdown", path: "docs/readme.md",
      })).body;
      const second = (await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.artifact.id, content: "# Second immutable version\n",
        expectedCurrentVersionId: first.version.id, idempotencyKey: "markdown-new-version",
        mediaType: "text/markdown", path: "docs/readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, first));
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(document.getByRole("heading", {name: "Native document"})).toBeVisible();
      await expect(document.getByRole("table")).toContainText("Markdown");
      await expect(document.getByRole("checkbox")).toHaveCount(2);
      await expect(document.getByRole("checkbox").first()).toBeChecked();
      const headingIds = await document.locator("h2").evaluateAll((nodes) => nodes.map((node) => node.id));
      expect(new Set(headingIds).size).toBe(3);
      await fixture.page.getByRole("tab", {name: "Preview", exact: true}).focus();
      await fixture.page.keyboard.press("ArrowRight");
      await expect(fixture.page.getByRole("tab", {name: "Source", exact: true})).toBeFocused();
      expect(await fixture.page.locator(".as-markdown-preview__source code").textContent()).toBe(richSource);
      const download = fixture.page.getByRole("link", {name: "Download file"});
      const href = await download.getAttribute("href");
      expect(href).toContain(first.version.id);
      if (href === null) throw new Error("Markdown download is unavailable.");
      const response = await fixture.context.request.get(new URL(href, fixture.server.baseUrl).toString());
      expect(response.ok()).toBe(true);
      expect(await response.text()).toBe(richSource);
      await fixture.page.getByRole("button", {name: "Use light theme"}).click();
      await expect(fixture.page.getByRole("tab", {name: "Source", exact: true})).toHaveAttribute("aria-selected", "true");
      await fixture.page.getByRole("tab", {name: "Preview", exact: true}).click();
      await expect(document.getByRole("heading", {name: "Native document"})).toBeVisible();
      await expect.poll(() => document.locator("html").evaluate((node) => getComputedStyle(node).colorScheme)).toBe("light");
      await fixture.page.getByRole("button", {name: /^Annotate mode:/u}).click();
      await document.getByRole("link", {name: "Jump to title"}).click();
      await expect(document.getByRole("heading", {name: "Native document"})).toBeVisible();
      await expect.poll(() => document.locator("html").evaluate(() => window.location.hash)).toBe("#native-document");
      await fixture.page.goto(reviewUrl(fixture, second));
      await expect(document.getByRole("heading", {name: "Second immutable version"})).toBeVisible();
      await fixture.page.goto(reviewUrl(fixture, first));
      await expect(document.getByRole("heading", {name: "Native document"})).toBeVisible();
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-001-F: declared MIME controls routing and oversized Markdown has a bounded fallback", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const unknown = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: "# Must not be rendered",
        idempotencyKey: "markdown-unknown", mediaType: "application/octet-stream", path: "readme.md",
      })).body;
      const large = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: "x".repeat(1_048_577),
        idempotencyKey: "markdown-preview-large", mediaType: "text/markdown", path: "large.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, unknown));
      await expect(fixture.page.getByRole("heading", {name: "Preview not supported"})).toBeVisible();
      await expect(fixture.page.getByRole("tab", {name: "Source", exact: true})).toHaveCount(0);
      await fixture.page.goto(reviewUrl(fixture, large));
      await expect(fixture.page.getByRole("alert")).toContainText("up to 1 MiB");
      await expect(fixture.page.getByRole("link", {name: "Download file"}).first()).toBeVisible();
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-002-B MDV-002-F: highlighted code, Mermaid and readable malformed diagram fallback", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const publication = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `${richSource}\n~~~mermaid\nnot a diagram !!!\n~~~\n\n~~~unrecognized-language\n<literal> & code\n~~~`,
        idempotencyKey: "markdown-diagrams", mediaType: "text/markdown", path: "readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, publication));
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(document.locator("pre.shiki span[style]").first()).toBeVisible();
      await expect(document.locator("svg")).toHaveCount(1);
      await expect(document.locator("svg")).toContainText("Start");
      await expect(document.locator("pre").filter({hasText: "not a diagram !!!"})).toBeVisible();
      await expect(document.locator("pre").filter({hasText: "<literal> & code"})).toBeVisible();
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-003-F: raw HTML, unsafe links and Mermaid overrides cannot inject active content", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const hostile = `# Safe document\n\n<script>parent.document.body.dataset.mdCompromised='yes'</script>\n\n<img src=x onerror="parent.document.body.dataset.mdCompromised='yes'">\n\n[Unsafe](javascript:alert(1))\n\n![External](https://attacker.invalid/pixel.png)\n\n![Traversal](%2e%2e/%2e%2e/private.png)\n\n~~~mermaid\n%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\ngraph TD\n A[Safe] --> B[Document]\n click A "javascript:alert(1)"\n~~~`;
      const publication = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: hostile, idempotencyKey: "markdown-hostile",
        mediaType: "text/markdown", path: "docs/readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, publication));
      const review = fixture.page.frameLocator(".as-artifact-frame");
      const document = review.frameLocator("iframe");
      await expect(document.getByRole("heading", {name: "Safe document"})).toBeVisible();
      await expect(review.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      await expect(document.locator("iframe, object, embed, foreignObject, [onerror], [onclick]")).toHaveCount(0);
      await expect(document.locator('a[href^="javascript:"], img[src*="attacker.invalid"], img[src*="private.png"]')).toHaveCount(0);
      expect((await document.locator("script").allTextContents()).join("\n")).not.toContain("parent.document.body.dataset.mdCompromised='yes'");
      await expect(fixture.page.locator("body")).not.toHaveAttribute("data-md-compromised", "yes");
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-003-B: nested bundled images and anchored comments remain version scoped", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const files = [
        {bytes: new TextEncoder().encode("# Bundled document\n\nReview this paragraph.\n\n![Bundled image](../assets/pixel.svg)\n\n![Spaced image](<../assets/space name.svg>)\n\n[Bundled file](../assets/pixel.svg)\n"), mediaType: "text/markdown", path: "docs/readme.md"},
        {bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>'), mediaType: "image/svg+xml", path: "assets/pixel.svg"},
        {bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>'), mediaType: "image/svg+xml", path: "assets/space name.svg"},
      ];
      const staged = await createStagedUpload(fixture.server, fixture.installation, "docs/readme.md", files);
      for (const response of await uploadEveryStagedFile(fixture.installation, staged.body, files)) expect(response.ok).toBe(true);
      const publication = (await commitStagedUpload(fixture.installation, staged.body, "markdown-preview-bundle", {
        accessSetting: "account_required", kind: "new_artifact", name: "Markdown bundle",
      })).body;
      const next = (await publishVersion(fixture.server, fixture.installation, {
        artifactId: publication.artifact.id, content: "# New document\n\nNo previous feedback.\n",
        expectedCurrentVersionId: publication.version.id, idempotencyKey: "markdown-bundle-new",
        mediaType: "text/markdown", path: "docs/readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, publication));
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      const image = document.getByRole("img", {name: "Bundled image"});
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(12);
      const spacedImage = document.getByRole("img", {name: "Spaced image"});
      await expect.poll(() => spacedImage.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(12);
      await expect(spacedImage).toHaveAttribute("src", /space%20name\.svg/u);
      const src = await image.getAttribute("src");
      expect(src).toContain("/assets/pixel.svg");
      expect(await document.getByRole("link", {name: "Bundled file"}).getAttribute("href")).toBe(src);
      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      await document.getByText("Review this paragraph.", {exact: true}).click();
      const composer = reviewFrame.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Markdown anchored feedback");
      await fixture.page.getByRole("button", {name: "Use light theme"}).click();
      await expect.poll(() => document.locator("html").evaluate((node) => getComputedStyle(node).colorScheme)).toBe("light");
      await expect(composer).toHaveValue("Markdown anchored feedback");
      await reviewFrame.getByRole("button", {name: "Save", exact: true}).click();
      await expect(fixture.page.getByText("Markdown anchored feedback", {exact: true})).toBeVisible();
      await expect(async () => {
        const stored = await listThreadsOverApi(fixture, publication.artifact.id);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.path).toBe("docs/readme.md");
        expect(stored[0]?.versionId).toBe(publication.version.id);
        expect(stored[0]?.anchor).not.toBeNull();
      }).toPass();
      await fixture.page.reload();
      await expect(document.locator("button[data-plannotator-marker]")).toHaveCount(1);
      await fixture.page.goto(reviewUrl(fixture, next));
      await expect(document.getByRole("heading", {name: "New document"})).toBeVisible();
      await fixture.page.getByRole("tab", {name: /^Comments/u}).click();
      await expect(fixture.page.getByText("Markdown anchored feedback", {exact: true})).toHaveCount(0);
      await expect(document.locator("button[data-plannotator-marker]")).toHaveCount(0);
      await fixture.page.goto(`${reviewUrl(fixture, publication)}&view=focus`);
      await expect(document.getByRole("heading", {name: "Bundled document"})).toBeVisible();
      await fixture.page.setViewportSize({width: 375, height: 720});
      const sourceTab = fixture.page.getByRole("tab", {name: "Source", exact: true});
      await expect(sourceTab).toBeVisible();
      const download = fixture.page.getByRole("link", {name: "Download file"});
      await expect(download).toBeVisible();
      const controlBounds = await Promise.all([sourceTab, download].map((control) => control.boundingBox()));
      for (const bounds of controlBounds) {
        expect(bounds).not.toBeNull();
        expect((bounds?.x ?? -1) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
      }
      await sourceTab.click();
      await expect(fixture.page.getByRole("button", {name: /Annotate mode|Interact mode/u})).toHaveCount(0);
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-001-F: original Source survives a failed preview lease and retry recovers", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const source = "# Recoverable source\n\nOriginal bytes remain readable.\n";
      const publication = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: source, idempotencyKey: "markdown-preview-lease-recovery",
        mediaType: "text/markdown", path: "readme.md",
      })).body;
      await localLogin(fixture);
      let attempts = 0;
      await fixture.page.route("**/preview-leases?*", async (route) => {
        attempts += 1;
        if (attempts === 1) {
          const response = await route.fetch();
          await route.fulfill({response, status: 503, json: {error: "Preview lease temporarily unavailable"}});
        } else {
          await route.continue();
        }
      });
      await fixture.page.goto(reviewUrl(fixture, publication));
      await expect(fixture.page.getByRole("heading", {name: "Preview unavailable"})).toBeVisible();
      await fixture.page.getByRole("tab", {name: "Source", exact: true}).click();
      expect(await fixture.page.locator(".as-markdown-preview__source code").textContent()).toBe(source);
      await fixture.page.getByRole("tab", {name: "Preview", exact: true}).click();
      await fixture.page.getByRole("button", {name: "Retry preview"}).click();
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(document.getByRole("heading", {name: "Recoverable source"})).toBeVisible();
      expect(attempts).toBe(2);
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-003-F: delayed real source cannot replace a newly selected immutable version", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    let releaseSource: (() => void) | undefined;
    try {
      const first = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: "# Delayed document\n", idempotencyKey: "markdown-preview-delayed",
        mediaType: "text/markdown", path: "readme.md",
      })).body;
      const second = (await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.artifact.id, expectedCurrentVersionId: first.version.id,
        content: "# Selected document\n\n![Missing image](absent.png)\n\n[Missing file](absent.txt)\n",
        idempotencyKey: "markdown-preview-selected", mediaType: "text/markdown", path: "readme.md",
      })).body;
      await localLogin(fixture);
      let notifyHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { notifyHeld = resolve; });
      const released = new Promise<void>((resolve) => { releaseSource = resolve; });
      await fixture.page.route(`**/versions/${first.version.id}/file?*`, async (route) => {
        const response = await route.fetch();
        notifyHeld?.();
        await released;
        await route.fulfill({response});
      });
      await fixture.page.goto(reviewUrl(fixture, first));
      await held;
      await fixture.page.getByRole("tab", {name: /^Versions/u}).click();
      await fixture.page.getByRole("button", {name: /^Version 2/u}).click();
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(document.getByRole("heading", {name: "Selected document"})).toBeVisible();
      const delivered = fixture.page.waitForResponse((response) => response.url().includes(`/versions/${first.version.id}/file?`));
      releaseSource?.();
      await (await delivered).finished();
      await fixture.page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(document.getByRole("heading", {name: "Selected document"})).toBeVisible();
      await expect(document.getByRole("heading", {name: "Delayed document"})).toHaveCount(0);
      await expect(document.locator('img[src*="absent"], a[href*="absent"]')).toHaveCount(0);
      await expect(document.getByText("Missing image", {exact: true})).toBeVisible();
      await expect(document.getByText("Missing file", {exact: true})).toBeVisible();
      expect(fixture.page.url()).toContain(second.version.id);
    } finally {
      releaseSource?.();
      await stopBrowserFixture(fixture);
    }
  });

  test("MDV-002-F: document code budget falls back to literal code without losing Source", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const source = Array.from({length: 129}, (_, index) => `~~~typescript\nconst value${index} = ${index};\n~~~`).join("\n\n");
      const publication = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required", content: source, idempotencyKey: "markdown-preview-code-budget",
        mediaType: "text/markdown", path: "readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, publication));
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(document.locator("pre > code")).toHaveCount(129);
      await expect(document.locator("pre.shiki")).toHaveCount(128);
      await expect(document.locator("pre").last()).toHaveText("const value128 = 128;");
      await fixture.page.getByRole("tab", {name: "Source", exact: true}).click();
      expect(await fixture.page.locator(".as-markdown-preview__source code").textContent()).toBe(source);
    } finally { await stopBrowserFixture(fixture); }
  });

  test("MDV-002-F: hostile Mermaid image traffic is blocked before HTTP and later diagrams render", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const probeUrl = `${fixture.server.baseUrl}/diagram-resource-probe`;
      const requested: Request[] = [];
      const failed: Request[] = [];
      let reachedNetwork = 0;
      await fixture.context.route(`${probeUrl}*`, async (route) => {
        reachedNetwork += 1;
        await route.abort();
      });
      fixture.context.on("request", (request) => {
        if (request.url().startsWith(probeUrl)) requested.push(request);
      });
      fixture.context.on("requestfailed", (request) => {
        if (request.url().startsWith(probeUrl)) failed.push(request);
      });
      const publication = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `# Diagram resource safety\n\n~~~mermaid\ngraph TD\n A@{ img: "${probeUrl}", label: "Hostile image" }\n~~~\n\n~~~mermaid\ngraph TD\n Safe --> Finished\n~~~\n`,
        idempotencyKey: "markdown-preview-image-node", mediaType: "text/markdown", path: "readme.md",
      })).body;
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, publication));
      const document = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      // Two serialized diagram jobs each have an eight-second deadline,
      // including a cold classic-script load in this routed browser context.
      await expect(document.getByRole("heading", {name: "Diagram resource safety"})).toBeVisible({timeout: 20_000});
      await expect(document.locator("svg")).toHaveCount(1);
      await expect(document.locator("svg")).toContainText("Finished");
      await expect(document.locator("pre").filter({hasText: "Hostile image"})).toBeVisible();
      // Chromium reports CSP-blocked attempts as request events, although no
      // HTTP request reaches the routing boundary or receives a response.
      expect(reachedNetwork).toBe(0);
      await expect.poll(() => failed.length).toBe(requested.length);
      for (const request of failed) expect(request.failure()?.errorText).toMatch(/csp|content.security.policy/iu);
      expect(await Promise.all(requested.map((request) => request.response()))).toEqual(requested.map(() => null));
    } finally { await stopBrowserFixture(fixture); }
  });
});
