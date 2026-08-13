import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {ContentAccessService} from "../../src/application/content-access.js";
import {PublishArtifactService} from "../../src/application/publish-artifact.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {Clock} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

describe("content access lifecycle", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-content-access-"));
    clock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      clock,
      ids: new SystemIdGenerator(),
      installationId: "test-installation",
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("foundation: bootstrap and content-session expiration fail closed", async () => {
    expect.hasAssertions();
    const published = await publishPrivateArtifact(runtime);
    const issued = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.issueContentBootstrap({
          artifactId: published.artifact.id,
          principal: testPrincipal,
          target: {kind: "current"},
        })
      ),
    );
    clock.set(new Date(issued.expiresAt));
    await expectFailure("ContentBootstrapRejected",
      ContentAccessService.use((contentAccess) =>
        contentAccess.exchangeContentBootstrap({
          contentToken: issued.contentToken,
          token: issued.token,
        })
      ));

    clock.set(new Date("2026-08-13T01:00:00.000Z"));
    const liveBootstrap = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.issueContentBootstrap({
          artifactId: published.artifact.id,
          principal: testPrincipal,
          target: {kind: "current"},
        })
      ),
    );
    const session = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.exchangeContentBootstrap({
          contentToken: liveBootstrap.contentToken,
          token: liveBootstrap.token,
        })
      ),
    );
    clock.set(new Date(session.expiresAt));
    await expectFailure("ContentSessionRequired",
      ContentAccessService.use((contentAccess) =>
        contentAccess.authorizeVersionContent({
          contentToken: liveBootstrap.contentToken,
          path: "",
          sessionToken: session.token,
        })
      ));
  });

  test("AUTH-014-F: bootstrap replay, tampering, and host substitution do not grant a session", async () => {
    expect.hasAssertions();
    const published = await publishPrivateArtifact(runtime);
    const issued = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.issueContentBootstrap({
          artifactId: published.artifact.id,
          principal: testPrincipal,
          target: {kind: "current"},
        })
      ),
    );

    await expectFailure("ContentBootstrapRejected",
      ContentAccessService.use((contentAccess) =>
        contentAccess.exchangeContentBootstrap({
          contentToken: "another-version-host",
          token: issued.token,
        })
      ));
    const session = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.exchangeContentBootstrap({
          contentToken: issued.contentToken,
          token: issued.token,
        })
      ),
    );
    await expectFailure("ContentBootstrapRejected",
      ContentAccessService.use((contentAccess) =>
        contentAccess.exchangeContentBootstrap({
          contentToken: issued.contentToken,
          token: issued.token,
        })
      ));
    await expectFailure("ContentSessionRequired",
      ContentAccessService.use((contentAccess) =>
        contentAccess.authorizeVersionContent({
          contentToken: issued.contentToken,
          path: "",
          sessionToken: Redacted.make("tampered-content-session-token"),
        })
      ));
    const authorized = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.authorizeVersionContent({
          contentToken: issued.contentToken,
          path: "",
          sessionToken: session.token,
        })
      ),
    );
    expect(authorized?.versionId).toBe(published.version.id);
  });

  async function expectFailure<A, E extends {_tag: string}>(
    expectedTag: E["_tag"],
    effect: Effect.Effect<A, E, ContentAccessService>,
  ): Promise<void> {
    const result = await runtime.runPromise(Effect.result(effect));
    expect(Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe(expectedTag);
  }
});

const testPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [
    principalCapabilities.createArtifact,
    principalCapabilities.issueContentSession,
    principalCapabilities.publishAnyArtifact,
  ],
  id: "test-service-principal",
  installationId: "test-installation",
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};

async function publishPrivateArtifact(runtime: ApplicationRuntime) {
  return runtime.runPromise(
    PublishArtifactService.use((publish) =>
      publish.publishNew({
        accessSetting: "account_required",
        bytes: new TextEncoder().encode("<!doctype html><title>Private</title>"),
        idempotencyKey: `private-content-${crypto.randomUUID()}`,
        mediaType: "text/html; charset=utf-8",
        name: "Private content lifecycle fixture",
        path: "index.html",
        principal: testPrincipal,
      })
    ),
  );
}

class ControlledClock implements Clock {
  #current: Date;

  constructor(initial: Date) {
    this.#current = initial;
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(current: Date): void {
    this.#current = current;
  }
}
