import type {BlobStore, StagingStore} from "../core/ports.js";

/** Object-storage adapters with first-party deployment support. */
export const objectStorageProviderKinds = [
  "azure-blob",
  "gcs",
  "r2",
  "s3",
] as const;

export type ObjectStorageProviderKind =
  typeof objectStorageProviderKinds[number];

/**
 * One connected object-storage provider owned by an Artifact Server runtime.
 *
 * Application services receive only the blob and staging ports. Provider
 * health checks and shutdown stay at the deployment boundary.
 */
export interface ObjectStorageProvider {
  readonly blobs: BlobStore;
  readonly kind: ObjectStorageProviderKind;
  readonly staging: StagingStore;
  close(): Promise<void>;
  readiness(signal: AbortSignal): Promise<void>;
}

/**
 * Deployment-owned factory for one configured object-storage provider.
 *
 * A factory creates an installation-scoped provider without exposing a cloud
 * SDK or provider credential to the server runtime.
 */
export interface ObjectStorageProviderFactory {
  readonly kind: ObjectStorageProviderKind;
  create(installationId: string): ObjectStorageProvider;
}
