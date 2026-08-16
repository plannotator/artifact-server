import {mkdtemp, rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {ContentAccessService} from "../../src/application/content-access.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
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
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("content access lifecycle", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-content-access-"));
    clock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      bootstrapAdministratorEmail: "admin@example.test",
      clock,
      externalApiBearerVerifier: null,
      externalMcpBearerVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: "test-installation",
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
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
          projectId: null,
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
          projectId: null,
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
          fallback: "none",
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
          projectId: null,
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
          fallback: "none",
          path: "",
          sessionToken: Redacted.make("tampered-content-session-token"),
        })
      ));
    const authorized = await runtime.runPromise(
      ContentAccessService.use((contentAccess) =>
        contentAccess.authorizeVersionContent({
          contentToken: issued.contentToken,
          fallback: "none",
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
  const bytes = new TextEncoder().encode("<!doctype html><title>Private</title>");
  const upload = await runtime.runPromise(
    StagedUploadService.use((stagedUploads) => stagedUploads.createUpload({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
      principal: testPrincipal,
      projectId: null,
    })),
  );
  const file = upload.files[0];
  if (file === undefined) throw new Error("The content fixture upload has no file.");
  await runtime.runPromise(
    StagedUploadService.use((stagedUploads) => stagedUploads.uploadFile({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      principal: testPrincipal,
      projectId: null,
      storageToken: file.storageToken,
      uploadId: upload.id,
    })),
  );
  return runtime.runPromise(
    StagedUploadService.use((stagedUploads) => stagedUploads.commitUpload({
      idempotencyKey: `private-content-${crypto.randomUUID()}`,
      principal: testPrincipal,
      projectId: null,
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Private content lifecycle fixture",
      },
      uploadId: upload.id,
    })),
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
