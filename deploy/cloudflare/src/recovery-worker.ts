import {createHash, timingSafeEqual} from "node:crypto";

import {Effect} from "effect";

import type {
  ArtifactRow,
  EntryRow,
  IntegrityCatalog,
  ProjectReferenceRow,
  ProjectRow,
  VersionRow,
} from "../../../src/lifecycle/integrity-check.js";
import {
  checkIntegrityCatalog,
} from "../../../src/lifecycle/integrity-check.js";
import {createR2ObjectStorageAdapters} from "./r2-object-storage.js";
import {requiredD1SchemaVersion} from "./d1-migrations.js";

interface RecoveryEnvironment {
  readonly ARTIFACT_SERVER_INSTALLATION_ID: string;
  readonly ARTIFACT_SERVER_RECOVERY_MODE: "copy" | "restore" | "source";
  readonly ARTIFACT_SERVER_RECOVERY_TOKEN: string;
  readonly RECOVERY_D1?: D1Database;
  readonly RECOVERY_R2?: R2Bucket;
  readonly SOURCE_R2?: R2Bucket;
  readonly TARGET_R2?: R2Bucket;
}

interface NamedQuery {
  readonly name: string;
  readonly sql: string;
}

type ObjectMetadata = R2HTTPMetadata | Record<string, string>;
type AsyncObjectOperation = (object: R2Object) => Promise<void>;
const recoveryOperations = [
  "copy_source_objects",
  "inspect_restore_target",
  "list_restored_objects",
  "list_source_objects",
  "restore_target_not_empty",
  "restored_object_count_mismatch",
  "source_objects_empty",
  "source_scope_mismatch",
  "validate_source_scope",
  "verify_restored_objects",
] as const;

class RecoveryOperationError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`Recovery operation failed: ${operation}`);
    this.operation = operation;
  }
}

const stateQueries: readonly NamedQuery[] = [
  {name: "artifact_server_schema", sql: "SELECT * FROM artifact_server_schema ORDER BY component"},
  {name: "projects", sql: "SELECT * FROM projects ORDER BY id"},
  {name: "artifacts", sql: "SELECT * FROM artifacts ORDER BY id"},
  {name: "versions", sql: "SELECT * FROM versions ORDER BY id"},
  {name: "manifest_entries", sql: "SELECT * FROM manifest_entries ORDER BY version_id, path"},
  {name: "artifact_tags", sql: "SELECT * FROM artifact_tags ORDER BY artifact_id, tag"},
  {name: "idempotency_records", sql: "SELECT * FROM idempotency_records ORDER BY project_id, idempotency_key"},
  {name: "actions", sql: "SELECT * FROM actions ORDER BY id"},
  {name: "staged_uploads", sql: "SELECT * FROM staged_uploads ORDER BY id"},
  {name: "staged_upload_files", sql: "SELECT * FROM staged_upload_files ORDER BY upload_id, storage_token"},
  {name: "content_bootstraps", sql: "SELECT * FROM content_bootstraps ORDER BY token_digest"},
  {name: "content_sessions", sql: "SELECT * FROM content_sessions ORDER BY token_digest"},
  {name: "installation_members", sql: "SELECT * FROM installation_members ORDER BY id"},
  {name: "external_identities", sql: "SELECT * FROM external_identities ORDER BY provider, subject"},
  {name: "application_sessions", sql: "SELECT * FROM application_sessions ORDER BY id"},
  {name: "git_history_provider_identity", sql: "SELECT * FROM git_history_provider_identity ORDER BY installation_id"},
  {name: "git_history_project_settings", sql: "SELECT * FROM git_history_project_settings ORDER BY project_id"},
  {name: "managed_api_keys", sql: "SELECT * FROM managed_api_keys ORDER BY id"},
  {name: "login_attempts", sql: "SELECT * FROM login_attempts ORDER BY state_digest"},
  {name: "mutation_checks", sql: "SELECT * FROM mutation_checks ORDER BY id"},
];

export default {
  async fetch(
    request: Request,
    environment: RecoveryEnvironment,
  ): Promise<Response> {
    if (!authorized(request, environment.ARTIFACT_SERVER_RECOVERY_TOKEN)) {
      return Response.json({error: "unauthorized"}, {status: 401});
    }
    try {
      const pathname = new URL(request.url).pathname;
      if (request.method === "GET" && pathname === "/ready") {
        return Response.json({mode: environment.ARTIFACT_SERVER_RECOVERY_MODE});
      }
      if (request.method === "POST" && pathname === "/copy") {
        return Response.json(await copyInstallationObjects(environment));
      }
      if (request.method === "GET" && pathname === "/inspect") {
        return Response.json(await inspectInstallation(environment));
      }
      return Response.json({error: "not_found"}, {status: 404});
    } catch (error) {
      return Response.json(
        {
          error: "recovery_operation_failed",
          operation: recoveryOperationName(
            error instanceof Error ? error : null,
          ),
        },
        {status: 503},
      );
    }
  },
};

function recoveryOperationName(error: Error | null): string {
  if (error === null) return "unknown";
  return recoveryOperations.find((operation) =>
    error.message === `Recovery operation failed: ${operation}`
  ) ?? "unknown";
}

function authorized(request: Request, expectedToken: string): boolean {
  const provided = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${expectedToken}`;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes);
}

async function inspectInstallation(environment: RecoveryEnvironment) {
  const database = requireBinding(environment.RECOVERY_D1);
  const bucket = requireBinding(environment.RECOVERY_R2);
  const installationId = environment.ARTIFACT_SERVER_INSTALLATION_ID;
  const schemaVersion = await database.prepare(`
    SELECT version FROM artifact_server_schema WHERE component = 'runtime'
  `).first<number>("version");
  if (schemaVersion !== requiredD1SchemaVersion) {
    throw new Error("Unexpected D1 schema revision.");
  }
  const installationRows = await database.prepare(`
    SELECT DISTINCT installation_id AS installationId
    FROM projects
    ORDER BY installation_id
  `).all<{readonly installationId: string}>();
  if (
    installationRows.results.length !== 1 ||
    installationRows.results[0]?.installationId !== installationId
  ) {
    throw new Error("D1 installation scope does not match recovery input.");
  }
  const foreignKeys = await database.prepare(
    "PRAGMA foreign_key_check",
  ).all();
  if (foreignKeys.results.length !== 0) {
    throw new Error("D1 foreign-key validation failed.");
  }
  const [catalog, state, inventory] = await Promise.all([
    readIntegrityCatalog(database),
    readStateDigest(database),
    inspectR2Inventory(bucket, installationPrefix(installationId)),
  ]);
  const {blobs} = createR2ObjectStorageAdapters(bucket, installationId);
  const integrity = await Effect.runPromise(
    checkIntegrityCatalog(catalog, blobs),
  );
  const identitySha256 = sha256(JSON.stringify({
    artifactIds: catalog.artifacts.map(({id}) => id).toSorted(),
    installationId,
    projectIds: catalog.projects.map(({id}) => id).toSorted(),
    versionIds: catalog.versions.map(({id}) => id).toSorted(),
  }));
  return {
    foreignKeyViolations: 0,
    integrity: {
      artifactsChecked: integrity.artifactsChecked,
      blobsChecked: integrity.blobsChecked,
      bytesChecked: integrity.bytesChecked,
      manifestsChecked: integrity.manifestsChecked,
      problemCount: integrity.problems.length,
      status: integrity.status,
      versionsChecked: integrity.versionsChecked,
    },
    identitySha256,
    objectCount: inventory.count,
    objectInventorySha256: inventory.digest,
    schemaVersion,
    stateSha256: state.digest,
    tableRows: state.tableRows,
  };
}

async function readIntegrityCatalog(
  database: D1Database,
): Promise<IntegrityCatalog> {
  const [artifacts, versions, entries, projects, projectReferences] =
    await Promise.all([
      database.prepare(`
        SELECT id, project_id AS projectId,
          current_version_id AS currentVersionId
        FROM artifacts ORDER BY id
      `).all<ArtifactRow>(),
      database.prepare(`
        SELECT id, artifact_id AS artifactId, project_id AS projectId,
          manifest_digest AS manifestDigest, entry_path AS entryPath,
          routing_mode AS routingMode
        FROM versions ORDER BY artifact_id, number
      `).all<VersionRow>(),
      database.prepare(`
        SELECT version_id AS versionId, path, size,
          media_type AS mediaType, sha256, disposition
        FROM manifest_entries ORDER BY version_id, path
      `).all<EntryRow>(),
      database.prepare("SELECT id FROM projects ORDER BY id").all<ProjectRow>(),
      database.prepare(`
        SELECT 'action' AS kind, id, project_id AS projectId,
          artifact_id AS artifactId, version_id AS versionId
        FROM actions
        UNION ALL
        SELECT 'idempotency', idempotency_key, project_id,
          artifact_id, version_id FROM idempotency_records
        UNION ALL
        SELECT 'staged_upload', id, project_id, NULL, committed_version_id
          FROM staged_uploads
        UNION ALL
        SELECT 'content_bootstrap', token_digest, project_id,
          artifact_id, version_id FROM content_bootstraps
        UNION ALL
        SELECT 'content_session', token_digest, project_id,
          artifact_id, version_id FROM content_sessions
        ORDER BY kind, id
      `).all<ProjectReferenceRow>(),
    ]);
  return {
    artifacts: artifacts.results,
    entries: entries.results,
    projects: projects.results,
    projectReferences: projectReferences.results,
    versions: versions.results,
  };
}

async function readStateDigest(database: D1Database) {
  const tables = await Promise.all(stateQueries.map(async ({name, sql}) => {
    const result = await database.prepare(sql).all();
    return {name, rows: result.results};
  }));
  return {
    digest: sha256(JSON.stringify(tables)),
    tableRows: Object.fromEntries(
      tables.map(({name, rows}) => [name, rows.length]),
    ),
  };
}

async function copyInstallationObjects(environment: RecoveryEnvironment) {
  const source = requireBinding(environment.SOURCE_R2);
  const target = requireBinding(environment.TARGET_R2);
  const targetContents = await recoveryOperation(
    "inspect_restore_target",
    () => target.list({limit: 1}),
  );
  if (targetContents.objects.length !== 0) {
    throw new RecoveryOperationError("restore_target_not_empty");
  }
  const prefix = installationPrefix(
    environment.ARTIFACT_SERVER_INSTALLATION_ID,
  );
  const sourceObjects = await recoveryOperation(
    "list_source_objects",
    () => listObjects(source, prefix),
  );
  const allSourceObjects = await recoveryOperation(
    "validate_source_scope",
    () => listObjects(source),
  );
  if (sourceObjects.length !== allSourceObjects.length) {
    throw new RecoveryOperationError("source_scope_mismatch");
  }
  if (sourceObjects.length === 0) {
    throw new RecoveryOperationError("source_objects_empty");
  }
  await recoveryOperation("copy_source_objects", () =>
    forEachObjectBatch(sourceObjects, async ({key}) => {
      const object = await source.get(key);
      if (object === null) throw new Error("Source R2 object disappeared.");
      const putOptions: R2PutOptions = {};
      if (object.customMetadata !== undefined) {
        putOptions.customMetadata = object.customMetadata;
      }
      if (object.httpMetadata !== undefined) {
        putOptions.httpMetadata = object.httpMetadata;
      }
      const fixedLength = new FixedLengthStream(object.size);
      await Promise.all([
        target.put(key, fixedLength.readable, putOptions),
        object.body.pipeTo(fixedLength.writable),
      ]);
    }));
  const targetObjects = await recoveryOperation(
    "list_restored_objects",
    () => listObjects(target, prefix),
  );
  if (targetObjects.length !== sourceObjects.length) {
    throw new RecoveryOperationError("restored_object_count_mismatch");
  }
  await recoveryOperation("verify_restored_objects", () =>
    forEachObjectBatch(sourceObjects, async (sourceSummary) => {
      const [sourceObject, targetObject] = await Promise.all([
        source.get(sourceSummary.key),
        target.get(sourceSummary.key),
      ]);
      if (sourceObject === null || targetObject === null) {
        throw new Error("R2 comparison could not open an object.");
      }
      const [sourceDigest, targetDigest] = await Promise.all([
        hashBody(sourceObject.body),
        hashBody(targetObject.body),
      ]);
      if (sourceDigest !== targetDigest) {
        throw new Error("Restored R2 bytes differ from source.");
      }
      if (
        canonicalMetadata(sourceObject.customMetadata) !==
          canonicalMetadata(targetObject.customMetadata)
      ) {
        throw new Error("Restored R2 custom metadata differs from source.");
      }
      if (
        canonicalMetadata(sourceObject.httpMetadata) !==
          canonicalMetadata(targetObject.httpMetadata)
      ) {
        throw new Error("Restored R2 HTTP metadata differs from source.");
      }
    }));
  return {
    byteExact: targetObjects.length,
    copied: targetObjects.length,
    customMetadataExact: targetObjects.length,
    httpMetadataExact: targetObjects.length,
  };
}

async function recoveryOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch {
    throw new RecoveryOperationError(operation);
  }
}

async function listObjects(bucket: R2Bucket, prefix?: string) {
  const objects = await listObjectPage(bucket, prefix);
  return objects.toSorted((left, right) => left.key.localeCompare(right.key));
}

async function listObjectPage(
  bucket: R2Bucket,
  prefix?: string,
  cursor?: string,
): Promise<R2Object[]> {
  const options: R2ListOptions = {limit: 1000};
  if (cursor !== undefined) options.cursor = cursor;
  if (prefix !== undefined) options.prefix = prefix;
  const page = await bucket.list(options);
  if (!page.truncated) return page.objects;
  return [
    ...page.objects,
    ...await listObjectPage(bucket, prefix, page.cursor),
  ];
}

async function inspectR2Inventory(bucket: R2Bucket, prefix: string) {
  const objects = await listObjects(bucket, prefix);
  const allObjects = await listObjects(bucket);
  if (objects.length !== allObjects.length) {
    throw new Error("R2 bucket contains data outside the installation.");
  }
  const inventory = await mapObjectBatches(objects, async (object) => {
    const body = await bucket.get(object.key);
    if (body === null) throw new Error("R2 inventory object disappeared.");
    return {
      bodySha256: await hashBody(body.body),
      customMetadata: canonicalMetadata(body.customMetadata),
      httpMetadata: canonicalMetadata(body.httpMetadata),
      key: object.key,
      size: object.size,
    };
  });
  return {count: objects.length, digest: sha256(JSON.stringify(inventory))};
}

async function hashBody(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const fingerprint = createHash("sha256");
  await body.pipeTo(new WritableStream<Uint8Array>({
    write(chunk) {
      fingerprint.update(chunk);
    },
  }));
  return fingerprint.digest("hex");
}

function canonicalMetadata(value: ObjectMetadata | undefined): string {
  if (value === undefined) return "{}";
  return JSON.stringify(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function installationPrefix(installationId: string): string {
  return `installations/${sha256(installationId)}/`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireBinding<T>(binding: T | undefined): T {
  if (binding === undefined) throw new Error("Recovery binding is missing.");
  return binding;
}

async function forEachObjectBatch(
  objects: readonly R2Object[],
  operation: AsyncObjectOperation,
  offset = 0,
): Promise<void> {
  const nextOffset = offset + 2;
  await Promise.all(objects.slice(offset, nextOffset).map(operation));
  if (nextOffset < objects.length) {
    await forEachObjectBatch(objects, operation, nextOffset);
  }
}

async function mapObjectBatches<T>(
  objects: readonly R2Object[],
  operation: (object: R2Object) => Promise<T>,
  offset = 0,
): Promise<T[]> {
  const nextOffset = offset + 2;
  const current = await Promise.all(
    objects.slice(offset, nextOffset).map(operation),
  );
  if (nextOffset >= objects.length) return current;
  return [
    ...current,
    ...await mapObjectBatches(objects, operation, nextOffset),
  ];
}
