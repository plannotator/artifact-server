import type {
  RuntimeConfigurationSummary,
} from "./runtime-configuration.js";
import type {RuntimeInspection} from "./runtime-inspection.js";
import type {ObjectStorageProviderKind} from
  "../storage/object-storage-provider.js";

/** Build and release identity injected into lifecycle diagnostics. */
export interface ProductBuildInformation {
  readonly imageRevision: string | null;
  readonly product: "artifact-server";
  readonly productVersion: string;
  readonly schemaVersion: number;
}

/** Secret-free operator record for one configured Artifact Server process. */
export interface SupportManifest {
  readonly adapters: {
    readonly database: "postgres" | "sqlite";
    readonly objectStorage: "filesystem" | ObjectStorageProviderKind;
  };
  readonly configuration: RuntimeConfigurationSummary;
  readonly imageRevision: string | null;
  readonly installationId: string;
  readonly nodeVersion: string;
  readonly providers: RuntimeInspection;
  readonly product: "artifact-server";
  readonly productVersion: string;
  readonly schemaVersion: number;
}

/** Create the credential-free manifest used in releases and support reports. */
export function createSupportManifest(
  build: ProductBuildInformation,
  configuration: RuntimeConfigurationSummary,
  providers: RuntimeInspection,
): SupportManifest {
  return {
    adapters: {
      database: configuration.deploymentMode === "compact" ? "sqlite" : "postgres",
      objectStorage: configuration.objectStorageProvider,
    },
    configuration,
    imageRevision: build.imageRevision,
    installationId: configuration.installationId,
    nodeVersion: process.version,
    providers,
    product: build.product,
    productVersion: build.productVersion,
    schemaVersion: build.schemaVersion,
  };
}
