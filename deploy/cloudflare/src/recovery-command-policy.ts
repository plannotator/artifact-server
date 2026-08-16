import * as Schema from "effect/Schema";

const AccountId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const DatabaseId = Schema.String.check(Schema.isPattern(
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u,
));
const ResourceName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
);
const InstallationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
const DatabaseTarget = Schema.Struct({
  bucketName: ResourceName,
  databaseId: DatabaseId,
  databaseName: ResourceName,
});

export const RecoveryConfigurationSchema = Schema.Struct({
  cloudflareAccountId: AccountId,
  installationId: InstallationId,
  qualification: Schema.Boolean,
  recoveryWorkerName: ResourceName,
  restore: Schema.Struct({
    ...DatabaseTarget.fields,
    workerName: ResourceName,
  }),
  schemaVersion: Schema.Literal(1),
  source: Schema.Struct({
    ...DatabaseTarget.fields,
    writerWorkerName: ResourceName,
  }),
});

export type RecoveryConfiguration = typeof RecoveryConfigurationSchema.Type;

export interface RecoveryConfirmations {
  readonly accountId: string;
  readonly cleanupInstallationId?: string;
  readonly restoreBucketName: string;
  readonly restoreDatabaseName: string;
  readonly sourceBucketName: string;
  readonly sourceDatabaseName: string;
  readonly sourceWriterWorkerName: string;
}

export const decodeRecoveryConfiguration = Schema.decodeUnknownSync(
  Schema.fromJsonString(RecoveryConfigurationSchema),
  {onExcessProperty: "error"},
);

export function normalizeRecoveryCommandArguments(
  arguments_: readonly string[],
): readonly string[] {
  return arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
}

export function validateRecoveryPolicy(
  configuration: RecoveryConfiguration,
  confirmations: RecoveryConfirmations,
  cleanupQualificationResources: boolean,
): readonly string[] {
  const failures: string[] = [];
  if (confirmations.accountId !== configuration.cloudflareAccountId) {
    failures.push("--confirm-account must exactly match cloudflareAccountId");
  }
  if (
    confirmations.sourceDatabaseName !== configuration.source.databaseName
  ) {
    failures.push("--confirm-source-database must exactly match its target");
  }
  if (confirmations.sourceBucketName !== configuration.source.bucketName) {
    failures.push("--confirm-source-bucket must exactly match its target");
  }
  if (
    confirmations.restoreDatabaseName !== configuration.restore.databaseName
  ) {
    failures.push("--confirm-restore-database must exactly match its target");
  }
  if (confirmations.restoreBucketName !== configuration.restore.bucketName) {
    failures.push("--confirm-restore-bucket must exactly match its target");
  }
  if (
    confirmations.sourceWriterWorkerName !==
      configuration.source.writerWorkerName
  ) {
    failures.push(
      "--confirm-source-writes-quiesced must exactly name the offline writer",
    );
  }
  if (
    configuration.source.databaseId === configuration.restore.databaseId ||
    configuration.source.databaseName === configuration.restore.databaseName
  ) {
    failures.push("source and restore D1 targets must differ");
  }
  if (configuration.source.bucketName === configuration.restore.bucketName) {
    failures.push("source and restore R2 targets must differ");
  }
  const workerNames = [
    configuration.recoveryWorkerName,
    configuration.restore.workerName,
    configuration.source.writerWorkerName,
  ];
  if (new Set(workerNames).size !== workerNames.length) {
    failures.push("source, recovery, and restored Worker names must differ");
  }
  if (cleanupQualificationResources) {
    if (!configuration.qualification) {
      failures.push("cleanup requires qualification: true");
    }
    if (
      confirmations.cleanupInstallationId !== configuration.installationId
    ) {
      failures.push(
        "--confirm-qualification-cleanup must exactly match installationId",
      );
    }
    const qualificationNames = [
      configuration.installationId,
      configuration.recoveryWorkerName,
      configuration.restore.bucketName,
      configuration.restore.databaseName,
      configuration.restore.workerName,
      configuration.source.bucketName,
      configuration.source.databaseName,
      configuration.source.writerWorkerName,
    ];
    if (
      qualificationNames.some((name) =>
        !name.startsWith("artifact-server-qual-")
      )
    ) {
      failures.push(
        "qualification cleanup is limited to artifact-server-qual-* names",
      );
    }
  }
  return failures;
}

export function validateEmptyRestoreTargets(
  applicationTableCount: number,
  objectCount: number,
): readonly string[] {
  const failures: string[] = [];
  if (applicationTableCount !== 0) {
    failures.push("restore D1 target must have zero application tables");
  }
  if (objectCount !== 0) {
    failures.push("restore R2 target must have zero objects");
  }
  return failures;
}
