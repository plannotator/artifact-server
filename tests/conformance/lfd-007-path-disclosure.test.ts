import {createServer} from "node:http";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {defaultProject, expectFailure, LinkedFolderClient} from "../support/linked-folders.js";
import {
  createTestInstallation, fetchVersion, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const nonMemberCredential = "lfd-007-non-member-credential";
const nonMemberVerifier: BearerCredentialVerifier = {
  verify: (credential) => Redacted.value(credential) === nonMemberCredential
    ? Effect.succeed({
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Unscoped automation",
      id: "service:lfd_007_non_member",
      installationId: "local",
      kind: "service",
      membershipRole: "member",
    })
    : Effect.fail(new AuthenticationRequired({message: "The external credential is invalid."})),
};
const liveSessionSchema = z.object({bootstrapUrl: z.string(), expiresAt: z.string()}).strict();
const bootstrapSchema = z.object({bootstrapUrl: z.string()}).loose();
const projectSchema = z.object({project: z.object({id: z.string()}).loose()}).loose();
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  links: z.object({version: z.string()}).loose(),
  version: z.object({id: z.string()}).loose(),
}).loose();

function contentCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.includes("artifact_content="));
  if (cookie === undefined) throw new Error("No content cookie was set.");
  return cookie.split(";")[0] ?? "";
}

function liveEntryUrl(bootstrapUrl: string): string {
  const url = new URL(bootstrapUrl);
  url.search = "";
  return url.toString();
}

describe("linked paths stay on authenticated local application responses", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  const restoreEnvironment = new Map<string, string | undefined>();

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-007-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    for (const [name, value] of restoreEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restoreEnvironment.clear();
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-007-B: an admitted local member reads link and inventory paths and previews an untracked entry live with no-store caching", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    await writeFile(path.join(sourceRoot, "draft.md"), "# first draft\n");
    const link = await client.linkOk(sourceRoot, {name: "Drafts"});
    expect(link.path).toBe(sourceRoot);
    const [entry] = await client.inventory(link.id);
    expect(entry).toMatchObject({relativePath: "draft.md", state: "untracked"});

    const issued = await client.request(`/api/v1/folder-links/${link.id}/entries/${entry?.id ?? ""}/live-sessions`, "POST");
    expect(issued.status).toBe(201);
    const {bootstrapUrl} = liveSessionSchema.parse(await issued.json());
    expect(new URL(bootstrapUrl).hostname).toBe(`live-fle-${(entry?.id ?? "").slice(4)}.localhost`);
    const exchanged = await fetchVersion(server, bootstrapUrl);
    expect(exchanged.status).toBe(200);
    const cookie = contentCookie(exchanged);
    const first = await fetchVersion(server, liveEntryUrl(bootstrapUrl), "GET", {Cookie: cookie});
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("content-type")).toContain("text/markdown");
    expect(await first.text()).toBe("# first draft\n");
    await writeFile(path.join(sourceRoot, "draft.md"), "# second draft, still untracked\n");
    const second = await fetchVersion(server, liveEntryUrl(bootstrapUrl), "GET", {Cookie: cookie});
    expect(await second.text()).toBe("# second draft, still untracked\n");
    expect((await fetchVersion(server, bootstrapUrl)).status).toBe(401);
  }, 30_000);

  test("LFD-007-F: public-link, anonymous, non-member, and version-session callers never receive a path or live byte, telemetry names no path, and forged IDs answer not-found", async () => {
    const signals: string[] = [];
    const collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        signals.push(`${request.url ?? ""} ${Buffer.concat(chunks).toString("utf8")}`);
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const port = z.object({port: z.number()}).loose().parse(collector.address()).port;
    for (const [name, value] of Object.entries({
      OTEL_BLRP_SCHEDULE_DELAY: "25",
      OTEL_BSP_SCHEDULE_DELAY: "25",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_TIMEOUT: "100",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_METRIC_EXPORT_INTERVAL: "25",
      OTEL_TRACES_EXPORTER: "otlp",
    })) {
      restoreEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      server = await startTestServer(installation, {
        completedRequestLogSampleRate: 1,
        externalApiBearerVerifier: nonMemberVerifier,
        linkRoots: [sourceRoot],
        linkedFiles: "on",
        linkedFolderWatch: "off",
        observability: true,
      });
      const client = new LinkedFolderClient(server, installation.apiToken);
      await writeFile(path.join(sourceRoot, "secret-plan.md"), "# untracked secret plan\n");
      await writeFile(path.join(sourceRoot, "shared-report.md"), "# shared report\n");
      const link = await client.linkOk(sourceRoot, {name: "Private"});
      const entries = await client.inventory(link.id);
      const secret = entries.find((entry) => entry.relativePath === "secret-plan.md");
      const shared = entries.find((entry) => entry.relativePath === "shared-report.md");
      const [captured] = await client.captureOk(link.id, {entryIds: [shared?.id ?? ""]});
      const issued = liveSessionSchema.parse(await (await client.request(
        `/api/v1/folder-links/${link.id}/entries/${secret?.id ?? ""}/live-sessions`, "POST",
      )).json());
      const liveUrl = liveEntryUrl(issued.bootstrapUrl);

      const anonymousLink = await fetch(new URL(`/api/v1/folder-links/${link.id}`, server.baseUrl));
      expect(anonymousLink.status).toBe(401);
      expect(await anonymousLink.text()).not.toContain(sourceRoot);
      const anonymousLive = await fetchVersion(server, liveUrl);
      expect(anonymousLive.status).toBe(401);
      expect(await anonymousLive.text()).not.toContain("secret plan");

      const nonMember = new LinkedFolderClient(server, nonMemberCredential);
      for (const pathname of [
        `/api/v1/folder-links/${link.id}`,
        `/api/v1/folder-links/${link.id}/inventory`,
        `/api/v1/projects/${defaultProject}/folder-links`,
      ]) {
        // Each surface is checked independently.
        // eslint-disable-next-line no-await-in-loop
        const denied = await nonMember.request(pathname);
        expect(denied.status).toBe(403);
        // eslint-disable-next-line no-await-in-loop
        expect(await denied.text()).not.toContain(sourceRoot);
      }
      const nonMemberLive = await nonMember.request(`/api/v1/folder-links/${link.id}/entries/${secret?.id ?? ""}/live-sessions`, "POST");
      expect(nonMemberLive.status).toBe(403);

      const madePublic = await client.request(`/api/v1/artifacts/${captured?.artifactId ?? ""}/access`, "PATCH", {
        accessSetting: "public_link", expectedCurrentVersionId: captured?.versionId ?? "",
      });
      expect(madePublic.status).toBe(200);
      const publication = publicationSchema.parse(await madePublic.json());
      const publicRead = await fetchVersion(server, publication.links.version);
      expect(publicRead.status).toBe(200);
      const publicHeaders = JSON.stringify([...publicRead.headers]);
      expect(`${publicHeaders}${await publicRead.text()}`).not.toContain(sourceRoot);
      const publicRedirect = await fetch(new URL(`/artifacts/${captured?.artifactId ?? ""}`, server.baseUrl), {redirect: "manual"});
      expect(publicRedirect.headers.get("location") ?? "").not.toContain(sourceRoot);
      expect((await fetchVersion(server, liveUrl)).status).toBe(401);

      const versionSession = bootstrapSchema.parse(await (await client.request(
        `/api/v1/artifacts/${captured?.artifactId ?? ""}/content-sessions`, "POST",
      )).json());
      const versionCookie = contentCookie(await fetchVersion(server, versionSession.bootstrapUrl));
      const crossOrigin = await fetchVersion(server, liveUrl, "GET", {Cookie: versionCookie});
      expect(crossOrigin.status).toBe(401);
      expect(await crossOrigin.text()).not.toContain("secret plan");

      const otherProject = projectSchema.parse(await (await client.request("/api/v1/projects", "POST", {name: "Other"})).json()).project.id;
      await expectFailure(await client.request(`/api/v1/folder-links/${link.id}?projectId=${otherProject}`), 404, "FOLDER_LINK_NOT_FOUND");
      await expectFailure(
        await client.request(`/api/v1/folder-links/${link.id}/inventory?projectId=${otherProject}`),
        404, "FOLDER_LINK_NOT_FOUND",
      );
      await expectFailure(await client.request(
        `/api/v1/folder-links/flk_00000000-0000-4000-8000-000000000000/entries/${secret?.id ?? ""}/live-sessions`, "POST",
      ), 404, "FOLDER_LINK_NOT_FOUND");
      await expectFailure(await client.request(
        `/api/v1/folder-links/${link.id}/entries/fle_00000000-0000-4000-8000-000000000000/live-sessions`, "POST",
      ), 404, "INVENTORY_ENTRY_NOT_FOUND");

      await client.scan(link.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await server.stop();
      server = null;
      const telemetry = signals.join("\n");
      expect(telemetry).toContain("/v1/logs");
      expect(telemetry).toContain("/v1/metrics");
      for (const disclosed of [sourceRoot, "secret-plan.md", "shared-report.md", path.basename(sourceRoot)]) {
        expect(telemetry).not.toContain(disclosed);
      }
    } finally {
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  }, 60_000);
});
