import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {localLogin} from "./browser-fixture.js";

/** The link answer these tests read, mirroring the HTTP response shaping. */
const linkedPublicationSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    name: z.string(),
  }),
  links: z.object({artifact: z.url(), live: z.url(), version: z.url()}),
  replayed: z.boolean(),
  sourceBinding: z.object({
    lastVerifiedAt: z.string(),
    path: z.string(),
    status: z.enum(["in-sync", "missing", "modified", "unreadable"]),
  }),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});

const versionsSchema = z.object({
  artifactId: z.string(),
  versions: z.array(z.object({version: z.object({number: z.number()})})),
});

interface LinkedFixture {
  readonly context: BrowserContext;
  readonly installation: TestInstallation;
  /** The one directory this installation is allowed to link inside. */
  readonly linkRoot: string;
  readonly page: Page;
  readonly server: RunningTestServer;
}

/**
 * One installation with linked files enabled, its link root, and a signed-in
 * page. The shared browser fixture starts a server with the feature off, so
 * this test owns the two options that turn it on.
 */
async function startLinkedFixture(browser: Browser): Promise<LinkedFixture> {
  const installation = await createTestInstallation();
  // The link path is canonicalized before it is checked against the roots, so
  // the root has to be the real path too: on macOS the temporary directory is
  // reached through a symlink.
  const linkRoot = await mkdtemp(
    path.join(await realpath(tmpdir()), "artifact-server-link-root-"),
  );
  const server = await startTestServer(installation, {
    linkedFiles: "on",
    linkRoots: [linkRoot],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {context, installation, linkRoot, page, server};
}

async function stopLinkedFixture(fixture: LinkedFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
  await rm(fixture.linkRoot, {force: true, recursive: true});
}

/** Link one file the way an agent does: over the API, before the browser opens. */
async function linkOverApi(
  fixture: LinkedFixture,
  input: {
    readonly idempotencyKey: string;
    readonly name: string;
    readonly path: string;
  },
): Promise<z.infer<typeof linkedPublicationSchema>> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/artifacts/link`, {
    body: JSON.stringify({
      name: input.name,
      path: input.path,
      projectId: "prj_default",
    }),
    headers: apiHeaders(fixture.installation, input.idempotencyKey),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return linkedPublicationSchema.parse(await response.json());
}

async function versionCount(
  fixture: LinkedFixture,
  artifactId: string,
): Promise<number> {
  const response = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/versions?projectId=prj_default`,
    {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
  );
  expect(response.status).toBe(200);
  return versionsSchema.parse(await response.json()).versions.length;
}

const artifactReadSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}),
  links: z.object({artifact: z.url(), live: z.url(), management: z.url()}),
  sourceBinding: z.object({
    lastVerifiedAt: z.string(),
    path: z.string(),
    status: z.enum(["in-sync", "missing", "modified", "unreadable"]),
  }),
});

async function readArtifactOverApi(
  fixture: LinkedFixture,
  artifactId: string,
): Promise<z.infer<typeof artifactReadSchema>> {
  const response = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}?projectId=prj_default`,
    {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
  );
  expect(response.status).toBe(200);
  return artifactReadSchema.parse(await response.json());
}

function pageHtml(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${heading}</title></head>
  <body><h1>${heading}</h1><p>${body}</p></body>
</html>`;
}

test.describe("Linked artifacts", () => {
  test("a member sees the linked file's freshness follow the disk and captures it", async ({browser}) => {
    const fixture = await startLinkedFixture(browser);
    try {
      const sourcePath = path.join(fixture.linkRoot, "linked-report.html");
      await writeFile(
        sourcePath,
        pageHtml("Quarterly report", "The first draft is on disk."),
        "utf8",
      );

      const linked = await linkOverApi(fixture, {
        idempotencyKey: "linked-artifact-browser-link",
        name: "Quarterly report",
        path: sourcePath,
      });
      expect(linked.sourceBinding.status).toBe("in-sync");
      expect(linked.version.number).toBe(1);

      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${linked.artifact.id}`,
      );

      // The binding is ordinary artifact metadata: a row, a path, a badge.
      await expect(
        fixture.page.getByRole("heading", {name: "Quarterly report"}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "Linked source"})).toBeVisible();
      await expect(fixture.page.getByText(sourcePath, {exact: true})).toBeVisible();
      await expect(fixture.page.getByText("In sync", {exact: true})).toBeVisible();

      // Somebody edits the file. No version changes, nothing blocks the page:
      // the badge simply starts saying what is true, on the poll this screen
      // already runs for comments.
      await writeFile(
        sourcePath,
        pageHtml("Quarterly report", "The second draft is longer and on disk only."),
        "utf8",
      );
      await expect(
        fixture.page.getByText("Modified on disk", {exact: true}),
      ).toBeVisible({timeout: 30_000});
      await expect(
        fixture.page.getByText("A newer state exists on disk.", {exact: false}),
      ).toBeVisible();
      expect(await versionCount(fixture, linked.artifact.id)).toBe(1);

      // Capturing is the explicit, attributed act that moves the artifact.
      await fixture.page.getByRole("button", {name: "Capture current file"}).click();
      await expect(
        fixture.page.getByText("In sync", {exact: true}),
      ).toBeVisible({timeout: 30_000});
      await expect(fixture.page.getByRole("tab", {name: "Versions 2"})).toBeVisible();

      await expect(async () => {
        expect(await versionCount(fixture, linked.artifact.id)).toBe(2);
      }).toPass();

      // The capture is in the artifact's own attributed history.
      await fixture.page.getByRole("tab", {name: "Activity"}).click();
      await expect(
        fixture.page.getByText("Captured linked file", {exact: true}),
      ).toBeVisible();
      await expect(
        fixture.page.getByText("Linked source file", {exact: true}),
      ).toBeVisible();

      // Reviewing the current version offers the live file beside the captured
      // bytes, and a later edit stays ambient: the review never blocks on it.
      const read = await readArtifactOverApi(fixture, linked.artifact.id);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${linked.artifact.id}&version=${read.artifact.currentVersionId}`,
      );
      await expect(
        fixture.page.getByRole("heading", {name: "Quarterly report"}),
      ).toBeVisible();
      const liveButton = fixture.page.getByRole("button", {name: "Open live file"});
      await expect(liveButton).toBeVisible();

      await writeFile(
        sourcePath,
        pageHtml("Quarterly report", "The third draft is live on disk."),
        "utf8",
      );
      await expect(fixture.page.getByText("Modified on disk", {exact: true})).toBeVisible({timeout: 30_000});
      await expect(
        fixture.page.getByRole("heading", {name: "Quarterly report"}),
      ).toBeVisible();

      const [livePage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        liveButton.click(),
      ]);
      await expect(livePage.locator("body")).toContainText(
        "The third draft is live on disk.",
      );
      await livePage.close();
      // The live bytes moved nothing: the captured version is still version 2.
      expect(await versionCount(fixture, linked.artifact.id)).toBe(2);
    } finally {
      await stopLinkedFixture(fixture);
    }
  });
});
