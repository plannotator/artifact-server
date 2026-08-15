import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {beforeAll} from "vitest";

import {createAzureBlobObjectStorageAdapters} from
  "../../src/storage/azure-blob-object-storage.js";
import {
  defineNativeObjectStorageContract,
  nativeBlobKey,
} from "../support/native-object-storage-contract.js";

const accountName = "devstoreaccount1";
const accountKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/" +
  "K1SZFPTOtr/KBHBeksoGMGw==";
const containerName = "artifact-server-integration";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_AZURE_BLOB_ENDPOINT");
const credential = new StorageSharedKeyCredential(accountName, accountKey);
const service = new BlobServiceClient(endpoint, credential);
const container = service.getContainerClient(containerName);

beforeAll(async () => {
  await container.createIfNotExists();
});

defineNativeObjectStorageContract({
  name: "Azure Blob",
  create: (installationId) => createAzureBlobObjectStorageAdapters({
    container,
    installationId,
  }),
  corrupt: async ({
    bytes,
    installationId,
    kind,
    objectDigest,
    recordedDigest,
  }) => {
    const metadata = recordedDigest === null
      ? {artifactkind: kind}
      : {artifactkind: kind, artifactsha256: recordedDigest};
    await container
      .getBlockBlobClient(nativeBlobKey(installationId, objectDigest))
      .uploadData(bytes, {metadata});
  },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
