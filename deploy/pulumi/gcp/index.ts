import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import {readGcpPulumiConfiguration} from "./configuration.js";
import {defineGcpStack} from "./stack.js";

const projectId = gcp.config.project;
if (projectId === undefined) {
  throw new pulumi.RunError("Set gcp:project to the target Google Cloud project.");
}
const configuration = readGcpPulumiConfiguration(projectId);
if (gcp.config.region !== undefined && gcp.config.region !== configuration.input.region) {
  throw new pulumi.RunError(
    `Set gcp:region to ${configuration.input.region}; the provider and shared region must match.`,
  );
}
const stack = defineGcpStack(configuration);

export const deployment = stack.deployment;
export const applicationUrl = stack.deployment.applicationUrl;
export const contentDomain = stack.deployment.contentDomain;
export const databaseResourceId = stack.deployment.databaseResourceId;
export const healthUrl = stack.deployment.healthUrl;
export const imageDigest = stack.deployment.imageDigest;
export const installationId = stack.deployment.installationId;
export const logDestination = stack.deployment.logDestination;
export const mcpUrl = stack.deployment.mcpUrl;
export const networkResourceIds = stack.deployment.networkResourceIds;
export const objectStorageResourceId = stack.deployment.objectStorageResourceId;
export const readinessUrl = stack.deployment.readinessUrl;
export const runtimeResourceId = stack.deployment.runtimeResourceId;
export const secretResourceIds = stack.deployment.secretResourceIds;
export const stateBackend = stack.deployment.stateBackend;
export const supportManifestLocation = stack.deployment.supportManifestLocation;
export const workloadIdentityResourceId = stack.deployment.workloadIdentityResourceId;
