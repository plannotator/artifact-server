import type { CloudflareDeploymentInput } from "./deployment-input.js";

const WORKER_NAME_LIMIT = 63;
const D1_NAME_LIMIT = 64;
const R2_NAME_LIMIT = 63;

const hashName = (value: string): string => {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const boundedName = (value: string, limit: number): string => {
  if (value.length <= limit) {
    return value;
  }
  const digest = hashName(value);
  return `${value.slice(0, limit - digest.length - 1)}-${digest}`;
};

export interface CloudflareDeploymentManifest {
  readonly stackName: string;
  readonly stage: string;
  readonly resourceNames: {
    readonly worker: string;
    readonly database: string;
    readonly bucket: string;
  };
  readonly applicationOrigin: string;
  readonly routes: {
    readonly application: string;
    readonly content: string;
  };
  readonly workerTags: ReadonlyArray<string>;
  readonly runtimeConfiguration: {
    readonly ARTIFACT_SERVER_ORIGIN: string;
    readonly ARTIFACT_SERVER_CONTENT_DOMAIN: string;
    readonly ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: string;
    readonly ARTIFACT_SERVER_HOST: "0.0.0.0";
    readonly ARTIFACT_SERVER_PORT: 8787;
    readonly ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: number;
    readonly ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: 1000;
    readonly ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: 10000;
    readonly ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER: "r2";
  };
}

export const buildCloudflareDeploymentManifest = (
  input: CloudflareDeploymentInput,
): CloudflareDeploymentManifest => {
  const baseName = [
    "artifact-server",
    input.installationName,
    input.environment,
    input.stage,
  ].join("-");
  const requiredTags = {
    ...input.resourceTags,
    application: "artifact-server",
    environment: input.environment,
    installation: input.installationName,
    managedBy: "alchemy",
  };

  return {
    stackName: "artifact-server-cloudflare",
    stage: input.stage,
    resourceNames: {
      worker: boundedName(`${baseName}-worker`, WORKER_NAME_LIMIT),
      database: boundedName(`${baseName}-records`, D1_NAME_LIMIT),
      bucket: boundedName(`${baseName}-objects`, R2_NAME_LIMIT),
    },
    applicationOrigin: `https://${input.applicationDomain}`,
    routes: {
      application: `${input.applicationDomain}/*`,
      content: `${input.contentDomain}/*`,
    },
    workerTags: Object.entries(requiredTags)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}:${value}`),
    runtimeConfiguration: {
      ARTIFACT_SERVER_ORIGIN: `https://${input.applicationDomain}`,
      ARTIFACT_SERVER_CONTENT_DOMAIN: input.contentDomain,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
        input.bootstrapAdministratorEmail,
      ARTIFACT_SERVER_HOST: "0.0.0.0",
      ARTIFACT_SERVER_PORT: 8787,
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE:
        input.requestLogSampleRate ?? 0.01,
      ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: 1000,
      ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: 10000,
      ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER: "r2",
    },
  };
};
