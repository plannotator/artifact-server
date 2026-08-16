import {Context, DateTime, Effect, Layer, Result} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type ArtifactRepositoryFailure,
  InvalidPagination,
  type StagingStorageFailure,
} from "../core/errors.js";
import type {ExpiredStagedUpload} from "../core/ports.js";

/** Inputs for one bounded expired-staging cleanup pass. */
export interface RunExpiredStagingCleanupCommand {
  readonly limit: number;
}

/** Bounded outcome from one expired-staging cleanup pass. */
export interface ExpiredStagingCleanupReport {
  readonly alreadyAbsent: number;
  readonly deleted: number;
  readonly failed: number;
  readonly remaining: number;
  readonly selected: number;
}

/** Repository operations required to remove expired staging records safely. */
export interface ExpiredStagingCleanupRepository {
  readonly listExpiredStagedUploads: (
    expiredBefore: string,
    limit: number,
  ) => Effect.Effect<readonly ExpiredStagedUpload[], ArtifactRepositoryFailure>;
  readonly removeExpiredStagedUpload: (
    uploadId: string,
    expiredBefore: string,
  ) => Effect.Effect<boolean, ArtifactRepositoryFailure>;
}

/** Staging-object operation required by cleanup. */
export interface ExpiredStagingCleanupStorage {
  readonly remove: (
    uploadId: string,
    storageToken: string,
  ) => Effect.Effect<void, StagingStorageFailure>;
}

/** Dependencies and bounded concurrency policy for expired staging cleanup. */
export interface ExpiredStagingCleanupDependencies {
  readonly clock: ApplicationClock;
  readonly concurrency: number;
  readonly repository: ExpiredStagingCleanupRepository;
  readonly settleDelayMilliseconds: number;
  readonly storage: ExpiredStagingCleanupStorage;
}

interface ExpiredStagingCleanupOperations {
  readonly runPass: (
    command: RunExpiredStagingCleanupCommand,
  ) => Effect.Effect<
    ExpiredStagingCleanupReport,
    ArtifactRepositoryFailure | InvalidPagination
  >;
}

/** Removes only expired, never-committed staging records and their named objects. */
export class ExpiredStagingCleanupService extends Context.Service<
  ExpiredStagingCleanupService,
  ExpiredStagingCleanupOperations
>()("artifact-server/application/ExpiredStagingCleanupService") {
  /** Construct cleanup from deployment-neutral repository and storage ports. */
  static readonly layer = (
    dependencies: ExpiredStagingCleanupDependencies,
  ): Layer.Layer<ExpiredStagingCleanupService> =>
    Layer.succeed(
      ExpiredStagingCleanupService,
      makeExpiredStagingCleanupService(dependencies),
    );
}

function makeExpiredStagingCleanupService(
  dependencies: ExpiredStagingCleanupDependencies,
): ExpiredStagingCleanupOperations {
  const cleanOne = Effect.fn("ExpiredStagingCleanupService.cleanOne")(
    function*(upload: ExpiredStagedUpload, expiredBefore: string) {
      yield* Effect.forEach(
        upload.files,
        (file) => dependencies.storage.remove(upload.id, file.storageToken),
        {concurrency: 1, discard: true},
      );
      return yield* dependencies.repository.removeExpiredStagedUpload(
        upload.id,
        expiredBefore,
      );
    },
  );

  const runPass = Effect.fn("ExpiredStagingCleanupService.runPass")(
    function*(command: RunExpiredStagingCleanupCommand) {
      if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 1_000) {
        return yield* new InvalidPagination({
          message: "The cleanup limit must be an integer from 1 through 1000.",
        });
      }
      const now = yield* dependencies.clock.now;
      const expiredBefore = DateTime.formatIso(DateTime.subtractDuration(
        now,
        dependencies.settleDelayMilliseconds,
      ));
      const uploads = yield* dependencies.repository.listExpiredStagedUploads(
        expiredBefore,
        command.limit,
      );
      const results = yield* Effect.forEach(
        uploads,
        (upload) => cleanOne(upload, expiredBefore).pipe(Effect.result),
        {concurrency: dependencies.concurrency},
      );
      let deleted = 0;
      let failed = 0;
      let alreadyAbsent = 0;
      for (const result of results) {
        if (Result.isFailure(result)) failed += 1;
        else if (result.success) deleted += 1;
        else alreadyAbsent += 1;
      }
      const report: ExpiredStagingCleanupReport = {
        alreadyAbsent,
        deleted,
        failed,
        remaining: failed,
        selected: uploads.length,
      };
      yield* Effect.logInfo("Expired staging cleanup pass completed.").pipe(
        Effect.annotateLogs({
          cleanup_deleted: report.deleted,
          cleanup_failed: report.failed,
          cleanup_already_absent: report.alreadyAbsent,
          cleanup_remaining: report.remaining,
          cleanup_selected: report.selected,
        }),
      );
      return report;
    },
  );

  return ExpiredStagingCleanupService.of({runPass});
}
