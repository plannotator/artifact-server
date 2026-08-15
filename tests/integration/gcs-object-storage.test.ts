import {Storage} from "@google-cloud/storage";
import {beforeAll} from "vitest";

import {createGcsObjectStorageAdapters} from
  "../../src/storage/gcs-object-storage.js";
import {
  defineNativeObjectStorageContract,
  nativeBlobKey,
} from "../support/native-object-storage-contract.js";

const bucketName = "artifact-server-integration";
const projectId = "artifact-server-integration";
const endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_GCS_ENDPOINT");
const storage = new Storage({apiEndpoint: endpoint, projectId});
const bucket = storage.bucket(bucketName);

beforeAll(async () => {
  const [exists] = await bucket.exists();
  if (!exists) await storage.createBucket(bucketName);
});

defineNativeObjectStorageContract({
  name: "GCS",
  create: (installationId) => createGcsObjectStorageAdapters({
    bucket,
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
      ? {"artifact-kind": kind}
      : {"artifact-kind": kind, "artifact-sha256": recordedDigest};
    await bucket.file(nativeBlobKey(installationId, objectDigest)).save(bytes, {
      metadata: {metadata},
      resumable: false,
    });
  },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("Run this test through pnpm test:storage-native-cloud.");
  }
  return value;
}
