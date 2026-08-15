import * as pulumi from "@pulumi/pulumi";
import {Effect, Exit} from "effect";

import {
  type AzureCloudDeploymentInput,
  type CloudDeploymentDocument,
  parseCloudDeploymentInput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {makeAzureDeploymentPlan, type AzureDeploymentPlan} from "./plan.js";
import {validateAzureResourceIdentifiers} from "./resource-identifiers.js";

/** Validated Azure configuration and concrete capacity plan. */
export interface ParsedAzurePulumiConfiguration {
  readonly input: AzureCloudDeploymentInput;
  readonly plan: AzureDeploymentPlan;
  readonly subscriptionId: string;
}

/** Read Pulumi configuration and enforce the shared cloud contract. */
export function readAzurePulumiConfiguration(
  subscriptionId: string,
): ParsedAzurePulumiConfiguration {
  const config = new pulumi.Config();
  let document: CloudDeploymentDocument = {
    applicationDomain: config.require("applicationDomain"),
    backupRetentionDays: config.requireNumber("backupRetentionDays"),
    bootstrapAdministratorEmail: config.require("bootstrapAdministratorEmail"),
    capacity: config.requireObject("capacity"),
    contentDomain: config.require("contentDomain"),
    databasePlan: config.require("databasePlan"),
    deletionProtection: config.requireBoolean("deletionProtection"),
    environment: config.require("environment"),
    imageReference: config.require("imageReference"),
    ingress: config.require("ingress"),
    installationName: config.require("installationName"),
    region: config.require("region"),
    secretsProvider: config.require("secretsProvider"),
    stackName: config.require("stackName"),
    stateBackendUrl: config.require("stateBackendUrl"),
    target: "azure",
  };
  document = withOptional(document, "dnsZoneIds", config.getObject("dnsZoneIds"));
  document = withOptional(
    document,
    "existingNetwork",
    config.getObject("existingNetwork"),
  );
  document = withOptional(document, "otlpEndpoint", config.get("otlpEndpoint"));
  document = withOptional(
    document,
    "requestLogSampleRate",
    config.getNumber("requestLogSampleRate"),
  );
  document = withOptional(document, "resourceTags", config.getObject("resourceTags"));
  document = withOptional(
    document,
    "tlsCertificateSecretId",
    config.get("tlsCertificateSecretId"),
  );
  document = withOptional(
    document,
    "workosApiKeySecretRef",
    config.get("workosApiKeySecretRef"),
  );
  document = withOptional(document, "workosClientId", config.get("workosClientId"));
  return parseAzurePulumiConfiguration(document, pulumi.getStack(), subscriptionId);
}

/** Parse preloaded input for deterministic tests and previews. */
export function parseAzurePulumiConfiguration(
  document: CloudDeploymentDocument,
  actualStackName: string,
  subscriptionId: string,
): ParsedAzurePulumiConfiguration {
  if (subscriptionId === "") {
    throw new pulumi.RunError("Authenticate the Azure Native provider to a subscription.");
  }
  const inputExit = Effect.runSyncExit(parseCloudDeploymentInput(document));
  if (Exit.isFailure(inputExit)) {
    throw new pulumi.RunError(
      "Azure deployment configuration does not satisfy the shared cloud contract.",
    );
  }
  const input = inputExit.value;
  if (input.target !== "azure") {
    throw new pulumi.RunError("The Azure deployment project requires target=azure.");
  }
  if (input.stackName !== actualStackName) {
    throw new pulumi.RunError(
      `Configured stackName must equal the active Pulumi stack (${actualStackName}).`,
    );
  }
  validateAzureResourceIdentifiers(input);
  const planExit = Effect.runSyncExit(makeAzureDeploymentPlan(input));
  if (Exit.isFailure(planExit)) {
    throw new pulumi.RunError(
      "Azure capacity or ingress is not in the currently supported deployment plan.",
    );
  }
  return {input, plan: planExit.value, subscriptionId};
}

function withOptional(
  target: CloudDeploymentDocument,
  key: string,
  value: CloudDeploymentDocument[string] | undefined,
): CloudDeploymentDocument {
  if (value === undefined) return target;
  return {...target, [key]: value};
}
