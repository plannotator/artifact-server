import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const bootstrapResponseSchema = z.object({
  bootstrapUrl: z.url(),
  expiresAt: z.string(),
  versionId: z.string(),
});

describe("private content sessions", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-014-B AUTH-015-B: one bootstrap opens one private immutable site through a host-only session", async () => {
    const files: readonly TestSiteFile[] = [
      {
        bytes: new TextEncoder().encode(
          '<!doctype html><link rel="stylesheet" href="/styles/site.css"><title>Private</title>',
        ),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
      {
        bytes: new TextEncoder().encode("body { color: rebeccapurple; }"),
        mediaType: "text/css; charset=utf-8",
        path: "styles/site.css",
      },
    ];
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    const uploads = await uploadEveryStagedFile(
      installation,
      planned.body,
      files,
    );
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "private-content-session-publication",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Private complete site",
      },
    );

    const unauthenticated = await fetchVersion(
      server,
      published.body.links.version,
    );
    expect(unauthenticated.status).toBe(401);

    const issueResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    expect(issueResponse.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await issueResponse.json());
    expect(issued.versionId).toBe(published.body.version.id);

    await server.stop();
    server = await startTestServer(installation);

    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("cache-control")).toBe("private, no-store");
    expect(exchange.headers.get("referrer-policy")).toBe("no-referrer");
    const location = exchange.headers.get("location");
    expect(location).not.toContain("token=");
    const setCookie = requiredHeader(exchange.headers, "set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
    const cookie = setCookie.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content cookie is empty.");

    const replay = await fetchVersion(server, issued.bootstrapUrl);
    expect(replay.status).toBe(401);

    await server.stop();
    server = await startTestServer(installation);

    const html = await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      {Cookie: cookie},
    );
    expect(html.status).toBe(200);
    expect(html.headers.get("cache-control")).toBe("private, no-store");
    expect(html.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await html.text()).toContain("Private");

    const stylesheetUrl = new URL(
      "/styles/site.css",
      published.body.links.version,
    ).toString();
    const stylesheet = await fetchVersion(
      server,
      stylesheetUrl,
      "GET",
      {Cookie: cookie},
    );
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toContain("rebeccapurple");
  });

  test("foundation: content sessions cannot cross version hosts or authorize writes", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>First private artifact</title>",
      idempotencyKey: "first-private-session-host-binding",
    });
    const unauthorizedIssue = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/content-sessions`,
      {method: "POST"},
    );
    expect(unauthorizedIssue.status).toBe(401);
    const issueResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    const issued = bootstrapResponseSchema.parse(await issueResponse.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const cookie = requiredHeader(exchange.headers, "set-cookie").split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content cookie is empty.");

    const second = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Second private artifact</title>",
      idempotencyKey: "second-private-session-host-binding",
    });
    const wrongHost = await fetchVersion(
      server,
      second.body.links.version,
      "GET",
      {Cookie: cookie},
    );
    expect(wrongHost.status).toBe(401);

    const write = await fetchVersion(
      server,
      first.body.links.version,
      "POST",
      {Cookie: cookie},
    );
    expect(write.status).toBe(405);

    const applicationRouteOnContentHost = new URL(
      "/api/v1/artifacts",
      first.body.links.version,
    ).toString();
    const isolated = await fetchVersion(
      server,
      applicationRouteOnContentHost,
      "GET",
      {Cookie: cookie},
    );
    expect(isolated.status).toBe(404);
  });
});

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}
