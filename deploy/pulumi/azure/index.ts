import * as azure from "@pulumi/azure-native";

import {readAzurePulumiConfiguration} from "./configuration.js";
import {defineAzureStack} from "./stack.js";

const client = await azure.authorization.getClientConfig();
const configuration = readAzurePulumiConfiguration(client.subscriptionId);
const stack = defineAzureStack({...configuration, tenantId: client.tenantId});

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
