import * as pulumi from "@pulumi/pulumi";
import {Effect, Exit} from "effect";

import {
  type CloudDeploymentDocument,
  type GcpCloudDeploymentInput,
  parseCloudDeploymentInput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {makeGcpDeploymentPlan, type GcpDeploymentPlan} from "./plan.js";

/** Validated GCP configuration and its concrete capacity plan. */
export interface ParsedGcpPulumiConfiguration {
  readonly input: GcpCloudDeploymentInput;
  readonly plan: GcpDeploymentPlan;
  readonly projectId: string;
}

/** Read native Pulumi stack configuration and enforce the shared contract. */
export function readGcpPulumiConfiguration(
  projectId: string,
): ParsedGcpPulumiConfiguration {
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
    target: "gcp",
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
    "workosApiKeySecretRef",
    config.get("workosApiKeySecretRef"),
  );
  document = withOptional(
    document,
    "workosClientId",
    config.get("workosClientId"),
  );
  return parseGcpPulumiConfiguration(document, pulumi.getStack(), projectId);
}

/** Parse an already-loaded document for deterministic tests and previews. */
export function parseGcpPulumiConfiguration(
  document: CloudDeploymentDocument,
  actualStackName: string,
  projectId: string,
): ParsedGcpPulumiConfiguration {
  if (projectId === "") {
    throw new pulumi.RunError("Set gcp:project to the target Google Cloud project.");
  }
  const inputExit = Effect.runSyncExit(parseCloudDeploymentInput(document));
  if (Exit.isFailure(inputExit)) {
    throw new pulumi.RunError(
      "GCP deployment configuration does not satisfy the shared cloud contract.",
    );
  }
  const input = inputExit.value;
  if (input.target !== "gcp") {
    throw new pulumi.RunError("The GCP deployment project requires target=gcp.");
  }
  if (input.stackName !== actualStackName) {
    throw new pulumi.RunError(
      `Configured stackName must equal the active Pulumi stack (${actualStackName}).`,
    );
  }
  const planExit = Effect.runSyncExit(makeGcpDeploymentPlan(input));
  if (Exit.isFailure(planExit)) {
    throw new pulumi.RunError(
      "GCP capacity or ingress is not in the currently supported deployment plan.",
    );
  }
  return {input, plan: planExit.value, projectId};
}

function withOptional(
  target: CloudDeploymentDocument,
  key: string,
  value: CloudDeploymentDocument[string] | undefined,
): CloudDeploymentDocument {
  if (value === undefined) return target;
  return {...target, [key]: value};
}
