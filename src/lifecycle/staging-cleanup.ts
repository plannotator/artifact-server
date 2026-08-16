import {Config, ConfigProvider, Effect, Fiber, Schedule, Schema} from "effect";

import type {ApplicationRuntime} from
  "../application/application-runtime.js";
import {
  ExpiredStagingCleanupService,
  type ExpiredStagingCleanupReport,
} from "../application/expired-staging-cleanup.js";

const batchSizeSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({minimum: 1, maximum: 1_000}),
);
const concurrencySchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({minimum: 1, maximum: 32}),
);
const durationSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({minimum: 1_000, maximum: 86_400_000}),
);

/** Deployment policy for bounded expired-staging cleanup. */
export interface StagingCleanupPolicy {
  readonly batchSize: number;
  readonly concurrency: number;
  readonly intervalMilliseconds: number;
  readonly schedule: "background" | "external";
  readonly settleDelayMilliseconds: number;
}

/** Conservative initial cleanup policy shared by every deployment adapter. */
export const defaultStagingCleanupPolicy: StagingCleanupPolicy = {
  batchSize: 100,
  concurrency: 4,
  intervalMilliseconds: 15 * 60 * 1_000,
  schedule: "background",
  settleDelayMilliseconds: 5 * 60 * 1_000,
};

const stagingCleanupConfig = Config.all({
  batchSize: Config.schema(
    batchSizeSchema,
    "ARTIFACT_SERVER_STAGING_CLEANUP_BATCH_SIZE",
  ).pipe(Config.withDefault(defaultStagingCleanupPolicy.batchSize)),
  concurrency: Config.schema(
    concurrencySchema,
    "ARTIFACT_SERVER_STAGING_CLEANUP_CONCURRENCY",
  ).pipe(Config.withDefault(defaultStagingCleanupPolicy.concurrency)),
  intervalMilliseconds: Config.schema(
    durationSchema,
    "ARTIFACT_SERVER_STAGING_CLEANUP_INTERVAL_MS",
  ).pipe(Config.withDefault(defaultStagingCleanupPolicy.intervalMilliseconds)),
  schedule: Config.schema(
    Schema.Literals(["background", "external"]),
    "ARTIFACT_SERVER_STAGING_CLEANUP_SCHEDULE",
  ).pipe(Config.withDefault(defaultStagingCleanupPolicy.schedule)),
  settleDelayMilliseconds: Config.schema(
    durationSchema,
    "ARTIFACT_SERVER_STAGING_CLEANUP_SETTLE_DELAY_MS",
  ).pipe(Config.withDefault(defaultStagingCleanupPolicy.settleDelayMilliseconds)),
});

/** Parse cleanup policy through Effect Config using one explicit environment. */
export function loadStagingCleanupPolicy(
  environment: NodeJS.ProcessEnv,
) {
  return stagingCleanupConfig.parse(
    ConfigProvider.fromEnvRecord(environment),
  );
}

/** Run one bounded cleanup pass through the shared application service. */
export function runStagingCleanupPass(
  runtime: ApplicationRuntime,
  limit: number,
): Promise<ExpiredStagingCleanupReport> {
  return runtime.runPromise(
    ExpiredStagingCleanupService.use((cleanup) => cleanup.runPass({limit})),
  );
}

/** Start the direct-process cleanup loop and return an interruptible close hook. */
export function startStagingCleanupSchedule(
  runtime: ApplicationRuntime,
  policy: StagingCleanupPolicy,
): () => Promise<void> {
  const pass = ExpiredStagingCleanupService.use((cleanup) =>
    cleanup.runPass({limit: policy.batchSize})).pipe(
      Effect.catch((error) =>
        Effect.logError("Expired staging cleanup pass failed.").pipe(
          Effect.annotateLogs({cleanup_failure: error._tag}),
        )),
    );
  const fiber = runtime.runFork(Effect.repeat(
    pass,
    Schedule.spaced(policy.intervalMilliseconds),
  ));
  return () => runtime.runPromise(Fiber.interrupt(fiber));
}
