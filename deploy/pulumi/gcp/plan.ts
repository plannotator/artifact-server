import {Effect, Schema} from "effect";

import type {GcpCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

interface GcpDatabasePlan {
  readonly availabilityType: "REGIONAL" | "ZONAL";
  readonly connectionBudget: number;
  readonly diskSizeGiB: number;
  readonly tier: string;
}

/** Provider-specific choices derived from the shared deployment input. */
export interface GcpDeploymentPlan {
  readonly cpu: string;
  readonly database: GcpDatabasePlan;
  readonly maximumDatabaseConnections: number;
  readonly memory: string;
}

/** A shared input cannot yet be represented safely by the GCP package. */
export class GcpDeploymentPlanError extends Schema.TaggedError<
  GcpDeploymentPlanError
>()(
  "GcpDeploymentPlanError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "database_connection_budget_exceeded",
      "private_ingress_not_implemented",
      "unsupported_cloud_run_capacity",
    ]),
  },
) {}

const databasePlans = {
  "high-availability": {
    availabilityType: "REGIONAL",
    connectionBudget: 500,
    diskSizeGiB: 100,
    tier: "db-custom-4-15360",
  },
  small: {
    availabilityType: "ZONAL",
    connectionBudget: 80,
    diskSizeGiB: 20,
    tier: "db-custom-1-3840",
  },
  standard: {
    availabilityType: "ZONAL",
    connectionBudget: 200,
    diskSizeGiB: 50,
    tier: "db-custom-2-7680",
  },
} as const satisfies Record<
  GcpCloudDeploymentInput["databasePlan"],
  GcpDatabasePlan
>;

const supportedCpu = new Set([0.25, 0.5, 1, 2, 4, 8]);
const postgresConnectionsPerReplica = 10;
const migrationConnections = 1;

/** Build the concrete Cloud Run and Cloud SQL plan before provider writes. */
export const makeGcpDeploymentPlan = Effect.fn("makeGcpDeploymentPlan")(
  function*(input: GcpCloudDeploymentInput): Effect.fn.Return<
    GcpDeploymentPlan,
    GcpDeploymentPlanError
  > {
    if (input.ingress === "private") {
      return yield* new GcpDeploymentPlanError({
        field: "ingress",
        message: "Private GCP ingress remains blocked until its internal load balancer is qualified.",
        reason: "private_ingress_not_implemented",
      });
    }
    if (
      !supportedCpu.has(input.capacity.cpu) ||
      input.capacity.memoryMiB < 512 || input.capacity.memoryMiB > 32_768
    ) {
      return yield* new GcpDeploymentPlanError({
        field: "capacity",
        message: "The requested CPU and memory are not in the supported Cloud Run envelope.",
        reason: "unsupported_cloud_run_capacity",
      });
    }
    const database = databasePlans[input.databasePlan];
    const maximumDatabaseConnections = input.capacity.maximumInstances *
      (postgresConnectionsPerReplica + migrationConnections) * 2;
    if (maximumDatabaseConnections > database.connectionBudget) {
      return yield* new GcpDeploymentPlanError({
        field: "capacity.maximumInstances",
        message: "The maximum replica count exceeds the selected Cloud SQL connection budget.",
        reason: "database_connection_budget_exceeded",
      });
    }
    return {
      cpu: String(input.capacity.cpu),
      database,
      maximumDatabaseConnections,
      memory: `${input.capacity.memoryMiB}Mi`,
    };
  },
);
