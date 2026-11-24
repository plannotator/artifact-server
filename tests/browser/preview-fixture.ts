import {expect, type Page, type Request} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import type {BrowserFixture} from "./browser-fixture.js";

/** One published preview fixture's exact identity. */
export interface PublishedFixture {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** Publish `files` as a new artifact whose entry is the first file. */
export async function publishFixture(
  fixture: BrowserFixture,
  name: string,
  files: readonly TestSiteFile[],
): Promise<PublishedFixture> {
  const entry = files[0];
  if (entry === undefined) throw new Error("A preview fixture needs at least one file.");
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    entry.path,
    files,
  );
  expect(upload.response.status).toBe(201);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(
    fixture.installation,
    upload.body,
    `prv-more-previews-${name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`,
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name,
      tags: ["preview"],
    },
  );
  return {
    artifactId: committed.body.artifact.id,
    projectId: committed.body.artifact.projectId,
    versionId: committed.body.version.id,
  };
}

export async function openPath(
  fixture: BrowserFixture,
  published: PublishedFixture,
  path: string,
): Promise<void> {
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?${new URLSearchParams({
      artifact: published.artifactId,
      path,
      project: published.projectId,
      version: published.versionId,
    })}`,
  );
}

export function fileUrl(
  fixture: BrowserFixture,
  published: PublishedFixture,
  route: "file" | "media",
  path: string,
): string {
  return `${fixture.server.baseUrl}/api/v1/artifacts/${published.artifactId}/versions/${published.versionId}/${route}?${new URLSearchParams({
    path,
    projectId: published.projectId,
  })}`;
}

export function requestsFor(page: Page, route: "file" | "media", path: string): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.endsWith(`/${route}`)
      && url.searchParams.get("path") === path
    ) {
      seen.push(request);
    }
  });
  return seen;
}
