import * as pulumi from "@pulumi/pulumi";
import {Effect, Exit} from "effect";

import {
  type AwsCloudDeploymentInput,
  type CloudDeploymentDocument,
  parseCloudDeploymentInput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {makeAwsDeploymentPlan, type AwsDeploymentPlan} from "./plan.js";

export interface ParsedAwsPulumiConfiguration {
  readonly input: AwsCloudDeploymentInput;
  readonly plan: AwsDeploymentPlan;
}

/** Read native Pulumi stack configuration and enforce the shared cloud contract. */
export function readAwsPulumiConfiguration(): ParsedAwsPulumiConfiguration {
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
    target: "aws",
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
    "privateIngressCidrs",
    config.getObject("privateIngressCidrs"),
  );
  document = withOptional(
    document,
    "requestLogSampleRate",
    config.getNumber("requestLogSampleRate"),
  );
  document = withOptional(document, "resourceTags", config.getObject("resourceTags"));
  document = withOptional(
    document,
    "tlsCertificateArn",
    config.get("tlsCertificateArn"),
  );
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
  return parseAwsPulumiConfiguration(document, pulumi.getStack());
}

/** Parse an already-loaded document; exported for deterministic contract tests. */
export function parseAwsPulumiConfiguration(
  document: CloudDeploymentDocument,
  actualStackName: string,
): ParsedAwsPulumiConfiguration {
  const inputExit = Effect.runSyncExit(parseCloudDeploymentInput(document));
  if (Exit.isFailure(inputExit)) {
    throw new pulumi.RunError(
      "AWS deployment configuration does not satisfy the shared cloud contract.",
    );
  }
  const input = inputExit.value;
  if (input.target !== "aws") {
    throw new pulumi.RunError("The AWS deployment project requires target=aws.");
  }
  if (input.stackName !== actualStackName) {
    throw new pulumi.RunError(
      `Configured stackName must equal the active Pulumi stack (${actualStackName}).`,
    );
  }
  const planExit = Effect.runSyncExit(makeAwsDeploymentPlan(input));
  if (Exit.isFailure(planExit)) {
    throw new pulumi.RunError(
      "AWS capacity does not fit the supported Fargate and RDS plans.",
    );
  }
  return {input, plan: planExit.value};
}

function withOptional(
  target: CloudDeploymentDocument,
  key: string,
  value: CloudDeploymentDocument[string] | undefined,
): CloudDeploymentDocument {
  if (value === undefined) return target;
  return {...target, [key]: value};
}
