import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import type {Clock} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

describe("staged upload lifecycle", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-upload-lifecycle-"));
    clock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      clock,
      ids: new SystemIdGenerator(),
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

  test("PUB-001-F: another principal or installation cannot use a staged upload", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("isolated upload");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const upload = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principalId: "principal-a",
      })
    );
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The principal fixture has no file slot.");

    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        principalId: "principal-b",
        storageToken: slot.storageToken,
        uploadId: upload.id,
      })
    );
    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.commitUpload({
        idempotencyKey: "other-principal-cannot-commit",
        principalId: "principal-b",
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Must not commit",
        },
        uploadId: upload.id,
      })
    );

    const foreignRepository = new SqliteArtifactRepository(
      path.join(dataDirectory, "foreign-installation.db"),
    );
    try {
      const foreignRuntime: ApplicationRuntime = ManagedRuntime.make(
        createLocalApplicationLayer({
        blobs: new LocalBlobStore(path.join(dataDirectory, "foreign-blobs")),
        clock,
        ids: new SystemIdGenerator(),
        repository: foreignRepository,
        staging: new LocalStagingStore(path.join(dataDirectory, "foreign-staging")),
        }),
      );
      await foreignRuntime.context();
      try {
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.uploadFile({
            body: byteStream(bytes),
            principalId: upload.principalId,
            storageToken: slot.storageToken,
            uploadId: upload.id,
          }),
        );
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.commitUpload({
            idempotencyKey: "foreign-installation-cannot-commit",
            principalId: upload.principalId,
            target: {
              accessSetting: "public_link",
              kind: "new_artifact",
              name: "Must not commit",
            },
            uploadId: upload.id,
          }),
        );
      } finally {
        await foreignRuntime.dispose();
      }
    } finally {
      foreignRepository.close();
    }
  });

  test("foundation: expiry closes only uncommitted staging while committed retries remain stable", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("staged lifecycle proof");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const expired = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principalId: "principal-a",
      })
    );
    const expiredSlot = expired.files[0];
    if (expiredSlot === undefined) throw new Error("The expiry fixture has no file slot.");
    clock.set(new Date(expired.expiresAt));

    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        principalId: expired.principalId,
        storageToken: expiredSlot.storageToken,
        uploadId: expired.id,
      })
    );
    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.commitUpload({
        idempotencyKey: "expired-upload-cannot-commit",
        principalId: expired.principalId,
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Expired upload",
        },
        uploadId: expired.id,
      })
    );

    clock.set(new Date("2026-08-13T02:00:00.000Z"));
    const live = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principalId: "principal-a",
      })
    );
    const liveSlot = live.files[0];
    if (liveSlot === undefined) throw new Error("The commit fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      principalId: live.principalId,
      storageToken: liveSlot.storageToken,
      uploadId: live.id,
    }));
    const target = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Committed upload",
    };
    const committed = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principalId: live.principalId,
      target,
      uploadId: live.id,
    }));

    clock.set(new Date(live.expiresAt));
    await rm(path.join(dataDirectory, "staging", live.id), {
      force: true,
      recursive: true,
    });
    const replay = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principalId: live.principalId,
      target,
      uploadId: live.id,
    }));
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(committed.version.id);

    await expectStagedFailure(runtime, "UploadClosed", (service) =>
      service.commitUpload({
        idempotencyKey: "committed-upload-new-command",
        principalId: live.principalId,
        target,
        uploadId: live.id,
      })
    );
  });
});

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

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function runStaged<A, E>(
  runtime: ApplicationRuntime,
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(StagedUploadService.use(operation));
}

async function expectStagedFailure<A, E extends {_tag: string}>(
  runtime: ApplicationRuntime,
  expectedTag: E["_tag"],
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<void> {
  const result = await runtime.runPromise(
    Effect.result(StagedUploadService.use(operation)),
  );
  const actualTag = Result.match(result, {
    onFailure: (failure) => failure._tag,
    onSuccess: () => "UnexpectedSuccess",
  });
  expect(actualTag).toBe(expectedTag);
}
