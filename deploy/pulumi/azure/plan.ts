import {Effect, Schema} from "effect";

import type {AzureCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

interface AzureDatabasePlan {
  readonly connectionBudget: number;
  readonly highAvailabilityMode: "Disabled" | "ZoneRedundant";
  readonly skuName: string;
  readonly storageSizeGiB: number;
  readonly tier: "Burstable" | "GeneralPurpose";
}

/** Concrete Container Apps and PostgreSQL plan derived from shared inputs. */
export interface AzureDeploymentPlan {
  readonly cpu: number;
  readonly database: AzureDatabasePlan;
  readonly maximumDatabaseConnections: number;
  readonly memory: string;
}

/** Shared input cannot currently be represented safely by Azure. */
export class AzureDeploymentPlanError extends Schema.TaggedError<AzureDeploymentPlanError>()(
  "AzureDeploymentPlanError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "database_connection_budget_exceeded",
      "private_ingress_not_implemented",
      "unsupported_container_apps_capacity",
    ]),
  },
) {}

const databasePlans = {
  "high-availability": {
    connectionBudget: 500,
    highAvailabilityMode: "ZoneRedundant",
    skuName: "Standard_D4ds_v5",
    storageSizeGiB: 128,
    tier: "GeneralPurpose",
  },
  small: {
    connectionBudget: 80,
    highAvailabilityMode: "Disabled",
    skuName: "Standard_B2ms",
    storageSizeGiB: 32,
    tier: "Burstable",
  },
  standard: {
    connectionBudget: 200,
    highAvailabilityMode: "Disabled",
    skuName: "Standard_D2ds_v5",
    storageSizeGiB: 64,
    tier: "GeneralPurpose",
  },
} as const satisfies Record<
  AzureCloudDeploymentInput["databasePlan"],
  AzureDatabasePlan
>;

const allowedCpuMemory = new Map<number, ReadonlySet<number>>([
  [0.25, new Set([512])],
  [0.5, new Set([1_024])],
  [0.75, new Set([1_536])],
  [1, new Set([2_048])],
  [1.25, new Set([2_560])],
  [1.5, new Set([3_072])],
  [1.75, new Set([3_584])],
  [2, new Set([4_096])],
  [4, new Set([8_192])],
]);
const postgresConnectionsPerReplica = 10;
const migrationConnections = 1;

/** Validate capacity and provider limits before Pulumi writes resources. */
export const makeAzureDeploymentPlan = Effect.fn("makeAzureDeploymentPlan")(
  function*(input: AzureCloudDeploymentInput): Effect.fn.Return<
    AzureDeploymentPlan,
    AzureDeploymentPlanError
  > {
    if (input.ingress === "private") {
      return yield* new AzureDeploymentPlanError({
        field: "ingress",
        message: "Private Azure ingress remains blocked until its internal path is qualified.",
        reason: "private_ingress_not_implemented",
      });
    }
    if (!allowedCpuMemory.get(input.capacity.cpu)?.has(input.capacity.memoryMiB)) {
      return yield* new AzureDeploymentPlanError({
        field: "capacity",
        message: "CPU and memory are not a supported Container Apps consumption pair.",
        reason: "unsupported_container_apps_capacity",
      });
    }
    const database = databasePlans[input.databasePlan];
    const maximumDatabaseConnections = input.capacity.maximumInstances *
      (postgresConnectionsPerReplica + migrationConnections) * 2;
    if (maximumDatabaseConnections > database.connectionBudget) {
      return yield* new AzureDeploymentPlanError({
        field: "capacity.maximumInstances",
        message: "The maximum replica count exceeds the selected PostgreSQL connection budget.",
        reason: "database_connection_budget_exceeded",
      });
    }
    return {
      cpu: input.capacity.cpu,
      database,
      maximumDatabaseConnections,
      memory: `${input.capacity.memoryMiB / 1_024}Gi`,
    };
  },
);
