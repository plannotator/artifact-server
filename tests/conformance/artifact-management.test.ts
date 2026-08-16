import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";

const artifactRecordSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
});
const versionRecordSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number(),
  publisherPrincipalId: z.string(),
  routingMode: z.enum(["static", "spa"]),
});
const artifactVersionSchema = z.object({
  links: z.object({version: z.url()}),
  manifest: z.object({
    digest: z.string(),
    entries: z.array(z.object({
      disposition: z.enum(["attachment", "inline"]),
      mediaType: z.string(),
      path: z.string(),
      sha256: z.string(),
      size: z.number(),
    })),
    entryPath: z.string(),
    routingMode: z.enum(["static", "spa"]),
  }),
  version: versionRecordSchema,
});
const artifactDetailsSchema = z.object({
  artifact: artifactRecordSchema,
  current: artifactVersionSchema,
  links: z.object({artifact: z.url(), management: z.url()}),
});

const versionListSchema = z.object({
  artifactId: z.string(),
  versions: z.array(z.object({
    links: z.object({version: z.url()}),
    version: versionRecordSchema,
  })),
});

const mutationSchema = z.object({
  artifact: artifactRecordSchema,
  links: z.object({artifact: z.url(), version: z.url()}),
  replayed: z.boolean(),
  version: versionRecordSchema,
});

describe("artifact and version management", () => {
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

  test("ART-002-B ART-003-B ART-004-B VER-001-B VER-001-F: authenticated metadata exposes immutable history and exact earlier bytes", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Version one</title>",
      idempotencyKey: "management-metadata-first",
      name: "Managed artifact",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Version two</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "management-metadata-second",
    });

    const detailsResponse = await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}`,
    );
    expect(detailsResponse.status).toBe(200);
    const details = artifactDetailsSchema.parse(await detailsResponse.json());
    expect(details.artifact).toMatchObject({
      accessSetting: "public_link",
      currentVersionId: second.body.version.id,
      deletedAt: null,
      id: first.body.artifact.id,
      name: "Managed artifact",
    });
    expect(details.current.version).toMatchObject({
      artifactId: first.body.artifact.id,
      entryPath: "index.html",
      id: second.body.version.id,
      manifestDigest: second.body.version.manifestDigest,
      number: 2,
      publisherPrincipalId: "local-api-token",
      routingMode: "static",
    });
    expect(details.current.manifest.entries).toHaveLength(1);
    expect(details.current.manifest.digest).toBe(
      details.current.version.manifestDigest,
    );

    const listResponse = await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}/versions`,
    );
    const list = versionListSchema.parse(await listResponse.json());
    expect(list.versions.map(({version}) => version.id)).toEqual([
      second.body.version.id,
      first.body.version.id,
    ]);

    const firstMetadataResponse = await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}`,
    );
    const firstMetadata = artifactVersionSchema.parse(
      await firstMetadataResponse.json(),
    );
    expect(firstMetadata.version).toMatchObject({
      id: first.body.version.id,
      manifestDigest: first.body.version.manifestDigest,
      number: 1,
    });

    const bootstrapResponse = await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}/content-sessions`,
      {method: "POST"},
    );
    expect(bootstrapResponse.status).toBe(201);
    const bootstrap = z.object({
      bootstrapUrl: z.url(),
      expiresAt: z.string(),
      versionId: z.string(),
    }).parse(await bootstrapResponse.json());
    expect(bootstrap.versionId).toBe(first.body.version.id);
    const exchange = await fetchVersion(server, bootstrap.bootstrapUrl);
    expect(exchange.status).toBe(200);
    expect(await exchange.clone().text()).toContain('content="0;url=/"');
    const cookie = exchange.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const earlier = await fetchVersion(
      server,
      first.body.links.version,
      "GET",
      {Cookie: cookie ?? ""},
    );
    expect(await earlier.text()).toContain("Version one");

    const repeatedMetadata = artifactVersionSchema.parse(
      await (await authenticatedFetch(
        server,
        installation,
        `/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}`,
      )).json(),
    );
    expect(repeatedMetadata).toEqual(firstMetadata);
  });

  test("ART-005-B ART-005-F: restore and visibility changes are atomic, attributed, and fail closed", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Restore target</title>",
      idempotencyKey: "management-restore-first",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Current before restore</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "management-restore-second",
    });
    const foreign = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "foreign",
      idempotencyKey: "management-restore-foreign",
    });

    const crossVersion = await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}/versions/${foreign.body.version.id}`,
    );
    expect(crossVersion.status).toBe(404);
    const rejectedRestore = await mutateArtifact(
      server,
      installation,
      first.body,
      "restore",
      "management-invalid-restore",
      {
        expectedCurrentVersionId: second.body.version.id,
        versionId: foreign.body.version.id,
      },
    );
    expect(rejectedRestore.status).toBe(404);

    const restoredResponse = await mutateArtifact(
      server,
      installation,
      first.body,
      "restore",
      "management-valid-restore",
      {
        expectedCurrentVersionId: second.body.version.id,
        versionId: first.body.version.id,
      },
    );
    expect(restoredResponse.status).toBe(200);
    const restored = mutationSchema.parse(await restoredResponse.json());
    expect(restored).toMatchObject({
      artifact: {currentVersionId: first.body.version.id},
      replayed: false,
      version: {id: first.body.version.id, number: 1},
    });
    const restoredReplay = mutationSchema.parse(await (await mutateArtifact(
      server,
      installation,
      first.body,
      "restore",
      "management-valid-restore",
      {
        expectedCurrentVersionId: second.body.version.id,
        versionId: first.body.version.id,
      },
    )).json());
    expect(restoredReplay.replayed).toBe(true);

    const conflictingReplay = await mutateArtifact(
      server,
      installation,
      first.body,
      "restore",
      "management-valid-restore",
      {
        expectedCurrentVersionId: first.body.version.id,
        versionId: second.body.version.id,
      },
    );
    expect(conflictingReplay.status).toBe(409);
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      error: {code: "IDEMPOTENCY_CONFLICT"},
    });

    const history = versionListSchema.parse(await (await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}/versions`,
    )).json());
    expect(history.versions).toHaveLength(2);
    expect(history.versions.map(({version}) => version.id)).toEqual([
      second.body.version.id,
      first.body.version.id,
    ]);

    const stable = await fetch(first.body.links.artifact, {redirect: "manual"});
    expect(stable.headers.get("location")).toBe(first.body.links.version);
    const newerPublicAttempt = await fetchVersion(server, second.body.links.version);
    expect(newerPublicAttempt.status).toBe(401);

    const privateResponse = await mutateArtifact(
      server,
      installation,
      first.body,
      "access",
      "management-private-access",
      {
        accessSetting: "account_required",
        expectedCurrentVersionId: first.body.version.id,
      },
    );
    expect(privateResponse.status).toBe(200);
    const privateBody = mutationSchema.extend({warning: z.string()}).parse(
      await privateResponse.json(),
    );
    expect(privateBody.artifact.accessSetting).toBe("account_required");
    expect(privateBody.warning).toContain("cannot be recalled");
    const noFreshPublicResponse = await fetchVersion(
      server,
      first.body.links.version,
    );
    expect(noFreshPublicResponse.status).toBe(401);

    const staleAccess = await mutateArtifact(
      server,
      installation,
      first.body,
      "access",
      "management-stale-access",
      {
        accessSetting: "public_link",
        expectedCurrentVersionId: second.body.version.id,
      },
    );
    expect(staleAccess.status).toBe(409);

    await server.stop();
    server = await startTestServer(installation);
    const afterRestart = artifactDetailsSchema.parse(await (await authenticatedFetch(
      server,
      installation,
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).json());
    expect(afterRestart.artifact).toMatchObject({
      accessSetting: "account_required",
      currentVersionId: first.body.version.id,
    });
    const privateReplay = mutationSchema.extend({warning: z.string()}).parse(
      await (await mutateArtifact(
        server,
        installation,
        first.body,
        "access",
        "management-private-access",
        {
          accessSetting: "account_required",
          expectedCurrentVersionId: first.body.version.id,
        },
      )).json(),
    );
    expect(privateReplay.replayed).toBe(true);

    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {readOnly: true},
    );
    try {
      const actions = z.array(z.object({
        action: z.string(),
        authorizedByPrincipalId: z.string().nullable(),
        principalId: z.string(),
      })).parse(database.prepare(
        `SELECT
          action,
          principal_id AS principalId,
          authorized_by_principal_id AS authorizedByPrincipalId
         FROM actions
         WHERE artifact_id = ?
         ORDER BY created_at, rowid`,
      ).all(first.body.artifact.id));
      expect(actions.map(({action}) => action)).toEqual([
        "publish",
        "publish",
        "restore",
        "change_access",
      ]);
      expect(actions.every(({principalId}) => principalId === "local-api-token"))
        .toBe(true);
      expect(actions.every(({authorizedByPrincipalId}) =>
        authorizedByPrincipalId === null)).toBe(true);
    } finally {
      database.close();
    }
  });
});

function authenticatedFetch(
  server: RunningTestServer,
  installation: TestInstallation,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${installation.apiToken}`);
  return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
}

function mutateArtifact(
  server: RunningTestServer,
  installation: TestInstallation,
  published: PublishResponse,
  operation: "access" | "restore",
  idempotencyKey: string,
  body:
    | {
      readonly expectedCurrentVersionId: string;
      readonly versionId: string;
    }
    | {
      readonly accessSetting: "account_required" | "public_link";
      readonly expectedCurrentVersionId: string;
    },
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/${operation}`,
    {
      body: JSON.stringify(body),
      headers: apiHeaders(installation, idempotencyKey),
      method: operation === "access" ? "PATCH" : "POST",
    },
  );
}
