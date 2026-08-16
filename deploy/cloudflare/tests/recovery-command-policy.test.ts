import {describe, expect, it} from "vitest";

import type {
  RecoveryConfiguration,
  RecoveryConfirmations,
} from "../src/recovery-command-policy.js";
import {
  decodeRecoveryConfiguration,
  normalizeRecoveryCommandArguments,
  validateEmptyRestoreTargets,
  validateRecoveryPolicy,
} from "../src/recovery-command-policy.js";

const configuration: RecoveryConfiguration = {
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  installationId: "artifact-server-qual-recovery-test",
  qualification: true,
  recoveryWorkerName: "artifact-server-qual-recovery-helper",
  restore: {
    bucketName: "artifact-server-qual-recovery-target-objects",
    databaseId: "11111111-1111-4111-8111-111111111111",
    databaseName: "artifact-server-qual-recovery-target-records",
    workerName: "artifact-server-qual-recovery-target-worker",
  },
  schemaVersion: 1,
  source: {
    bucketName: "artifact-server-qual-recovery-source-objects",
    databaseId: "22222222-2222-4222-8222-222222222222",
    databaseName: "artifact-server-qual-recovery-source-records",
    writerWorkerName: "artifact-server-qual-recovery-source-worker",
  },
};

const confirmations: RecoveryConfirmations = {
  accountId: configuration.cloudflareAccountId,
  cleanupInstallationId: configuration.installationId,
  restoreBucketName: configuration.restore.bucketName,
  restoreDatabaseName: configuration.restore.databaseName,
  sourceBucketName: configuration.source.bucketName,
  sourceDatabaseName: configuration.source.databaseName,
  sourceWriterWorkerName: configuration.source.writerWorkerName,
};

describe("Cloudflare coordinated recovery policy", () => {
  it("accepts direct and pnpm-separated command arguments", () => {
    expect(normalizeRecoveryCommandArguments(["--config", "path"])).toEqual([
      "--config",
      "path",
    ]);
    expect(normalizeRecoveryCommandArguments(["--", "--config", "path"]))
      .toEqual(["--config", "path"]);
  });

  it("accepts exact, independently named qualification targets", () => {
    expect(validateRecoveryPolicy(configuration, confirmations, true)).toEqual([]);
    expect(validateEmptyRestoreTargets(0, 0)).toEqual([]);
  });

  it("rejects an unconfirmed or still-misidentified source writer", () => {
    expect(validateRecoveryPolicy(configuration, {
      ...confirmations,
      sourceWriterWorkerName: "artifact-server-qual-wrong-worker",
    }, false)).toContain(
      "--confirm-source-writes-quiesced must exactly name the offline writer",
    );
  });

  it("rejects source and restore target reuse", () => {
    const unsafe: RecoveryConfiguration = {
      ...configuration,
      restore: {
        ...configuration.restore,
        bucketName: configuration.source.bucketName,
        databaseId: configuration.source.databaseId,
      },
    };
    expect(validateRecoveryPolicy(unsafe, confirmations, false)).toEqual(
      expect.arrayContaining([
        "source and restore D1 targets must differ",
        "source and restore R2 targets must differ",
      ]),
    );
  });

  it("rejects nonempty restore targets before export or copy", () => {
    expect(validateEmptyRestoreTargets(1, 2)).toEqual([
      "restore D1 target must have zero application tables",
      "restore R2 target must have zero objects",
    ]);
  });

  it("rejects cleanup outside the qualification namespace", () => {
    const unsafe: RecoveryConfiguration = {
      ...configuration,
      source: {
        ...configuration.source,
        bucketName: "customer-production-objects",
      },
    };
    expect(validateRecoveryPolicy(unsafe, confirmations, true)).toContain(
      "qualification cleanup is limited to artifact-server-qual-* names",
    );
  });

  it("rejects qualification cleanup without the exact installation phrase", () => {
    expect(validateRecoveryPolicy(configuration, {
      ...confirmations,
      cleanupInstallationId: "artifact-server-qual-another-installation",
    }, true)).toContain(
      "--confirm-qualification-cleanup must exactly match installationId",
    );
  });

  it("rejects unknown configuration fields", () => {
    const document = JSON.stringify({...configuration, deleteAll: true});
    expect(() => decodeRecoveryConfiguration(document)).toThrow("deleteAll");
  });
});
