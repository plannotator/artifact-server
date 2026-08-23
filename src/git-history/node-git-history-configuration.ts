import {open} from "node:fs/promises";
import path from "node:path";

import {Effect, Redacted, Result, Schema} from "effect";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
  disabledGitHistoryCapability,
  type GitHistoryCapability,
  type GitHistoryLimits,
  maximumGitHistoryVersionCopyBytes,
} from "./git-history-capability.js";
import type {GitHistoryProviderIdentity} from
  "./git-history-provider-identity.js";

const providerField = "ARTIFACT_SERVER_GIT_HISTORY_PROVIDER";
const fileCopyLimitField = "ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES";
const versionCopyLimitField =
  "ARTIFACT_SERVER_GIT_HISTORY_VERSION_COPY_LIMIT_BYTES";
const storageBudgetField =
  "ARTIFACT_SERVER_GIT_HISTORY_STORAGE_BUDGET_BYTES";
const accountIdField =
  "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID";
const namespaceField =
  "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE";
const apiTokenField =
  "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN";
const apiTokenFileField =
  "ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE";
const companionFields = [
  fileCopyLimitField,
  versionCopyLimitField,
  storageBudgetField,
  accountIdField,
  namespaceField,
  apiTokenField,
  apiTokenFileField,
] as const;
const maximumApiTokenBytes = 4_096;

const nonNegativeIntegerFromString = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const boundedVersionBytesFromString = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(maximumGitHistoryVersionCopyBytes),
);
const nonEmptyConfigurationValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
);
const apiTokenSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumApiTokenBytes),
);

/** Stable, secret-safe reason one optional Git configuration is unusable. */
export type GitHistoryConfigurationIssueReason =
  | "direct_secret_forbidden"
  | "ignored_value"
  | "invalid_value"
  | "missing_value"
  | "secret_unreadable"
  | "unsupported_provider";

/** One operator-actionable configuration issue that contains no secret value. */
export interface GitHistoryConfigurationIssue {
  readonly field: string;
  readonly message: string;
  readonly reason: GitHistoryConfigurationIssueReason;
}

/** Off, usable, or safely degraded Node runtime configuration for Git handoff. */
export type NodeGitHistoryConfiguration =
  | {
    readonly _tag: "Off";
    readonly capability: GitHistoryCapability;
    readonly issues: readonly GitHistoryConfigurationIssue[];
  }
  | {
    readonly _tag: "CloudflareArtifactsRest";
    readonly apiToken: Redacted.Redacted;
    readonly capability: GitHistoryCapability;
    readonly identity: GitHistoryProviderIdentity;
    readonly issues: readonly [];
  }
  | {
    readonly _tag: "Misconfigured";
    readonly capability: GitHistoryCapability;
    readonly issues: readonly GitHistoryConfigurationIssue[];
  };

/** Fully parsed Node REST provider configuration eligible for live checks. */
export type ConfiguredNodeGitHistoryConfiguration = Extract<
  NodeGitHistoryConfiguration,
  {readonly _tag: "CloudflareArtifactsRest"}
>;

/** Select the configured REST variant without exposing optional fields. */
export function configuredNodeGitHistory(
  configuration: NodeGitHistoryConfiguration,
): ConfiguredNodeGitHistoryConfiguration | null {
  return configuration._tag === "CloudflareArtifactsRest"
    ? configuration
    : null;
}

interface ParsedLimit {
  readonly issue: GitHistoryConfigurationIssue | null;
  readonly value: number;
}

interface ParsedOptionalLimit {
  readonly issue: GitHistoryConfigurationIssue | null;
  readonly value: number | null;
}

/** Construct the default Node configuration without reading a provider secret. */
export function offNodeGitHistoryConfiguration(
  issues: readonly GitHistoryConfigurationIssue[] = [],
): NodeGitHistoryConfiguration {
  return {
    _tag: "Off",
    capability: disabledGitHistoryCapability(),
    issues,
  };
}

/**
 * Parse the optional Node Git provider family.
 *
 * Malformed values are represented as `misconfigured` discovery state instead
 * of failing the primary runtime. When the provider is absent or `off`, this
 * function returns before reading any provider companion value or secret file.
 */
export const loadNodeGitHistoryConfiguration = Effect.fn(
  "GitHistory.loadNodeConfiguration",
)(function*(
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeGitHistoryConfiguration> {
  const selectedProvider = environment[providerField] ?? "off";
  if (selectedProvider === "off") {
    return offNodeGitHistoryConfiguration(companionFields.flatMap((field) =>
      environment[field] === undefined
        ? []
        : [{
          field,
          message: `${field} is ignored while ${providerField} is off.`,
          reason: "ignored_value" as const,
        }]
    ));
  }
  if (selectedProvider !== "cloudflare-artifacts") {
    return misconfiguredCapability(null, defaultLimits(), [{
      field: providerField,
      message: `${providerField} must be off or cloudflare-artifacts.`,
      reason: "unsupported_provider",
    }]);
  }

  const fileCopyLimit = yield* parseLimit(
    environment,
    fileCopyLimitField,
    defaultGitHistoryFileCopyBytes,
    nonNegativeIntegerFromString,
  );
  const versionCopyLimit = yield* parseLimit(
    environment,
    versionCopyLimitField,
    defaultGitHistoryVersionCopyBytes,
    boundedVersionBytesFromString,
  );
  const storageBudget = yield* parseOptionalLimit(
    environment,
    storageBudgetField,
  );
  const limits: GitHistoryLimits = {
    fileCopyBytes: fileCopyLimit.value,
    logicalCopiedBytes: 0,
    logicalReservedBytes: 0,
    storageBudgetBytes: storageBudget.value,
    versionCopyBytes: versionCopyLimit.value,
  };
  const issues = [
    fileCopyLimit.issue,
    versionCopyLimit.issue,
    storageBudget.issue,
  ].filter((issue): issue is GitHistoryConfigurationIssue => issue !== null);
  const accountId = yield* parseRequiredValue(environment, accountIdField);
  const namespace = yield* parseRequiredValue(environment, namespaceField);
  if (accountId.issue !== null) issues.push(accountId.issue);
  if (namespace.issue !== null) issues.push(namespace.issue);
  if (environment[apiTokenField] !== undefined) {
    issues.push({
      field: apiTokenField,
      message: `${apiTokenField} is not accepted; configure ${apiTokenFileField}.`,
      reason: "direct_secret_forbidden",
    });
  }
  const tokenFile = environment[apiTokenFileField]?.trim() ?? "";
  if (tokenFile === "") {
    issues.push({
      field: apiTokenFileField,
      message: `${apiTokenFileField} is required for the Node REST control plane.`,
      reason: "missing_value",
    });
  }
  if (issues.length > 0) {
    return misconfiguredCapability("cloudflare-artifacts", limits, issues);
  }

  const apiToken = yield* readApiTokenFile(tokenFile);
  if (apiToken._tag === "Issue") {
    return misconfiguredCapability(
      "cloudflare-artifacts",
      limits,
      [apiToken.issue],
    );
  }
  return {
    _tag: "CloudflareArtifactsRest",
    apiToken: apiToken.value,
    capability: {
      limits,
      provider: "cloudflare-artifacts",
      providerState: "checking",
    },
    identity: {
      accountId: accountId.value,
      namespace: namespace.value,
      provider: "cloudflare-artifacts",
    },
    issues: [],
  };
});

function defaultLimits(): GitHistoryLimits {
  return disabledGitHistoryCapability().limits;
}

function misconfiguredCapability(
  provider: "cloudflare-artifacts" | null,
  limits: GitHistoryLimits,
  issues: readonly GitHistoryConfigurationIssue[],
): NodeGitHistoryConfiguration {
  return {
    _tag: "Misconfigured",
    capability: {
      limits,
      provider,
      providerState: "misconfigured",
    },
    issues,
  };
}

const parseLimit = Effect.fn("GitHistory.parseLimit")(function*(
  environment: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
  schema: typeof nonNegativeIntegerFromString,
): Effect.fn.Return<ParsedLimit> {
  const raw = environment[field];
  if (raw === undefined) return {issue: null, value: fallback};
  return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.match({
      onFailure: () => ({
        issue: {
          field,
          message: `${field} must be a non-negative integer within the provider-safe bound.`,
          reason: "invalid_value" as const,
        },
        value: fallback,
      }),
      onSuccess: (value) => ({issue: null, value}),
    }),
  );
});

const parseOptionalLimit = Effect.fn("GitHistory.parseOptionalLimit")(
  function*(
    environment: NodeJS.ProcessEnv,
    field: string,
  ): Effect.fn.Return<ParsedOptionalLimit> {
    const raw = environment[field];
    if (raw === undefined) return {issue: null, value: null};
    return yield* Schema.decodeUnknownEffect(nonNegativeIntegerFromString)(raw).pipe(
      Effect.match({
        onFailure: () => ({
          issue: {
            field,
            message: `${field} must be a non-negative integer when configured.`,
            reason: "invalid_value" as const,
          },
          value: null,
        }),
        onSuccess: (value) => ({issue: null, value}),
      }),
    );
  },
);

const parseRequiredValue = Effect.fn("GitHistory.parseRequiredValue")(
  function*(
    environment: NodeJS.ProcessEnv,
    field: string,
  ): Effect.fn.Return<
    | {readonly issue: null; readonly value: string}
    | {readonly issue: GitHistoryConfigurationIssue; readonly value: ""}
  > {
    const raw = environment[field]?.trim() ?? "";
    return yield* Schema.decodeUnknownEffect(nonEmptyConfigurationValue)(raw).pipe(
      Effect.match({
        onFailure: () => ({
          issue: {
            field,
            message: `${field} is required and must contain a bounded nonempty value.`,
            reason: raw === "" ? "missing_value" as const : "invalid_value" as const,
          },
          value: "" as const,
        }),
        onSuccess: (value) => ({issue: null, value}),
      }),
    );
  },
);

const readApiTokenFile = Effect.fn("GitHistory.readApiTokenFile")(function*(
  filePath: string,
): Effect.fn.Return<
  | {readonly _tag: "Token"; readonly value: Redacted.Redacted}
  | {readonly _tag: "Issue"; readonly issue: GitHistoryConfigurationIssue}
> {
  const contents = yield* Effect.tryPromise({
    try: async () => {
      const handle = await open(path.resolve(filePath), "r");
      try {
        const buffer = Buffer.alloc(maximumApiTokenBytes + 1);
        const {bytesRead} = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          0,
        );
        return bytesRead > maximumApiTokenBytes
          ? null
          : buffer.toString("utf8", 0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (Result.isFailure(contents)) {
    return {
      _tag: "Issue",
      issue: {
        field: apiTokenFileField,
        message: `The secret file configured by ${apiTokenFileField} cannot be read.`,
        reason: "secret_unreadable",
      },
    };
  }
  if (contents.success === null) {
    return {
      _tag: "Issue",
      issue: {
        field: apiTokenFileField,
        message: `The secret file configured by ${apiTokenFileField} exceeds the bounded token size.`,
        reason: "invalid_value",
      },
    };
  }
  const token = yield* Schema.decodeUnknownEffect(apiTokenSchema)(
    contents.success.trim(),
  ).pipe(Effect.result);
  if (Result.isFailure(token)) {
    return {
      _tag: "Issue",
      issue: {
        field: apiTokenFileField,
        message: `The secret file configured by ${apiTokenFileField} is empty or invalid.`,
        reason: "invalid_value",
      },
    };
  }
  return {
    _tag: "Token",
    value: Redacted.make(token.success, {label: apiTokenField}),
  };
});
