import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, ManagedRuntime } from "effect";
import type { Hono } from "hono";

import type { ApplicationRuntime } from "../application/application-runtime.js";
import { SystemClock, SystemIdGenerator } from "../core/system.js";
import { createHttpApp } from "../http/create-http-app.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";
import { LocalStagingStore } from "../storage/local-staging-store.js";
import { SqliteArtifactRepository } from "../storage/sqlite-artifact-repository.js";
import { createLocalApplicationLayer } from "./create-local-application-layer.js";

export interface LocalRuntimeConfig {
  readonly apiToken: string;
  readonly contentDomain: string;
  readonly dataDirectory: string;
}

export interface LocalRuntime {
  readonly app: Hono;
  close(): Promise<void>;
}

export async function createLocalRuntime(
  config: LocalRuntimeConfig,
): Promise<LocalRuntime> {
  await mkdir(config.dataDirectory, {recursive: true, mode: 0o700});
  const blobs = new LocalBlobStore(path.join(config.dataDirectory, "blobs"));
  const staging = new LocalStagingStore(path.join(config.dataDirectory, "staging"));
  const repository = new SqliteArtifactRepository(
    path.join(config.dataDirectory, "artifact-server.db"),
  );
  const resourceLayer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.succeed(repository),
      (ownedRepository) => Effect.sync(() => ownedRepository.close()),
    ),
  );
  const applicationLayer = createLocalApplicationLayer({
    blobs,
    clock: new SystemClock(),
    ids: new SystemIdGenerator(),
    repository,
    staging,
  });
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, resourceLayer),
  );
  try {
    await applicationRuntime.context();
    const app = createHttpApp({
      apiToken: config.apiToken,
      applicationRuntime,
      blobs,
      contentDomain: config.contentDomain,
      repository,
    });

    return {
      app,
      close: () => applicationRuntime.dispose(),
    };
  } catch (error) {
    await applicationRuntime.dispose();
    throw error;
  }
}
