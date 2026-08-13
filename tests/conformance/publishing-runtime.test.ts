import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {access, readdir} from "node:fs/promises";
import path from "node:path";

import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  parsePublishResponse,
  publishNew,
  publishVersion,
} from "../support/publishing.js";

describe("local publishing runtime", () => {
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

  test("ART-001-B AUTH-004-F: versions keep identity while public access follows only the current version", async () => {
    const firstHtml = "<!doctype html><title>Version one</title><h1>One</h1>";
    const secondHtml = "<!doctype html><title>Version two</title><h1>Two</h1>";
    const first = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: firstHtml,
      idempotencyKey: "publish-runtime-version-one",
    });
    expect(first.response.status).toBe(201);
    expect(first.body.version.number).toBe(1);
    expect(first.body.artifact.currentVersionId).toBe(first.body.version.id);
    const firstWhileCurrent = await fetchVersion(server, first.body.links.version);
    expect(await firstWhileCurrent.text()).toBe(firstHtml);

    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: secondHtml,
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "publish-runtime-version-two",
    });
    expect(second.response.status).toBe(201);
    expect(second.body.artifact.id).toBe(first.body.artifact.id);
    expect(second.body.version.id).not.toBe(first.body.version.id);
    expect(second.body.version.number).toBe(2);
    expect(new URL(second.body.links.version).origin).not.toBe(
      new URL(first.body.links.version).origin,
    );

    const oldVersion = await fetchVersion(server, first.body.links.version);
    const newVersion = await fetchVersion(server, second.body.links.version);
    expect(oldVersion.status).toBe(401);
    expect(oldVersion.headers.get("cache-control")).toBe("private, no-store");
    await oldVersion.arrayBuffer();
    expect(await newVersion.text()).toBe(secondHtml);

    const publicOnlyResponses = await Promise.all([
      fetch(
        `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/comparisons?${new URLSearchParams({
          fromVersionId: first.body.version.id,
          toVersionId: second.body.version.id,
        })}`,
      ),
      fetch(
        `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions`,
      ),
      fetch(`${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/restore`, {
        body: JSON.stringify({
          expectedCurrentVersionId: second.body.version.id,
          versionId: first.body.version.id,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "unauthenticated-restore-probe",
        },
        method: "POST",
      }),
      fetch(`${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/access`, {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: second.body.version.id,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "unauthenticated-access-probe",
        },
        method: "PATCH",
      }),
    ]);
    expect(publicOnlyResponses.map(({status}) => status)).toEqual([
      401,
      401,
      401,
      401,
    ]);
    await expect(access(path.join(installation.dataDirectory, ".git")))
      .rejects.toMatchObject({code: "ENOENT"});

    await server.stop();
    server = await startTestServer(installation);

    const stable = await fetch(
      `${server.baseUrl}/artifacts/${first.body.artifact.id}`,
      {redirect: "manual"},
    );
    expect(stable.status).toBe(302);
    const currentLocation = stable.headers.get("location");
    expect(currentLocation).not.toBeNull();
    const current = await fetchVersion(server, String(currentLocation));
    const oldAfterRestart = await fetchVersion(server, first.body.links.version);
    expect(await current.text()).toBe(secondHtml);
    expect(oldAfterRestart.status).toBe(401);
    await oldAfterRestart.arrayBuffer();
  });

  test("PUB-006-B PUB-006-F: retries return the original result and conflicting reuse fails", async () => {
    const command = {
      accessSetting: "public_link" as const,
      content: "<!doctype html><title>Retry</title>",
      idempotencyKey: "retry-the-same-publish-command",
    };
    const first = await publishNew(server, installation, command);
    const replay = await publishNew(server, installation, command);

    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.artifact.id).toBe(first.body.artifact.id);
    expect(replay.body.version.id).toBe(first.body.version.id);

    const conflict = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      body: JSON.stringify({
        accessSetting: "public_link",
        file: {
          contentBase64: Buffer.from("different bytes").toString("base64"),
          mediaType: "text/plain",
          path: "index.html",
        },
        name: "Test artifact",
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": command.idempotencyKey,
      },
      method: "POST",
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: {code: "IDEMPOTENCY_CONFLICT"},
    });
  });

  test("PUB-008-B PUB-008-F: concurrent stale publishes cannot overwrite the winner", async () => {
    const initial = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Initial</title>",
      idempotencyKey: "publish-race-initial-version",
    });
    const requests = [
      fetch(`${server.baseUrl}/api/v1/artifacts/${initial.body.artifact.id}/versions`, {
        body: JSON.stringify({
          expectedCurrentVersionId: initial.body.version.id,
          file: {
            contentBase64: Buffer.from("<title>Candidate A</title>").toString("base64"),
            mediaType: "text/html",
            path: "index.html",
          },
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "publish-race-candidate-a",
        },
        method: "POST",
      }),
      fetch(`${server.baseUrl}/api/v1/artifacts/${initial.body.artifact.id}/versions`, {
        body: JSON.stringify({
          expectedCurrentVersionId: initial.body.version.id,
          file: {
            contentBase64: Buffer.from("<title>Candidate B</title>").toString("base64"),
            mediaType: "text/html",
            path: "index.html",
          },
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "publish-race-candidate-b",
        },
        method: "POST",
      }),
    ];
    const results = await Promise.all(requests);
    expect(
      results.map((response) => response.status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);
    const successfulResponse = results.find((response) => response.status === 201);
    const conflictResponse = results.find((response) => response.status === 409);
    if (successfulResponse === undefined || conflictResponse === undefined) {
      throw new Error("The publish race did not produce one winner and one conflict.");
    }
    const winner = parsePublishResponse(await successfulResponse.json());
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: {
        code: "PUBLISH_CONFLICT",
        message: expect.stringContaining(winner.version.id),
      },
    });

    const stable = await fetch(
      `${server.baseUrl}/artifacts/${initial.body.artifact.id}`,
      {redirect: "manual"},
    );
    const location = stable.headers.get("location");
    expect(location).not.toBeNull();
    const current = await fetchVersion(server, String(location));
    const winnerBody = await fetchVersion(server, winner.links.version);
    expect(await current.text()).toBe(await winnerBody.text());
  });

  test("PUB-004-B PUB-007-B: an intentional identical publish creates a version but reuses immutable bytes", async () => {
    const html = "<!doctype html><title>Same bytes, new version</title>";
    const first = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: html,
      idempotencyKey: "identical-publish-first-version",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: html,
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "identical-publish-second-version",
    });

    expect(second.response.status).toBe(201);
    expect(second.body.version.id).not.toBe(first.body.version.id);
    expect(second.body.version.number).toBe(2);
    expect(await countBlobFiles(path.join(installation.dataDirectory, "blobs"))).toBe(1);

    const current = await fetchVersion(server, second.body.links.version);
    expect(await current.text()).toBe(html);
    const previous = await fetchVersion(server, first.body.links.version);
    expect(previous.status).toBe(401);
    await previous.arrayBuffer();
  });
});

async function countBlobFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, {withFileTypes: true});
  const counts = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return countBlobFiles(path.join(directory, entry.name));
    }
    return entry.isFile() ? 1 : 0;
  }));
  return counts.reduce((total, count) => total + count, 0);
}
