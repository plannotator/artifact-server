import {mkdir} from "node:fs/promises";
import path from "node:path";

import {chromium, type Page} from "@playwright/test";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";

const outputDirectory = path.resolve("project/evidence/frontend-mvp");
const installation = await createTestInstallation();
const server = await startTestServer(installation);
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({
  colorScheme: "light",
  viewport: {height: 900, width: 1440},
});
const page = await context.newPage();

try {
  await mkdir(outputDirectory, {recursive: true});
  await page.goto(server.baseUrl);
  await page.getByRole("link", {name: "Artifact Server"}).waitFor();

  await page.goto(`${server.baseUrl}/projects`);
  await page.getByRole("heading", {name: "Projects"}).waitFor();
  await capture(page, "light-projects.png");

  await page.goto(`${server.baseUrl}/projects/prj_default/artifacts`);
  await page.getByText("No artifacts yet").waitFor();
  await capture(page, "empty-artifacts.png");

  const first = await publishNew(server, installation, {
    accessSetting: "public_link",
    content: "<!doctype html><title>Release dashboard</title><p>Version one</p>",
    idempotencyKey: "frontend-screenshot-first",
    name: "Release dashboard",
    tags: ["approved", "release"],
  });
  await publishVersion(server, installation, {
    artifactId: first.body.artifact.id,
    content: "<!doctype html><title>Release dashboard</title><p>Version two</p>",
    expectedCurrentVersionId: first.body.version.id,
    idempotencyKey: "frontend-screenshot-second",
  });
  await page.reload();
  await page.getByText("Release dashboard").waitFor();
  await capture(page, "populated-artifacts.png");

  await page.getByRole("link", {name: "Release dashboard"}).click();
  await page.getByRole("heading", {name: "Release dashboard"}).waitFor();
  await page.getByRole("button", {name: "Dark theme"}).click();
  await capture(page, "dark-artifact-detail.png");

  await page.setViewportSize({height: 844, width: 390});
  await page.goto(`${server.baseUrl}/projects/prj_default/artifacts`);
  await page.getByText("Release dashboard").waitFor();
  await capture(page, "narrow-artifacts.png");

  await page.setViewportSize({height: 900, width: 1440});
  await page.goto(
    `${server.baseUrl}/projects/prj_default/artifacts/art_missing`,
  );
  await page.getByRole("heading", {name: "Request failed"}).waitFor();
  await capture(page, "error-not-found.png");
} finally {
  await context.close();
  await browser.close();
  await server.stop();
  await removeTestInstallation(installation);
}

async function capture(targetPage: Page, name: string): Promise<void> {
  await targetPage.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(outputDirectory, name),
  });
}
