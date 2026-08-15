import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  type CloudflareCloudDeploymentInput,
  parseCloudDeploymentInput,
} from "../../../src/deployment/cloud-deployment-contract.ts";

export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-15";
export const CLOUDFLARE_REGION = "global";

const DeploymentDocumentFromJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Json),
);

export const cloudflareDeploymentDocumentConfig = Config.schema(
  DeploymentDocumentFromJson,
  "ARTIFACT_SERVER_CLOUDFLARE_CONFIG",
);

const configurationError = (message: string) =>
  new Config.ConfigError(
    new Schema.SchemaError(
      new SchemaIssue.InvalidValue({ message }),
    ),
  );

export const parseCloudflareDeploymentInput = Effect.fn(
  "parseCloudflareDeploymentInput",
)(function* (
  document: typeof DeploymentDocumentFromJson.Type,
): Effect.fn.Return<
  CloudflareCloudDeploymentInput,
  Config.ConfigError
> {
  const input = yield* parseCloudDeploymentInput(document).pipe(
    Effect.mapError(() =>
      configurationError(
        "Cloudflare deployment configuration does not satisfy the shared contract",
      ),
    ),
  );
  if (input.target !== "cloudflare") {
    return yield* Effect.fail(
      configurationError("target must be cloudflare"),
    );
  }
  if (input.compatibilityDate !== CLOUDFLARE_COMPATIBILITY_DATE) {
    return yield* Effect.fail(
      configurationError(
        `compatibilityDate must be ${CLOUDFLARE_COMPATIBILITY_DATE}`,
      ),
    );
  }
  if (input.stateStore !== "cloudflare") {
    return yield* Effect.fail(
      configurationError(
        "this entrypoint requires the cloudflare state store",
      ),
    );
  }
  return input;
});

export type CloudflareDeploymentInput =
  CloudflareCloudDeploymentInput;
