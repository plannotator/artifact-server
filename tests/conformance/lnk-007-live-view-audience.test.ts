import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Principal} from "../../src/core/identity.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const nonMemberCredential = "lnk-007-non-member-service";

const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string().min(1)}).loose(),
  links: z.object({
    live: z.string().min(1),
    version: z.string().min(1),
  }).loose(),
  version: z.object({id: z.string().min(1)}).loose(),
  sourceBinding: z.object({
    status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
  }).loose(),
}).loose();

const liveSessionSchema = z.object({
  bootstrapUrl: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();

const bootstrapResponseSchema = z.object({
  bootstrapUrl: z.string().min(1),
}).loose();

const capturedBytes = "# captured state\n";
const driftedBytes = "# live drifted bytes\n";

function contentCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.includes("artifact_content=")
  );
  if (cookie === undefined) throw new Error("No content cookie was set.");
  return (cookie.split(";")[0] ?? "");
}

describe("the live view reaches only authenticated local members", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-007-sources-")),
    );
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  async function linkOne(
    activeServer: RunningTestServer,
    key: string,
  ): Promise<z.infer<typeof linkedPublicationSchema>> {
    const source = path.join(sourceRoot, "live.md");
    await writeFile(source, capturedBytes);
    const response = await fetch(
      new URL("/api/v1/artifacts/link", activeServer.baseUrl),
      {
        body: JSON.stringify({path: source}),
        headers: apiHeaders(installation, key),
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return linkedPublicationSchema.parse(await response.json());
  }

  async function memberLiveCookie(
    activeServer: RunningTestServer,
    artifactId: string,
    key: string,
  ): Promise<string> {
    const issued = liveSessionSchema.parse(await (await fetch(
      new URL(`/api/v1/artifacts/${artifactId}/live-sessions`, activeServer.baseUrl),
      {headers: apiHeaders(installation, key), method: "POST"},
    )).json());
    const exchanged = await fetchVersion(activeServer, issued.bootstrapUrl);
    expect(exchanged.status).toBe(200);
    return contentCookie(exchanged);
  }

  test("LNK-007-B: a local member streams the live bytes no-store while captured versions stay immutably cached", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const activeServer = server;
    const linked = await linkOne(activeServer, "lnk-007-b-link-000001");
    const cookie = await memberLiveCookie(activeServer, linked.artifact.id, "lnk-007-b-live-000001");

    const first = await fetchVersion(server, linked.links.live, "GET", {Cookie: cookie});
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.text()).toBe(capturedBytes);

    const source = path.join(sourceRoot, "live.md");
    await writeFile(source, driftedBytes);
    const second = await fetchVersion(server, linked.links.live, "GET", {Cookie: cookie});
    expect(second.status).toBe(200);
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(second.headers.get("artifact-source-freshness")).toBe("modified");
    expect(await second.text()).toBe(driftedBytes);

    // The captured version is held still: it keeps serving the captured bytes even
    // though the disk drifted, and it carries no live freshness header — a separate
    // delivery path from the live origin.
    const versionSession = bootstrapResponseSchema.parse(await (await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}/content-sessions`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    )).json());
    const versionCookie = contentCookie(
      await fetchVersion(server, versionSession.bootstrapUrl),
    );
    const versionRead = await fetchVersion(server, linked.links.version, "GET", {
      Cookie: versionCookie,
    });
    expect(versionRead.status).toBe(200);
    expect(versionRead.headers.get("artifact-source-freshness")).toBeNull();
    expect(await versionRead.text()).toBe(capturedBytes);
  });

  test("LNK-007-F: anonymous, cross-origin, public-link, and non-member readers never receive a live byte, and a missing source degrades to the capture", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: nonMemberVerifier,
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const activeServer = server;
    const linked = await linkOne(activeServer, "lnk-007-f-link-000001");

    // Anonymous requests to the live origin get no bytes.
    const anonymous = await fetchVersion(server, linked.links.live);
    expect(anonymous.status).toBe(401);

    // A version content-origin cookie does not authorize the live origin.
    const versionSession = bootstrapResponseSchema.parse(await (await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}/content-sessions`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    )).json());
    const versionCookie = contentCookie(
      await fetchVersion(server, versionSession.bootstrapUrl),
    );
    const crossOrigin = await fetchVersion(server, linked.links.live, "GET", {
      Cookie: versionCookie,
    });
    expect(crossOrigin.status).toBe(401);

    // A non-member service principal cannot even open a live session.
    const nonMember = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}/live-sessions`, server.baseUrl),
      {
        headers: {
          Authorization: `Bearer ${nonMemberCredential}`,
          "Idempotency-Key": "lnk-007-f-nonmember-01",
        },
        method: "POST",
      },
    );
    expect(nonMember.status).toBe(403);

    // Public-link possession serves only the captured version, even after the disk drifts.
    const madePublic = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}/access`, server.baseUrl),
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: linked.version.id,
        }),
        headers: apiHeaders(installation, "lnk-007-f-public-0001"),
        method: "PATCH",
      },
    );
    expect(madePublic.status).toBe(200);
    await writeFile(path.join(sourceRoot, "live.md"), driftedBytes);

    const publicVersion = await fetchVersion(server, linked.links.version);
    expect(publicVersion.status).toBe(200);
    expect(await publicVersion.text()).toBe(capturedBytes);
    const publicLive = await fetchVersion(server, linked.links.live);
    expect(publicLive.status).toBe(401);

    // A missing source degrades the live view to the last captured bytes rather than erroring.
    const cookie = await memberLiveCookie(activeServer, linked.artifact.id, "lnk-007-f-live-0001");
    await rm(path.join(sourceRoot, "live.md"), {force: true});
    const degraded = await fetchVersion(server, linked.links.live, "GET", {Cookie: cookie});
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get("cache-control")).toBe("private, no-store");
    expect(await degraded.text()).toBe(capturedBytes);
  });
});

const nonMemberPrincipals: ReadonlyMap<string, Principal> = new Map([
  [nonMemberCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Unscoped automation",
    id: "service:lnk_007_non_member",
    installationId: "local",
    kind: "service",
    membershipRole: "member",
  }],
]);

const nonMemberVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const principal = nonMemberPrincipals.get(Redacted.value(credential));
    return principal === undefined
      ? Effect.fail(new AuthenticationRequired({
        message: "The external credential is invalid.",
      }))
      : Effect.succeed(principal);
  },
};
