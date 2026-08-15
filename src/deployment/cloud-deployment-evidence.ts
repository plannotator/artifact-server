import {Effect, Schema, type Redacted} from "effect";

import {
  CloudDeploymentContractError,
  type CloudDeploymentDocument,
  type CloudDeploymentInput,
  CloudDeploymentOutput,
  parseCloudDeploymentOutput,
} from "./cloud-deployment-contract.js";
import {findUnsafeCloudDeploymentValue} from
  "./cloud-deployment-secret-safety.js";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

const nonEmptyString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_000),
);
const instant = Schema.String.check(Schema.makeFilter((value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
    ? undefined
    : "expected an ISO 8601 UTC timestamp"
));
const sha256Digest = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u),
);
const nonEmptyStringRecord = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  nonEmptyString,
).check(Schema.makeFilter((value) =>
  Object.keys(value).length > 0 ? undefined : "expected at least one entry"
));

/** Release checks every cloud provider must prove in its own environment. */
export const cloudDeploymentReleaseCheckIds = [
  "preview-no-writes",
  "clean-apply",
  "repeat-apply",
  "product-behavior",
  "horizontal-replica-concurrency",
  "image-upgrade",
  "schema-compatible-rollback",
  "provider-outage",
  "partial-apply",
  "interrupted-update",
  "state-recovery",
  "coordinated-restore",
  "workload-identity-rotation",
  "secret-rotation",
  "public-ingress",
  "private-ingress",
  "performance-1-user",
  "performance-10-users",
  "performance-25-users",
  "performance-50-users",
  "performance-100-users",
  "safe-destroy-retains-data",
  "permanent-delete-confirmed",
] as const;

const cloudDeploymentReleaseCheckId = Schema.Literals(
  cloudDeploymentReleaseCheckIds,
);

/** Result and durable proof location for one cloud release check. */
export const CloudDeploymentReleaseCheck = Schema.Struct({
  completedAt: instant,
  evidenceLocation: nonEmptyString,
  id: cloudDeploymentReleaseCheckId,
  result: Schema.Literals(["fail", "pass"]),
  startedAt: instant,
});
export interface CloudDeploymentReleaseCheck extends Schema.Schema.Type<
  typeof CloudDeploymentReleaseCheck
> {}

/** Infrastructure tool and provider-package versions used for one deployment. */
export const CloudDeploymentToolEvidence = Schema.Struct({
  name: Schema.Literals(["alchemy", "pulumi"]),
  providerPackages: nonEmptyStringRecord,
  version: nonEmptyString,
});
export interface CloudDeploymentToolEvidence extends Schema.Schema.Type<
  typeof CloudDeploymentToolEvidence
> {}

/**
 * Secret-free, machine-readable evidence emitted by a native cloud package.
 * It records realized resources and durable locations, not provider credentials.
 */
export const CloudDeploymentEvidence = Schema.Struct({
  artifactServerVersion: nonEmptyString,
  checks: Schema.Array(CloudDeploymentReleaseCheck).check(
    Schema.makeFilter((checks) =>
      new Set(checks.map((check) => check.id)).size === checks.length
        ? undefined
        : "release check identifiers must be unique"
    ),
  ),
  configurationFingerprint: sha256Digest,
  environment: Schema.Literals(["development", "staging", "production"]),
  outputs: CloudDeploymentOutput,
  realizedResourceSizes: nonEmptyStringRecord,
  recordedAt: instant,
  region: nonEmptyString,
  schemaVersion: Schema.Literal(1),
  sourceRevision: nonEmptyString,
  target: Schema.Literals(["aws", "cloudflare", "gcp"]),
  testRevision: nonEmptyString,
  tool: CloudDeploymentToolEvidence,
});
export interface CloudDeploymentEvidence extends Schema.Schema.Type<
  typeof CloudDeploymentEvidence
> {}

/** Options used when checking cloud evidence for accidental secret exposure. */
export interface CloudDeploymentEvidenceValidationOptions {
  readonly knownSecrets?: readonly Redacted.Redacted[];
}

const decodeCloudDeploymentEvidence = Schema.decodeUnknownEffect(
  CloudDeploymentEvidence,
  strictParseOptions,
);

/**
 * Parse one provider evidence file and bind it to the exact requested stack.
 * Partial and failed evidence remains valid diagnostic evidence.
 */
export const parseCloudDeploymentEvidence = Effect.fn("parseCloudDeploymentEvidence")(
  function*(
    input: CloudDeploymentInput,
    evidence: CloudDeploymentDocument,
    options: CloudDeploymentEvidenceValidationOptions = {},
  ): Effect.fn.Return<CloudDeploymentEvidence, CloudDeploymentContractError> {
    const parsed = yield* decodeCloudDeploymentEvidence(evidence).pipe(
      Effect.mapError(() => new CloudDeploymentContractError({
        field: "evidence",
        message: "Cloud deployment evidence does not satisfy the shared contract.",
        reason: "invalid_evidence",
      })),
    );
    yield* validateEvidenceConsistency(input, parsed);
    yield* parseCloudDeploymentOutput(input, parsed.outputs, options);
    yield* validateEvidenceSafety(parsed, options.knownSecrets ?? []);
    return parsed;
  },
);

/**
 * Require a complete passing release record after parsing the evidence file.
 * Provider projects call this only for release qualification, not partial runs.
 */
export const validateCloudDeploymentReleaseEvidence = Effect.fn(
  "validateCloudDeploymentReleaseEvidence",
)(function*(
  input: CloudDeploymentInput,
  evidence: CloudDeploymentDocument,
  options: CloudDeploymentEvidenceValidationOptions = {},
): Effect.fn.Return<CloudDeploymentEvidence, CloudDeploymentContractError> {
  const parsed = yield* parseCloudDeploymentEvidence(input, evidence, options);
  const checks = new Map(parsed.checks.map((check) => [check.id, check.result]));
  const complete = cloudDeploymentReleaseCheckIds.every((id) =>
    checks.get(id) === "pass"
  );
  if (!complete) {
    return yield* new CloudDeploymentContractError({
      field: "checks",
      message: "Cloud release evidence is incomplete or contains a failed check.",
      reason: "invalid_evidence",
    });
  }
  return parsed;
});

function validateEvidenceConsistency(
  input: CloudDeploymentInput,
  evidence: CloudDeploymentEvidence,
): Effect.Effect<void, CloudDeploymentContractError> {
  const expectedTool = input.target === "cloudflare" ? "alchemy" : "pulumi";
  const expected = [
    ["target", evidence.target, input.target],
    ["environment", evidence.environment, input.environment],
    ["region", evidence.region, input.region],
    ["tool.name", evidence.tool.name, expectedTool],
  ] as const;
  const mismatch = expected.find(([, actual, wanted]) => actual !== wanted);
  if (mismatch !== undefined) {
    return Effect.fail(new CloudDeploymentContractError({
      field: mismatch[0],
      message: `${mismatch[0]} does not match the requested deployment.`,
      reason: "invalid_evidence",
    }));
  }
  const invalidTiming = evidence.checks.find((check) =>
    Date.parse(check.completedAt) < Date.parse(check.startedAt) ||
    Date.parse(check.completedAt) > Date.parse(evidence.recordedAt)
  );
  return invalidTiming === undefined
    ? Effect.void
    : Effect.fail(new CloudDeploymentContractError({
      field: `checks.${invalidTiming.id}`,
      message: "Cloud deployment evidence timestamps are inconsistent.",
      reason: "invalid_evidence",
    }));
}

function validateEvidenceSafety(
  evidence: CloudDeploymentEvidence,
  knownSecrets: readonly Redacted.Redacted[],
): Effect.Effect<void, CloudDeploymentContractError> {
  const direct = [
    ["artifactServerVersion", evidence.artifactServerVersion],
    ["configurationFingerprint", evidence.configurationFingerprint],
    ["region", evidence.region],
    ["sourceRevision", evidence.sourceRevision],
    ["testRevision", evidence.testRevision],
    ["tool.version", evidence.tool.version],
  ] as const;
  const unsafeField = findUnsafeCloudDeploymentValue([
    ...direct.map(([field, value]) => ({field, value})),
    ...Object.entries(evidence.tool.providerPackages).map(([key, value]) => ({
      field: `tool.providerPackages.${key}`,
      value,
    })),
    ...Object.keys(evidence.tool.providerPackages).map((key) => ({
      field: "tool.providerPackages key",
      value: key,
    })),
    ...Object.entries(evidence.realizedResourceSizes).map(([key, value]) => ({
      field: `realizedResourceSizes.${key}`,
      value,
    })),
    ...Object.keys(evidence.realizedResourceSizes).map((key) => ({
      field: "realizedResourceSizes key",
      value: key,
    })),
    ...evidence.checks.map((check) => ({
      field: `checks.${check.id}.evidenceLocation`,
      value: check.evidenceLocation,
    })),
  ], knownSecrets);
  return unsafeField === null
    ? Effect.void
    : Effect.fail(new CloudDeploymentContractError({
      field: unsafeField,
      message: "Cloud deployment evidence contains credential material.",
      reason: "secret_output",
    }));
}
