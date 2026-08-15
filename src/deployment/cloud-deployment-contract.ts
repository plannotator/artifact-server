import {Effect, Schema, type Redacted} from "effect";
import {getDomain} from "tldts";

import {findUnsafeCloudDeploymentValue} from
  "./cloud-deployment-secret-safety.ts";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

const nonEmptyString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
);
const identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+=,-]{0,499}$/u),
);
const providerResourceIdentifier = Schema.String.check(
  Schema.isPattern(/^[^\s?#]{1,2000}$/u),
);
const hostname = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  ),
);
const email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  Schema.isMaxLength(320),
);
const installationName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u),
);
const installationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
);
const pinnedImageReference = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@sha256:[a-f0-9]{64}$/u),
  Schema.isMaxLength(1_000),
);
const sha256Digest = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u),
);
const httpsUrl = Schema.String.check(
  Schema.isMaxLength(2_000),
  Schema.makeFilter((value) => isCredentialFreeHttpsUrl(value)
    ? undefined
    : "expected an HTTPS URL without credentials"),
);
const stateBackendUrl = Schema.String.check(
  Schema.isPattern(/^(?:https:\/\/api\.pulumi\.com(?:\/[^\s]*)?|(?:s3|gs|azblob):\/\/[^\s]+)$/u),
  Schema.isMaxLength(2_000),
  Schema.makeFilter((value) => findUnsafeCloudDeploymentValue(
    [{field: "stateBackendUrl", value}],
    [],
  ) === null ? undefined : "state backend URL must not contain credentials"),
);
const compatibilityDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter((value) => isCalendarDate(value)
    ? undefined
    : "expected a real calendar date"),
);
const capacity = Schema.Struct({
  cpu: Schema.Finite.check(
    Schema.isBetween({minimum: 0.25, maximum: 64}),
  ),
  maximumInstances: Schema.Int.check(
    Schema.isBetween({minimum: 1, maximum: 10_000}),
  ),
  memoryMiB: Schema.Int.check(
    Schema.isBetween({minimum: 128, maximum: 1_048_576}),
  ),
  minimumInstances: Schema.Int.check(
    Schema.isBetween({minimum: 0, maximum: 10_000}),
  ),
});
const resourceTags = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(256)),
);
const resourceIdentifiers = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  providerResourceIdentifier,
);
const distinctSubnetIds = Schema.Array(providerResourceIdentifier).check(
  Schema.isMinLength(2),
  Schema.isUnique(),
);

const sharedInputFields = {
  applicationDomain: hostname,
  backupRetentionDays: Schema.Int.check(
    Schema.isBetween({minimum: 7, maximum: 35}),
  ),
  bootstrapAdministratorEmail: email,
  capacity,
  contentDomain: hostname,
  databasePlan: Schema.Literals(["small", "standard", "high-availability"]),
  deletionProtection: Schema.Boolean,
  dnsZoneId: Schema.optionalKey(providerResourceIdentifier),
  environment: Schema.Literals(["development", "staging", "production"]),
  ingress: Schema.Literals(["private", "public"]),
  installationName,
  otlpEndpoint: Schema.optionalKey(httpsUrl),
  region: identifier,
  requestLogSampleRate: Schema.Finite.check(
    Schema.isBetween({minimum: 0, maximum: 1}),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.01))),
  resourceTags: resourceTags.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  workosApiKeySecretRef: Schema.optionalKey(providerResourceIdentifier),
  workosClientId: Schema.optionalKey(identifier),
} as const;

/** AWS network identifiers accepted instead of creating a new VPC. */
export const AwsExistingNetwork = Schema.Struct({
  applicationSubnetIds: distinctSubnetIds,
  databaseSubnetIds: distinctSubnetIds,
  vpcId: providerResourceIdentifier,
});
export interface AwsExistingNetwork extends Schema.Schema.Type<
  typeof AwsExistingNetwork
> {}

/** GCP network identifiers accepted instead of creating a new VPC. */
export const GcpExistingNetwork = Schema.Struct({
  privateServiceConnection: providerResourceIdentifier,
  vpcEgressConfiguration: providerResourceIdentifier,
  vpcName: providerResourceIdentifier,
});
export interface GcpExistingNetwork extends Schema.Schema.Type<
  typeof GcpExistingNetwork
> {}

/** Azure network identifiers accepted instead of creating a new network. */
export const AzureExistingNetwork = Schema.Struct({
  containerAppsSubnetId: providerResourceIdentifier,
  postgresSubnetId: providerResourceIdentifier,
  privateDnsZoneId: providerResourceIdentifier,
  virtualNetworkId: providerResourceIdentifier,
});
export interface AzureExistingNetwork extends Schema.Schema.Type<
  typeof AzureExistingNetwork
> {}

const pulumiInputFields = {
  imageReference: pinnedImageReference,
  secretsProvider: nonEmptyString,
  stackName: identifier,
  stateBackendUrl,
} as const;

/** Shared AWS deployment input consumed by the native Pulumi stack. */
export const AwsCloudDeploymentInput = Schema.Struct({
  ...sharedInputFields,
  ...pulumiInputFields,
  existingNetwork: Schema.optionalKey(AwsExistingNetwork),
  target: Schema.Literal("aws"),
});
export interface AwsCloudDeploymentInput extends Schema.Schema.Type<
  typeof AwsCloudDeploymentInput
> {}

/** Shared GCP deployment input consumed by the native Pulumi stack. */
export const GcpCloudDeploymentInput = Schema.Struct({
  ...sharedInputFields,
  ...pulumiInputFields,
  existingNetwork: Schema.optionalKey(GcpExistingNetwork),
  target: Schema.Literal("gcp"),
});
export interface GcpCloudDeploymentInput extends Schema.Schema.Type<
  typeof GcpCloudDeploymentInput
> {}

/** Shared Azure deployment input consumed by the native Pulumi stack. */
export const AzureCloudDeploymentInput = Schema.Struct({
  ...sharedInputFields,
  ...pulumiInputFields,
  existingNetwork: Schema.optionalKey(AzureExistingNetwork),
  target: Schema.Literal("azure"),
});
export interface AzureCloudDeploymentInput extends Schema.Schema.Type<
  typeof AzureCloudDeploymentInput
> {}

/** Shared Cloudflare deployment input consumed by the native Alchemy project. */
export const CloudflareCloudDeploymentInput = Schema.Struct({
  ...sharedInputFields,
  cloudflareAccountId: identifier,
  compatibilityDate,
  stage: identifier,
  stateStore: Schema.Literals(["cloudflare", "local"]),
  target: Schema.Literal("cloudflare"),
});
export interface CloudflareCloudDeploymentInput extends Schema.Schema.Type<
  typeof CloudflareCloudDeploymentInput
> {}

const uncheckedCloudDeploymentInput = Schema.Union([
  AwsCloudDeploymentInput,
  GcpCloudDeploymentInput,
  AzureCloudDeploymentInput,
  CloudflareCloudDeploymentInput,
]);

/** Strict input contract shared by all first-party cloud deployment projects. */
export const CloudDeploymentInput = uncheckedCloudDeploymentInput.check(
  Schema.makeFilter((input) => {
    const issues: Array<Schema.FilterIssue> = [];
    const applicationDomain = registrableDeploymentDomain(
      input.applicationDomain,
    );
    const contentDomain = registrableDeploymentDomain(input.contentDomain);
    if (applicationDomain === contentDomain) {
      issues.push({
        issue: "applicationDomain and contentDomain must use separate registrable domains",
        path: ["contentDomain"],
      });
    }
    if (input.capacity.minimumInstances > input.capacity.maximumInstances) {
      issues.push({
        issue: "minimumInstances cannot exceed maximumInstances",
        path: ["capacity", "minimumInstances"],
      });
    }
    if (input.environment === "production") {
      if (input.capacity.minimumInstances < 1) {
        issues.push({
          issue: "production requires at least one running instance",
          path: ["capacity", "minimumInstances"],
        });
      }
      if (input.backupRetentionDays < 14) {
        issues.push({
          issue: "production requires at least 14 backup-retention days",
          path: ["backupRetentionDays"],
        });
      }
      if (!input.deletionProtection) {
        issues.push({
          issue: "production requires deletion protection",
          path: ["deletionProtection"],
        });
      }
    }
    if (input.ingress === "public" && input.dnsZoneId === undefined) {
      issues.push({
        issue: "public ingress requires an existing DNS zone",
        path: ["dnsZoneId"],
      });
    }
    if (
      (input.workosClientId === undefined) !==
      (input.workosApiKeySecretRef === undefined)
    ) {
      issues.push({
        issue: "WorkOS client and secret reference must be configured together",
        path: ["workosClientId"],
      });
    }
    if (
      input.target === "cloudflare" &&
      input.environment !== "development" &&
      input.stateStore === "local"
    ) {
      issues.push({
        issue: "staging and production require Cloudflare-managed Alchemy state",
        path: ["stateStore"],
      });
    }
    if (input.target === "cloudflare" && input.region !== "global") {
      issues.push({
        issue: "Cloudflare uses the global region",
        path: ["region"],
      });
    }
    if (
      input.target === "cloudflare" &&
      input.environment === "production" &&
      input.stage !== "production"
    ) {
      issues.push({
        issue: "the production environment must use the production Alchemy stage",
        path: ["stage"],
      });
    }
    return issues;
  }),
);
export type CloudDeploymentInput = typeof CloudDeploymentInput.Type;

/** Secret-free output contract returned by every cloud deployment project. */
export const CloudDeploymentOutput = Schema.Struct({
  applicationUrl: httpsUrl,
  contentDomain: hostname,
  databaseResourceId: providerResourceIdentifier,
  healthUrl: httpsUrl,
  imageDigest: sha256Digest,
  installationId,
  logDestination: providerResourceIdentifier,
  mcpUrl: httpsUrl,
  networkResourceIds: resourceIdentifiers,
  objectStorageResourceId: providerResourceIdentifier,
  readinessUrl: httpsUrl,
  runtimeResourceId: providerResourceIdentifier,
  secretResourceIds: resourceIdentifiers.check(Schema.makeFilter((value) =>
    Object.keys(value).length > 0
      ? undefined
      : "at least one provider secret resource is required"
  )),
  stateBackend: nonEmptyString,
  supportManifestLocation: nonEmptyString,
  workloadIdentityResourceId: providerResourceIdentifier,
});
export interface CloudDeploymentOutput extends Schema.Schema.Type<
  typeof CloudDeploymentOutput
> {}

/** Optional secret values used only to prove that outputs did not reveal them. */
export interface CloudDeploymentOutputValidationOptions {
  readonly knownSecrets?: readonly Redacted.Redacted[];
}

/** JSON-compatible value accepted at a cloud deployment file boundary. */
export type CloudDeploymentDocumentValue =
  | boolean
  | null
  | number
  | string
  | CloudDeploymentDocument
  | readonly CloudDeploymentDocumentValue[];

/** Untrusted JSON-compatible object loaded from configuration or tool output. */
export interface CloudDeploymentDocument {
  readonly [key: string]: CloudDeploymentDocumentValue;
}

/** Expected failure while validating a shared cloud deployment contract. */
export class CloudDeploymentContractError extends Schema.TaggedError<
  CloudDeploymentContractError
>()(
  "CloudDeploymentContractError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "inconsistent_output",
      "invalid_evidence",
      "invalid_input",
      "invalid_output",
      "secret_output",
    ]),
  },
) {}

const decodeCloudDeploymentInput = Schema.decodeUnknownEffect(
  CloudDeploymentInput,
  strictParseOptions,
);
const decodeCloudDeploymentOutput = Schema.decodeUnknownEffect(
  CloudDeploymentOutput,
  strictParseOptions,
);

/** Decode unknown provider configuration before any infrastructure write. */
export const parseCloudDeploymentInput = Effect.fn("parseCloudDeploymentInput")(
  function*(input: CloudDeploymentDocument): Effect.fn.Return<
    CloudDeploymentInput,
    CloudDeploymentContractError
  > {
    return yield* decodeCloudDeploymentInput(input).pipe(
      Effect.mapError(() => new CloudDeploymentContractError({
        field: "input",
        message: "Cloud deployment input does not satisfy the shared contract.",
        reason: "invalid_input",
      })),
    );
  },
);

/**
 * Decode provider outputs, compare them with the requested deployment, and
 * reject credentials before outputs can be persisted or printed.
 */
export const parseCloudDeploymentOutput = Effect.fn("parseCloudDeploymentOutput")(
  function*(
    input: CloudDeploymentInput,
    output: CloudDeploymentDocument | CloudDeploymentOutput,
    options: CloudDeploymentOutputValidationOptions = {},
  ): Effect.fn.Return<CloudDeploymentOutput, CloudDeploymentContractError> {
    const parsed = yield* decodeCloudDeploymentOutput(output).pipe(
      Effect.mapError(() => new CloudDeploymentContractError({
        field: "output",
        message: "Cloud deployment output does not satisfy the shared contract.",
        reason: "invalid_output",
      })),
    );
    yield* validateOutputConsistency(input, parsed);
    yield* validateOutputSafety(parsed, options.knownSecrets ?? []);
    return parsed;
  },
);

function validateOutputConsistency(
  input: CloudDeploymentInput,
  output: CloudDeploymentOutput,
): Effect.Effect<void, CloudDeploymentContractError> {
  const applicationUrl = `https://${input.applicationDomain}`;
  const expected = [
    ["applicationUrl", output.applicationUrl, applicationUrl],
    ["contentDomain", output.contentDomain, input.contentDomain],
    ["mcpUrl", output.mcpUrl, `${applicationUrl}/mcp`],
    ["healthUrl", output.healthUrl, `${applicationUrl}/health`],
    ["readinessUrl", output.readinessUrl, `${applicationUrl}/ready`],
  ] as const;
  const mismatch = expected.find(([, actual, wanted]) => actual !== wanted);
  return mismatch === undefined
    ? Effect.void
    : Effect.fail(new CloudDeploymentContractError({
      field: mismatch[0],
      message: `${mismatch[0]} does not match the requested deployment.`,
      reason: "inconsistent_output",
    }));
}

function validateOutputSafety(
  output: CloudDeploymentOutput,
  knownSecrets: readonly Redacted.Redacted[],
): Effect.Effect<void, CloudDeploymentContractError> {
  const unsafeField = findUnsafeCloudDeploymentValue(
    outputStringFields(output),
    knownSecrets,
  );
  return unsafeField === null
    ? Effect.void
    : Effect.fail(new CloudDeploymentContractError({
      field: unsafeField,
      message: "Cloud deployment output contains credential material.",
      reason: "secret_output",
    }));
}

function outputStringFields(
  output: CloudDeploymentOutput,
): ReadonlyArray<{readonly field: string; readonly value: string}> {
  const direct = [
    ["applicationUrl", output.applicationUrl],
    ["contentDomain", output.contentDomain],
    ["databaseResourceId", output.databaseResourceId],
    ["healthUrl", output.healthUrl],
    ["imageDigest", output.imageDigest],
    ["installationId", output.installationId],
    ["logDestination", output.logDestination],
    ["mcpUrl", output.mcpUrl],
    ["objectStorageResourceId", output.objectStorageResourceId],
    ["readinessUrl", output.readinessUrl],
    ["runtimeResourceId", output.runtimeResourceId],
    ["stateBackend", output.stateBackend],
    ["supportManifestLocation", output.supportManifestLocation],
    ["workloadIdentityResourceId", output.workloadIdentityResourceId],
  ] as const;
  const records = [
    ["networkResourceIds", output.networkResourceIds],
    ["secretResourceIds", output.secretResourceIds],
  ] as const;
  return [
    ...direct.map(([field, value]) => ({field, value})),
    ...records.flatMap(([field, record]) => Object.entries(record).flatMap(
      ([key, value]) => [
        {field: `${field} key`, value: key},
        {field: `${field}.${key}`, value},
      ],
    )),
  ];
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0;
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function registrableDeploymentDomain(host: string): string {
  const knownDomain = getDomain(host, {allowPrivateDomains: true});
  if (knownDomain !== null) {
    return knownDomain;
  }
  return host.split(".").slice(-2).join(".");
}
