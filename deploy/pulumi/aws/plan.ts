import {Effect, Schema} from "effect";

import type {AwsCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

interface AwsDatabasePlan {
  readonly allocatedStorageGiB: number;
  readonly connectionBudget: number;
  readonly instanceClass: string;
  readonly maximumStorageGiB: number;
  readonly multiAz: boolean;
  readonly performanceInsights: boolean;
}

/** Provider-specific choices derived from the shared deployment input. */
export interface AwsDeploymentPlan {
  readonly cpuUnits: number;
  readonly database: AwsDatabasePlan;
  readonly desiredCount: number;
  readonly memoryMiB: number;
  readonly natGatewayCount: number;
  readonly maximumDatabaseConnections: number;
}

/** A shared input cannot be represented safely by AWS Fargate or the chosen RDS plan. */
export class AwsDeploymentPlanError extends Schema.TaggedError<
  AwsDeploymentPlanError
>()(
  "AwsDeploymentPlanError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "database_connection_budget_exceeded",
      "unsupported_fargate_capacity",
    ]),
  },
) {}

const databasePlans = {
  "high-availability": {
    allocatedStorageGiB: 100,
    connectionBudget: 500,
    instanceClass: "db.m7g.large",
    maximumStorageGiB: 1_000,
    multiAz: true,
    performanceInsights: true,
  },
  small: {
    allocatedStorageGiB: 20,
    connectionBudget: 80,
    instanceClass: "db.t4g.micro",
    maximumStorageGiB: 100,
    multiAz: false,
    performanceInsights: false,
  },
  standard: {
    allocatedStorageGiB: 50,
    connectionBudget: 200,
    instanceClass: "db.t4g.medium",
    maximumStorageGiB: 500,
    multiAz: false,
    performanceInsights: true,
  },
} as const satisfies Record<AwsCloudDeploymentInput["databasePlan"], AwsDatabasePlan>;

const postgresConnectionsPerReplica = 10;
const migrationConnections = 1;

/** Build the concrete AWS capacity plan before defining a provider resource. */
export const makeAwsDeploymentPlan = Effect.fn("makeAwsDeploymentPlan")(
  function*(input: AwsCloudDeploymentInput): Effect.fn.Return<
    AwsDeploymentPlan,
    AwsDeploymentPlanError
  > {
    const cpuUnits = input.capacity.cpu * 1_024;
    if (!isValidFargateCapacity(cpuUnits, input.capacity.memoryMiB)) {
      return yield* new AwsDeploymentPlanError({
        field: "capacity",
        message: "The requested CPU and memory are not a valid AWS Fargate combination.",
        reason: "unsupported_fargate_capacity",
      });
    }

    const database = databasePlans[input.databasePlan];
    const maximumDatabaseConnections = input.capacity.maximumInstances *
      (postgresConnectionsPerReplica + migrationConnections) * 2;
    if (maximumDatabaseConnections > database.connectionBudget) {
      return yield* new AwsDeploymentPlanError({
        field: "capacity.maximumInstances",
        message: "The maximum replica count exceeds the selected database connection budget.",
        reason: "database_connection_budget_exceeded",
      });
    }

    return {
      cpuUnits,
      database,
      desiredCount: input.capacity.minimumInstances,
      memoryMiB: input.capacity.memoryMiB,
      natGatewayCount: input.environment === "production" ? 2 : 1,
      maximumDatabaseConnections,
    };
  },
);

function isValidFargateCapacity(cpuUnits: number, memoryMiB: number): boolean {
  switch (cpuUnits) {
    case 256:
      return [512, 1_024, 2_048].includes(memoryMiB);
    case 512:
      return inSteps(memoryMiB, 1_024, 4_096, 1_024);
    case 1_024:
      return inSteps(memoryMiB, 2_048, 8_192, 1_024);
    case 2_048:
      return inSteps(memoryMiB, 4_096, 16_384, 1_024);
    case 4_096:
      return inSteps(memoryMiB, 8_192, 30_720, 1_024);
    case 8_192:
      return inSteps(memoryMiB, 16_384, 61_440, 4_096);
    case 16_384:
      return inSteps(memoryMiB, 32_768, 122_880, 8_192);
    default:
      return false;
  }
}

function inSteps(
  value: number,
  minimum: number,
  maximum: number,
  step: number,
): boolean {
  return value >= minimum && value <= maximum &&
    (value - minimum) % step === 0;
}
