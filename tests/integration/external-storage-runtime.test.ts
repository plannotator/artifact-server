import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {request} from "node:http";
import path from "node:path";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterAll, afterEach, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import {startExternalStorageServer} from "../../src/external-storage/start-external-storage-server.js";
import {checkExternalStorageIntegrity} from
  "../../src/lifecycle/integrity-check.js";
import {createS3ObjectStorageProviderFactory} from
  "../../src/storage/s3-object-storage.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {requiredPostgresSchemaVersion} from
  "../../src/storage/postgres-migrations.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {defaultProjectId} from "../../src/core/model.js";
import type {NodeGitHistoryConfiguration} from
  "../../src/git-history/node-git-history-configuration.js";
import type {GitHistoryProviderHealthProbe} from
  "../../src/git-history/git-history-provider-health.js";
import {managedApiKeyCredentialPattern} from
  "../../src/core/installation-identity.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const externalStorageCli = path.join(repositoryRoot, "dist/cli/main.js");
const region = "us-east-1";
const bucket = "artifact-server-external-storage-integration";
const installationId = "external-storage-integration-installation";
const apiToken = managedTestKey("external-storage-integration");
const oidcAdministratorEmail = "administrator@example.test";
let oidcProvider: RunningStubOidcProvider;
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const runningInProcessServers = new Set<InProcessExternalStorageServer>();
const availableGitHistoryProbe: GitHistoryProviderHealthProbe = {
  check: () => Effect.succeed({state: "available"}),
};

const publishResponseSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    name: z.string(),
    projectId: z.string(),
  }),
  links: z.object({artifact: z.url(), version: z.url()}),
  replayed: z.boolean(),
  version: z.object({
    id: z.string(),
    number: z.number().int().positive(),
    projectId: z.string(),
  }),
});

const projectGitHistoryEstimateResponseSchema = z.object({
  estimate: z.object({
    estimatedCopiedBytes: z.number().int().nonnegative(),
    estimatedPointerBytes: z.number().int().nonnegative(),
    notice: z.string(),
    operations: z.number().int().nonnegative(),
    projectId: z.string(),
    repositories: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const projectGitHistoryResponseSchema = z.object({
  gitHistory: z.object({
    enabled: z.boolean(),
    projectId: z.string(),
    state: z.enum([
      "backfilling",
      "budget-limited",
      "degraded",
      "disabled",
      "ready",
      "waiting",
    ]),
  }).strict(),
}).strict();

const taggedFailureSchema = z.object({_tag: z.string()}).loose();

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});

const issuedKeySchema = z.object({
  apiKey: z.object({
    authorizedByPrincipalId: z.string(),
    id: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
    rotatedFromId: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});

const uploadResponseSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })),
  projectId: z.string(),
  uploadId: z.string(),
});

const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({
      currentVersionId: z.string(),
      id: z.string(),
      name: z.string(),
      projectId: z.string(),
    }),
    commentCount: z.number().int().nonnegative(),
  })),
});

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});

const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).loose();

const commentCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();

const commentThreadEnvelopeSchema = z.object({thread: commentThreadSchema})
  .strict();

const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  threadId: z.string(),
}).loose();

const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
}).strict();

const commentPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();

const commentDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
}).strict();

const commentActionPageSchema = z.object({
  actions: z.array(z.object({action: z.string()}).loose()),
}).loose();

const commentFailureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

interface IntegrationEnvironment {
  readonly accessKey: string;
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly postgresContainer: string;
  readonly postgresUser: string;
  readonly secretKey: string;
}

interface BackedUpObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>> | undefined;
}

interface ExternalStorageProcess {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

interface InProcessExternalStorageServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

describe.sequential("external-storage Postgres and S3 runtime", () => {
  let environment: IntegrationEnvironment;
  let s3Client: S3Client;

  beforeAll(async () => {
    environment = readIntegrationEnvironment();
    oidcProvider = await startStubOidcProvider({
      clientId: "external-storage-integration",
    });
    s3Client = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: environment.secretKey,
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
  });

  afterEach(async () => {
    await Promise.all([
      ...[...runningProcesses].map(stopChild),
      ...[...runningInProcessServers].map((server) => server.stop()),
    ]);
  });

  test("external-storage foundation: migration status is read-only and serving begins only after explicit apply", async () => {
    const migrationEnvironment = {
      ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: installationId,
    };
    const before = await runExternalCli(["migrate", "status"], migrationEnvironment);
    expect(before.exitCode).toBe(0);
    expect(JSON.parse(before.output)).toMatchObject({
      compatibility: "missing",
      currentVersion: 0,
      requiredVersion: requiredPostgresSchemaVersion,
    });

    const applied = await runExternalCli(["migrate", "apply"], migrationEnvironment);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
      requiredVersion: requiredPostgresSchemaVersion,
    });

    const after = await runExternalCli(["migrate", "status"], migrationEnvironment);
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.output)).toEqual(JSON.parse(applied.output));

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-divergent-migration-test",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl, {label: "test-database-url"}),
    });
    try {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE artifact_server_postgres_migrations
          SET name = 'divergent_test_history'
          WHERE migration_id = 1
        `;
      }));
      const divergent = await runExternalCli(
        ["migrate", "apply"],
        migrationEnvironment,
      );
      expect(divergent.exitCode).not.toBe(0);
      expect(divergent.output).toContain("divergent");
      expect(divergent.output).not.toContain(environment.databaseUrl);
    } finally {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE artifact_server_postgres_migrations
          SET name = 'initial_shared_schema'
          WHERE migration_id = 1
        `;
      }));
      await database.close();
    }
  });

  test("GIT-010 GIT-013 foundation: Postgres enables Git history and preserves provider identity", async () => {
    const identity = {
      apiToken: managedTestKey("postgres-git-history"),
      installationId: "postgres-git-history",
    };
    const originalGitHistory = configuredGitHistory("postgres-history-one");
    let server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {
        gitHistory: originalGitHistory,
        gitHistoryHealthProbe: availableGitHistoryProbe,
      },
    );
    await expect.poll(
      () => readGitHistoryProviderState(server.baseUrl, identity.apiToken),
      {timeout: 5_000},
    ).toBe("available");
    const content = "Postgres Git history estimate";
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content,
      idempotencyKey: "postgres-git-history-publish",
      name: "Postgres Git history",
    });
    expect(published.response.status).toBe(201);
    const estimateResponse = await fetch(
      `${server.baseUrl}/api/v1/projects/${defaultProjectId}/git-history/estimate`,
      {
        headers: mutationHeaders(identity.apiToken, "postgres-git-history-estimate"),
        method: "POST",
      },
    );
    expect(estimateResponse.status).toBe(200);
    const estimate = projectGitHistoryEstimateResponseSchema.parse(
      await estimateResponse.json(),
    );
    expect(estimate.estimate).toMatchObject({
      estimatedCopiedBytes: Buffer.byteLength(content),
      estimatedPointerBytes: 0,
      operations: 2,
      projectId: defaultProjectId,
      repositories: 1,
      versions: 1,
    });
    const enableResponse = await fetch(
      `${server.baseUrl}/api/v1/projects/${defaultProjectId}/git-history`,
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: mutationHeaders(identity.apiToken, "postgres-git-history-enable"),
        method: "PUT",
      },
    );
    expect(enableResponse.status).toBe(200);
    expect(projectGitHistoryResponseSchema.parse(await enableResponse.json())).toEqual({
      gitHistory: {
        enabled: true,
        projectId: defaultProjectId,
        state: "waiting",
      },
    });
    await server.stop();

    server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {
        gitHistory: configuredGitHistory("postgres-history-two"),
        gitHistoryHealthProbe: availableGitHistoryProbe,
      },
    );
    await expect.poll(
      () => readGitHistoryProviderState(server.baseUrl, identity.apiToken),
      {timeout: 5_000},
    ).toBe("migration-required");
    const settingResponse = await authenticatedFetch(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/projects/${defaultProjectId}/git-history`,
    );
    expect(settingResponse.status).toBe(200);
    expect(projectGitHistoryResponseSchema.parse(await settingResponse.json())).toEqual({
      gitHistory: {
        enabled: true,
        projectId: defaultProjectId,
        state: "degraded",
      },
    });

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-git-history-identity-test",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl),
    });
    try {
      const rows = await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql<{
          readonly account_id: string;
          readonly namespace: string;
          readonly provider: string;
        }>`
          SELECT provider, account_id, namespace
          FROM git_history_provider_identity
          WHERE installation_id = ${identity.installationId}
        `.withoutTransform;
      }));
      expect(rows).toEqual([{
        account_id: "postgres-account",
        namespace: "postgres-history-one",
        provider: "cloudflare-artifacts",
      }]);
      const settings = await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql<{
          readonly enabled: boolean;
          readonly project_id: string;
        }>`
          SELECT project_id, enabled
          FROM git_history_project_settings
          WHERE installation_id = ${identity.installationId}
        `.withoutTransform;
      }));
      expect(settings).toEqual([{
        enabled: true,
        project_id: defaultProjectId,
      }]);
    } finally {
      await database.close();
    }
  });

  test("a populated Postgres v1 installation migrates without changing identity or bytes", async () => {
    const databaseName = `artifactserver_project_migration_${randomUUID().replaceAll("-", "")}`;
    await createPostgresDatabase(environment, databaseName);
    const migrationEnvironment = {
      ...environment,
      databaseUrl: databaseUrlFor(environment.databaseUrl, databaseName),
    };
    const identity = {
      apiToken: managedTestKey("postgres-project-migration"),
      installationId: "postgres-project-migration-installation",
    };
    const applied = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(applied.exitCode).toBe(0);

    const source = await startExternalStorageProcess(migrationEnvironment, identity);
    const published = await publishNew(source.baseUrl, identity.apiToken, {
      content: "<!doctype html><title>Postgres project migration</title>",
      idempotencyKey: "postgres-project-migration-publish",
      name: "Postgres project migration",
    });
    await source.stop();

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-project-migration-fixture",
      maxConnections: 1,
      url: Redacted.make(migrationEnvironment.databaseUrl),
    });
    try {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const statements = [
          `ALTER TABLE actions
            DROP CONSTRAINT actions_action_check,
            ADD CONSTRAINT actions_action_check
              CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
          `ALTER TABLE idempotency_records
            DROP CONSTRAINT idempotency_records_operation_check,
            ADD CONSTRAINT idempotency_records_operation_check
              CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
          `ALTER TABLE versions
            DROP CONSTRAINT versions_routing_mode_check,
            ADD CONSTRAINT versions_routing_mode_check
              CHECK (routing_mode = 'static')`,
          `ALTER TABLE staged_uploads
            DROP CONSTRAINT staged_uploads_routing_mode_check,
            ADD CONSTRAINT staged_uploads_routing_mode_check
              CHECK (routing_mode = 'static')`,
          "ALTER TABLE content_sessions DROP COLUMN project_id CASCADE",
          "ALTER TABLE content_bootstraps DROP COLUMN project_id CASCADE",
          "ALTER TABLE staged_uploads DROP COLUMN project_id CASCADE",
          "ALTER TABLE actions DROP COLUMN project_id CASCADE",
          "ALTER TABLE idempotency_records DROP COLUMN project_id CASCADE",
          "ALTER TABLE versions DROP COLUMN project_id CASCADE",
          "ALTER TABLE artifacts DROP COLUMN search_name",
          "ALTER TABLE artifacts DROP COLUMN project_id CASCADE",
          "ALTER TABLE login_attempts DROP COLUMN nonce",
          "DROP TABLE comment_replies",
          "DROP TABLE comment_threads",
          "DROP TABLE agent_dispatches",
          "DROP TABLE registered_agents",
          "DROP TABLE git_history_budget_reservations",
          "DROP TABLE git_history_mappings",
          "DROP TABLE git_history_jobs",
          "DROP TABLE git_history_repositories",
          "DROP TABLE git_history_provider_identity",
          "DROP TABLE git_history_project_settings",
          "DROP TABLE projects",
          `ALTER TABLE artifacts ADD CONSTRAINT artifacts_current_version_fk
            FOREIGN KEY (installation_id, current_version_id)
            REFERENCES versions(installation_id, id)
            DEFERRABLE INITIALLY DEFERRED`,
          "ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (installation_id, idempotency_key)",
          "ALTER TABLE actions ADD CONSTRAINT actions_installation_id_idempotency_key_key UNIQUE (installation_id, idempotency_key)",
          "CREATE INDEX versions_artifact_id ON versions (installation_id, artifact_id, number)",
          "CREATE INDEX artifacts_active_created ON artifacts (installation_id, deleted_at, created_at DESC, id DESC)",
          "CREATE INDEX actions_artifact_created ON actions (installation_id, artifact_id, created_at DESC, id DESC)",
          "DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 2",
        ] as const;
        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }
      }));
    } finally {
      await database.close();
    }

    const pending = await runExternalCli(["migrate", "status"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(JSON.parse(pending.output)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
      requiredVersion: requiredPostgresSchemaVersion,
    });
    const migrated = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(migrated.exitCode).toBe(0);
    expect(JSON.parse(migrated.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
    });

    const restored = await startExternalStorageProcess(migrationEnvironment, identity);
    const detailsResponse = await authenticatedFetch(
      restored.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${published.body.artifact.id}`,
    );
    expect(detailsResponse.status).toBe(200);
    const details = z.object({
      artifact: z.object({
        id: z.string(),
        projectId: z.string(),
        tags: z.array(z.string()),
      }),
      current: z.object({
        links: z.object({version: z.url()}),
        manifest: z.object({digest: z.string()}),
        version: z.object({id: z.string(), projectId: z.string()}),
      }),
    }).parse(await detailsResponse.json());
    expect(details).toMatchObject({
      artifact: {
        id: published.body.artifact.id,
        projectId: defaultProjectId,
        tags: ["external-storage-runtime"],
      },
      current: {
        version: {
          id: published.body.version.id,
          projectId: defaultProjectId,
        },
      },
    });
    const rendered = await fetchContentThroughServer(
      restored.baseUrl,
      details.current.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(
      "<!doctype html><title>Postgres project migration</title>",
    );
    await restored.stop();

    const repeated = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
    });
  });

  test("Postgres project scope survives restart", async () => {
    const identity = {
      apiToken: managedTestKey("postgres-project"),
      installationId: "postgres-project-scope",
    };
    let server = await startInProcessExternalStorageServer(environment, identity);
    const createdResponse = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Postgres project"}),
      headers: mutationHeaders(identity.apiToken, `project-${randomUUID()}`),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = z.object({
      project: z.object({id: z.string(), name: z.string()}),
    }).parse(await createdResponse.json()).project;

    const sharedKey = `project-local-idempotency-${randomUUID()}`;
    const [defaultArtifact, projectArtifact] = await Promise.all([
      publishNew(server.baseUrl, identity.apiToken, {
        content: "default Postgres project",
        idempotencyKey: sharedKey,
        name: "Default Postgres artifact",
        projectId: defaultProjectId,
      }),
      publishNew(server.baseUrl, identity.apiToken, {
        content: "named Postgres project",
        idempotencyKey: sharedKey,
        name: "Named Postgres artifact",
        projectId: created.id,
      }),
    ]);
    expect(defaultArtifact.response.status).toBe(201);
    expect(projectArtifact.response.status).toBe(201);
    expect(defaultArtifact.body.artifact.projectId).toBe(defaultProjectId);
    expect(projectArtifact.body.artifact.projectId).toBe(created.id);

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-project-fk-proof",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl),
    });
    try {
      await expect(database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(sql`
          UPDATE artifacts
          SET current_version_id = ${projectArtifact.body.version.id}
          WHERE installation_id = ${identity.installationId}
            AND project_id = ${defaultProjectId}
            AND id = ${defaultArtifact.body.artifact.id}
        `);
      }))).rejects.toBeDefined();
    } finally {
      await database.close();
    }

    await server.stop();
    server = await startInProcessExternalStorageServer(environment, identity);
    const namedList = await fetch(
      `${server.baseUrl}/api/v1/artifacts?projectId=${created.id}`,
      {headers: bearerHeaders(identity.apiToken)},
    );
    expect(namedList.status).toBe(200);
    expect(artifactListSchema.parse(await namedList.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: projectArtifact.body.artifact.id}),
      })]);

    const crossProjectRead = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${defaultProjectId}`,
      {headers: bearerHeaders(identity.apiToken)},
    );
    expect(crossProjectRead.status).toBe(404);

    const archive = await fetch(
      `${server.baseUrl}/api/v1/projects/${created.id}/archive`,
      {headers: bearerHeaders(identity.apiToken), method: "POST"},
    );
    expect(archive.status).toBe(200);
    const archivedWrite = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        projectId: created.id,
      }),
      headers: mutationHeaders(identity.apiToken, `archived-${randomUUID()}`),
      method: "POST",
    });
    expect(archivedWrite.status).toBe(409);
    await expect(archivedWrite.json()).resolves.toMatchObject({
      error: {code: "PROJECT_ARCHIVED"},
    });
    expect((await fetch(
      `${server.baseUrl}/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${created.id}`,
      {headers: bearerHeaders(identity.apiToken)},
    )).status).toBe(200);
  });

  afterAll(async () => {
    s3Client.destroy();
    await oidcProvider.stop();
  });

  test("PUB-011-B PUB-011-F: independent external-storage processes accept uploaded bytes, reject remote sources, serialize writes, restart, and isolate installations", async () => {
    expect.hasAssertions();
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, {apiToken, installationId}),
      startExternalStorageProcess(environment, {apiToken, installationId}),
    ]);

    const remoteSource = await fetch(`${first.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        sourceUrl: "http://169.254.169.254/latest/meta-data/",
      }),
      headers: new Headers({
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      }),
      method: "POST",
    });
    expect(remoteSource.status).toBe(422);

    const initial = await publishNew(first.baseUrl, apiToken, {
      content: "<h1>external-storage version one</h1>",
      idempotencyKey: `external-storage-create-${randomUUID()}`,
      name: "External-storage process proof",
    });
    expect(initial.response.status).toBe(201);

    const listedBySecond = await listArtifacts(second.baseUrl, apiToken);
    expect(listedBySecond.response.status).toBe(200);
    expect(listedBySecond.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: initial.body.version.id,
          id: initial.body.artifact.id,
          name: "External-storage process proof",
        }),
      }),
    ]);

    const raceKey = randomUUID();
    const races = await Promise.all([
      publishVersion(first.baseUrl, apiToken, {
        artifactId: initial.body.artifact.id,
        content: "<h1>writer A</h1>",
        expectedCurrentVersionId: initial.body.version.id,
        idempotencyKey: `race-a-${raceKey}`,
      }),
      publishVersion(second.baseUrl, apiToken, {
        artifactId: initial.body.artifact.id,
        content: "<h1>writer B</h1>",
        expectedCurrentVersionId: initial.body.version.id,
        idempotencyKey: `race-b-${raceKey}`,
      }),
    ]);
    expect(
      races.map(({response}) => response.status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);
    const winner = races.find(({response}) => response.status === 201);
    if (winner === undefined) throw new Error("The publish race had no winner.");
    const winnerBody = publishResponseSchema.parse(winner.body);

    await Promise.all([first.stop(), second.stop()]);
    const restarted = await startExternalStorageProcess(environment, {apiToken, installationId});
    const afterRestart = await listArtifacts(restarted.baseUrl, apiToken);
    expect(afterRestart.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: winnerBody.version.id,
          id: initial.body.artifact.id,
        }),
      }),
    ]);

    const isolatedApiToken = managedTestKey("isolated-installation");
    const isolated = await startExternalStorageProcess(environment, {
      apiToken: isolatedApiToken,
      installationId: "isolated-external-storage-installation",
    });
    const isolatedList = await listArtifacts(
      isolated.baseUrl,
      isolatedApiToken,
    );
    expect(isolatedList.response.status).toBe(200);
    expect(isolatedList.body.artifacts).toEqual([]);
    const guessed = await fetch(
      `${isolated.baseUrl}/api/v1/artifacts/${initial.body.artifact.id}`,
      {
        headers: {
          Authorization: `Bearer ${isolatedApiToken}`,
        },
      },
    );
    expect(guessed.status).toBe(404);
  });

  test("foundation: independent external-storage processes expose the same stateless MCP installation", async () => {
    expect.hasAssertions();
    const identity = {
      apiToken: managedTestKey("external-storage-mcp"),
      installationId: `external-storage-mcp-${randomUUID()}`,
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, identity),
      startExternalStorageProcess(environment, identity),
    ]);
    const published = await publishNew(first.baseUrl, identity.apiToken, {
      content: "<main>external-storage MCP visibility</main>",
      idempotencyKey: `external-storage-mcp-create-${randomUUID()}`,
      name: "External-storage MCP proof",
    });
    expect(published.response.status).toBe(201);

    const discovery = await externalStorageMcpRequest(
      second.baseUrl,
      identity.apiToken,
      "server/discover",
      {},
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.has("mcp-session-id")).toBe(false);
    await expect(discovery.json()).resolves.toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
      },
    });

    const listed = await externalStorageMcpRequest(
      second.baseUrl,
      identity.apiToken,
      "tools/call",
      {
        arguments: {cursor: null, limit: 10, tag: null},
        name: "artifact_list",
      },
      "artifact_list",
    );
    expect(listed.status).toBe(200);
    const listResult = z.object({
      result: z.object({
        isError: z.boolean().optional(),
        resultType: z.literal("complete"),
        structuredContent: z.object({
          artifacts: z.array(z.object({id: z.string()}).loose()),
        }),
      }).loose(),
    }).loose().parse(await listed.json()).result;
    expect(listResult.isError).not.toBe(true);
    expect(listResult.structuredContent.artifacts).toContainEqual(
      expect.objectContaining({id: published.body.artifact.id}),
    );
  });

  test("external-storage foundation: a scoped identity adapter rejects a caller-selected installation", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = new PostgresIdentityRepository(
        database,
        "trusted-identity-installation",
      );
      await expect(repository.hasMembers("foreign-identity-installation"))
        .rejects.toMatchObject({_tag: "IdentityNotFound"});
      await expect(repository.hasMembers("trusted-identity-installation"))
        .resolves.toBe(false);
    } finally {
      await database.close();
    }
  });

  test("external-storage foundation: a login attempt keeps its nonce through Postgres", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    const scopedInstallation = `login-attempt-nonce-${randomUUID()}`;
    try {
      await PostgresArtifactRepository.open(database, scopedInstallation);
      const repository = new PostgresIdentityRepository(
        database,
        scopedInstallation,
      );
      await repository.createLoginAttempt({
        codeVerifier: "postgres-login-attempt-code-verifier",
        createdAt: "2026-08-18T12:00:00.000Z",
        expiresAt: "2126-08-18T12:00:00.000Z",
        nonce: "postgres-login-attempt-nonce",
        provider: "oidc",
        returnTo: "/",
        stateDigest: "postgres-login-attempt-oidc-state",
      });
      await repository.createLoginAttempt({
        codeVerifier: "postgres-login-attempt-code-verifier-two",
        createdAt: "2026-08-18T12:00:00.000Z",
        expiresAt: "2126-08-18T12:00:00.000Z",
        nonce: null,
        provider: "workos",
        returnTo: "/",
        stateDigest: "postgres-login-attempt-workos-state",
      });
      const oidcAttempt = await repository.consumeLoginAttempt(
        "postgres-login-attempt-oidc-state",
        "oidc",
        "2026-08-18T12:00:05.000Z",
      );
      expect(oidcAttempt).toMatchObject({
        codeVerifier: "postgres-login-attempt-code-verifier",
        nonce: "postgres-login-attempt-nonce",
        provider: "oidc",
      });
      const workOsAttempt = await repository.consumeLoginAttempt(
        "postgres-login-attempt-workos-state",
        "workos",
        "2026-08-18T12:00:05.000Z",
      );
      expect(workOsAttempt.nonce).toBeNull();
      await expect(repository.consumeLoginAttempt(
        "postgres-login-attempt-oidc-state",
        "oidc",
        "2026-08-18T12:00:06.000Z",
      )).rejects.toMatchObject({_tag: "LoginAttemptRejected"});
    } finally {
      await database.close();
    }
  });

  test("external-storage foundation: concurrent replicas cannot deactivate the last two administrators", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    const scopedInstallation = `administrator-race-${randomUUID()}`;
    try {
      await PostgresArtifactRepository.open(database, scopedInstallation);
      const repository = new PostgresIdentityRepository(
        database,
        scopedInstallation,
      );
      const createdAt = "2026-08-13T15:00:00.000Z";
      await Promise.all([
        repository.admitMember({
          createdAt,
          displayName: "Administrator A",
          email: "administrator-a@example.test",
          id: "administrator-a",
          installationId: scopedInstallation,
          role: "administrator",
        }),
        repository.admitMember({
          createdAt,
          displayName: "Administrator B",
          email: "administrator-b@example.test",
          id: "administrator-b",
          installationId: scopedInstallation,
          role: "administrator",
        }),
      ]);
      const results = await Promise.allSettled([
        repository.deactivateMember(
          scopedInstallation,
          "administrator-a",
          "2026-08-13T15:01:00.000Z",
        ),
        repository.deactivateMember(
          scopedInstallation,
          "administrator-b",
          "2026-08-13T15:01:00.000Z",
        ),
      ]);
      expect(results.map(({status}) => status).toSorted((left, right) =>
        left.localeCompare(right)
      )).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find(({status}) => status === "rejected");
      if (rejected?.status !== "rejected") {
        throw new Error("The administrator race did not reject one mutation.");
      }
      expect(rejected.reason).toMatchObject({_tag: "IdentityConflict"});
      const members = await repository.listMembers(scopedInstallation);
      expect(members.filter((member) =>
        member.role === "administrator" && member.status === "active"
      )).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  test("AUTH-009-B AUTH-009-F: sessions, managed keys, and staged uploads cross process boundaries", async () => {
    expect.hasAssertions();
    const externalStorageIdentity = {
      apiToken: managedTestKey("identity-runtime"),
      installationId: "external-storage-identity-installation",
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, externalStorageIdentity),
      startInProcessExternalStorageServer(environment, externalStorageIdentity),
    ]);

    const login = await oidcBrowserLogin(first.baseUrl);
    expect(login.status).toBe(303);
    const cookies = applicationCookies(login.headers.getSetCookie());

    const session = await fetch(`${second.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(session.status).toBe(200);
    sessionResponseSchema.parse(await session.json());

    const memberResponse = await fetch(`${second.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "External-storage team member",
        email: "external-storage-member@example.test",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(memberResponse.status).toBe(201);
    const member = z.object({member: z.object({id: z.string()})}).parse(
      await memberResponse.json(),
    ).member;
    const duplicateMember = await fetch(`${second.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Duplicate team member",
        email: "EXTERNAL-STORAGE-MEMBER@example.test",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(duplicateMember.status).toBe(409);
    const memberList = await fetch(`${second.baseUrl}/api/v1/members`, {
      headers: {Cookie: cookies.header},
    });
    expect(memberList.status).toBe(200);
    expect(z.object({members: z.array(z.object({id: z.string()}))})
      .parse(await memberList.json()).members).toHaveLength(2);

    const issueResponse = await fetch(`${second.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Cross-process reader",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(issueResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issueResponse.json());
    const keyList = await fetch(`${second.baseUrl}/api/v1/api-keys`, {
      headers: {Cookie: cookies.header},
    });
    expect(keyList.status).toBe(200);
    const listedKeys = z.object({apiKeys: z.array(z.object({
      id: z.string(),
      name: z.string(),
    }))}).parse(await keyList.json()).apiKeys;
    expect(listedKeys).toHaveLength(2);
    expect(listedKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({id: issued.apiKey.id}),
      expect.objectContaining({name: "Installation bootstrap key"}),
    ]));
    expect(await bearerStatus(first.baseUrl, issued.token)).toBe(200);

    const rotateResponse = await fetch(
      `${second.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(rotateResponse.status).toBe(201);
    const rotated = issuedKeySchema.parse(await rotateResponse.json());
    expect(rotated.apiKey).toMatchObject({
      authorizedByPrincipalId: issued.apiKey.authorizedByPrincipalId,
      principalId: issued.apiKey.principalId,
      principalKind: issued.apiKey.principalKind,
      rotatedFromId: issued.apiKey.id,
    });
    expect(await bearerStatus(second.baseUrl, issued.token)).toBe(401);
    expect(await bearerStatus(second.baseUrl, rotated.token)).toBe(200);

    const revokeResponse = await fetch(
      `${second.baseUrl}/api/v1/api-keys/${rotated.apiKey.id}/revoke`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await bearerStatus(first.baseUrl, rotated.token)).toBe(401);

    const deactivateMember = await fetch(
      `${second.baseUrl}/api/v1/members/${member.id}/deactivate`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(deactivateMember.status).toBe(200);

    const fileBytes = new TextEncoder().encode(
      "<main>cross-process staged content</main>",
    );
    const createUpload = await fetch(`${first.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(fileBytes).digest("hex"),
          size: fileBytes.byteLength,
        }],
      }),
      headers: {
        Authorization: `Bearer ${externalStorageIdentity.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(createUpload.status).toBe(201);
    const upload = uploadResponseSchema.parse(await createUpload.json());
    const plannedFile = upload.files[0];
    if (plannedFile === undefined) throw new Error("The staged upload has no file.");

    const uploadToSecond = replaceOrigin(plannedFile.uploadUrl, second.baseUrl);
    const uploaded = await fetch(uploadToSecond, {
      body: copiedArrayBuffer(fileBytes),
      headers: {Authorization: `Bearer ${externalStorageIdentity.apiToken}`},
      method: "PUT",
    });
    expect(uploaded.status).toBe(200);

    const commit = await fetch(replaceOrigin(upload.commitUrl, second.baseUrl), {
      body: JSON.stringify({
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Cross-process staged site",
          tags: ["staged", "external-storage"],
        },
      }),
      headers: mutationHeaders(
        externalStorageIdentity.apiToken,
        `staged-commit-${randomUUID()}`,
      ),
      method: "POST",
    });
    expect(commit.status).toBe(201);
    const committed = publishResponseSchema.parse(await commit.json());
    const rendered = await fetchContentThroughServer(
      first.baseUrl,
      committed.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(new TextDecoder().decode(fileBytes));

    const logout = await fetch(`${second.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect((await fetch(`${first.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(401);
  });

  test("external-storage preview lease foundation: Postgres serves management, history, comparison, idempotency, and private content", async () => {
    expect.hasAssertions();
    const repositoryIdentity = {
      apiToken: managedTestKey("repository-runtime"),
      installationId: "postgres-repository-surface",
    };
    let server = await startInProcessExternalStorageServer(environment, repositoryIdentity);
    const first = await publishNew(server.baseUrl, repositoryIdentity.apiToken, {
      content: "<p>repository version one</p>",
      idempotencyKey: `surface-create-${randomUUID()}`,
      name: "Repository surface",
    });
    const versionKey = `surface-version-${randomUUID()}`;
    const second = await publishVersion(
      server.baseUrl,
      repositoryIdentity.apiToken,
      {
        artifactId: first.body.artifact.id,
        content: "<p>repository version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: versionKey,
      },
    );
    expect(second.response.status).toBe(201);
    const secondBody = publishResponseSchema.parse(second.body);
    const replay = await publishVersion(
      server.baseUrl,
      repositoryIdentity.apiToken,
      {
        artifactId: first.body.artifact.id,
        content: "<p>repository version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: versionKey,
      },
    );
    expect(replay.response.status).toBe(200);
    expect(publishResponseSchema.parse(replay.body)).toMatchObject({
      replayed: true,
      version: {id: secondBody.version.id},
    });

    const tagChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/tags`,
      "PATCH",
      `surface-tags-${randomUUID()}`,
      {
        expectedCurrentVersionId: secondBody.version.id,
        tags: ["POSTGRES", "review"],
      },
    );
    expect(tagChange.status).toBe(200);

    const staleAccessChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/access`,
      "PATCH",
      `surface-stale-access-${randomUUID()}`,
      {
        accessSetting: "account_required",
        expectedCurrentVersionId: first.body.version.id,
      },
    );
    expect(staleAccessChange.status).toBe(409);
    expect(await staleAccessChange.json()).toEqual({
      error: {
        code: "ARTIFACT_MUTATION_CONFLICT",
        message: `The artifact moved to version ${secondBody.version.id}.`,
      },
    });

    const filtered = await fetch(
      `${server.baseUrl}/api/v1/artifacts?tag=postgres`,
      {headers: bearerHeaders(repositoryIdentity.apiToken)},
    );
    expect(filtered.status).toBe(200);
    expect(artifactListSchema.parse(await filtered.json()).artifacts).toHaveLength(1);

    const accessChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/access`,
      "PATCH",
      `surface-access-${randomUUID()}`,
      {
        accessSetting: "account_required",
        expectedCurrentVersionId: secondBody.version.id,
      },
    );
    expect(accessChange.status).toBe(200);
    expect((await fetchContentThroughServer(
      server.baseUrl,
      secondBody.links.version,
    )).status).toBe(401);

    const bootstrapResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/content-sessions`,
      {
        headers: bearerHeaders(repositoryIdentity.apiToken),
        method: "POST",
      },
    );
    expect(bootstrapResponse.status).toBe(201);
    const bootstrap = z.object({bootstrapUrl: z.url()}).parse(
      await bootstrapResponse.json(),
    );
    const previewLeaseResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}/preview-leases?projectId=${defaultProjectId}`,
      {
        headers: bearerHeaders(repositoryIdentity.apiToken),
        method: "POST",
      },
    );
    expect(previewLeaseResponse.status).toBe(201);
    const previewLease = z.object({
      baseUrl: z.url(),
      versionId: z.literal(first.body.version.id),
    }).parse(await previewLeaseResponse.json());
    await server.stop();
    server = await startInProcessExternalStorageServer(environment, repositoryIdentity);
    const exchange = await fetchContentThroughServer(
      server.baseUrl,
      bootstrap.bootstrapUrl,
    );
    expect(exchange.status).toBe(200);
    expect(await exchange.clone().text()).toContain('content="0;url=/"');
    const contentCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (contentCookie === undefined) {
      throw new Error("The private-content exchange did not issue a cookie.");
    }
    const privateContent = await fetchContentThroughServer(
      server.baseUrl,
      secondBody.links.version,
      {Cookie: contentCookie},
    );
    expect(privateContent.status).toBe(200);
    expect(await privateContent.text()).toBe("<p>repository version two</p>");

    const historicalPreview = await fetchContentThroughServer(
      server.baseUrl,
      new URL("index.html", previewLease.baseUrl).toString(),
    );
    expect(historicalPreview.status).toBe(200);
    expect(historicalPreview.headers.get("access-control-allow-origin")).toBe("*");
    expect(historicalPreview.headers.get("cross-origin-resource-policy"))
      .toBe("cross-origin");
    expect(await historicalPreview.text()).toBe("<p>repository version one</p>");
    const forgedPreviewUrl = new URL("index.html", previewLease.baseUrl);
    const [leaseLabel, ...contentDomainLabels] = forgedPreviewUrl.hostname.split(".");
    if (leaseLabel === undefined) throw new Error("Preview lease hostname has no label.");
    forgedPreviewUrl.hostname = `${leaseLabel.slice(0, -1)}${
      leaseLabel.endsWith("a") ? "b" : "a"
    }.${contentDomainLabels.join(".")}`;
    expect((await fetchContentThroughServer(
      server.baseUrl,
      forgedPreviewUrl.toString(),
    )).status).toBe(401);

    const versions = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/versions`,
    );
    expect(versions.status).toBe(200);
    const versionIds = z.object({
      versions: z.array(z.object({version: z.object({id: z.string()})})),
    }).parse(await versions.json()).versions.map(({version}) => version.id);
    expect(versionIds).toEqual([secondBody.version.id, first.body.version.id]);

    const comparison = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/comparisons?${
        new URLSearchParams({
          fromVersionId: first.body.version.id,
          toVersionId: secondBody.version.id,
        })
      }`,
    );
    expect(comparison.status).toBe(200);
    expect(await comparison.json()).toMatchObject({
      from: {
        artifactId: first.body.artifact.id,
        id: first.body.version.id,
      },
      to: {
        artifactId: first.body.artifact.id,
        id: secondBody.version.id,
      },
    });

    const actions = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/actions`,
    );
    expect(actions.status).toBe(200);
    expect(z.object({actions: z.array(z.object({action: z.string()}))})
      .parse(await actions.json()).actions.map(({action}) => action)).toEqual([
        "change_access",
        "change_tags",
        "publish",
        "publish",
      ]);

    const restoreKey = `surface-restore-${randomUUID()}`;
    const restored = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/restore`,
      "POST",
      restoreKey,
      {
        expectedCurrentVersionId: secondBody.version.id,
        versionId: first.body.version.id,
      },
    );
    expect(restored.status).toBe(200);
    expect(publishResponseSchema.parse(await restored.json())).toMatchObject({
      artifact: {currentVersionId: first.body.version.id},
      replayed: false,
    });
    const restoredReplay = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/restore`,
      "POST",
      restoreKey,
      {
        expectedCurrentVersionId: secondBody.version.id,
        versionId: first.body.version.id,
      },
    );
    expect(publishResponseSchema.parse(await restoredReplay.json()).replayed)
      .toBe(true);

    const deleted = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}`,
      "DELETE",
      `surface-delete-${randomUUID()}`,
      {expectedCurrentVersionId: first.body.version.id},
    );
    expect(deleted.status).toBe(200);
    expect((await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).status).toBe(404);
  });

  test("external-storage foundation: integrity scans committed Postgres records and S3 bytes without repair", async () => {
    const identity = {
      apiToken: managedTestKey("integrity-runtime"),
      installationId: `external-integrity-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content: "external integrity proof",
      idempotencyKey: `external-integrity-${randomUUID()}`,
      name: "External integrity proof",
      routingMode: "spa",
    });
    expect(published.response.status).toBe(201);
    await server.stop();

    const configuration = {
      databaseUrl: Redacted.make(environment.databaseUrl),
      installationId: identity.installationId,
      objectStorage: createS3ObjectStorageProviderFactory({
        accessKeyId: environment.accessKey,
        bucket,
        endpoint: environment.endpoint,
        forcePathStyle: true,
        region,
        secretAccessKey: Redacted.make(environment.secretKey),
      }),
    };
    const healthy = await checkExternalStorageIntegrity(configuration);
    expect(healthy).toMatchObject({
      artifactsChecked: 1,
      blobsChecked: 1,
      problems: [],
      status: "healthy",
      versionsChecked: 1,
    });

    const namespace = createHash("sha256")
      .update(identity.installationId)
      .digest("hex");
    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `installations/${namespace}/blobs/`,
    }));
    const key = listed.Contents?.[0]?.Key;
    if (key === undefined) throw new Error("The integrity fixture blob was not stored.");
    await s3Client.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));

    const corrupt = await checkExternalStorageIntegrity(configuration);
    expect(corrupt).toMatchObject({
      problems: [{code: "blob_missing"}],
      status: "corrupt",
    });
  });

  test("external-storage foundation: logical Postgres and object backups restore stable IDs and bytes", async () => {
    expect.hasAssertions();
    const backupIdentity = {
      apiToken: managedTestKey("backup-runtime"),
      installationId: "backup-restore-installation",
    };
    const source = await startExternalStorageProcess(environment, backupIdentity);
    const projectResponse = await fetch(`${source.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Backup project"}),
      headers: mutationHeaders(
        backupIdentity.apiToken,
        `backup-project-${randomUUID()}`,
      ),
      method: "POST",
    });
    expect(projectResponse.status).toBe(201);
    const backupProject = z.object({
      project: z.object({
        archivedAt: z.string().nullable(),
        id: z.string(),
        name: z.string(),
      }),
    }).parse(await projectResponse.json()).project;
    const published = await publishNew(source.baseUrl, backupIdentity.apiToken, {
      content: "<article>logical backup survives</article>",
      idempotencyKey: `backup-create-${randomUUID()}`,
      name: "Backup proof",
      projectId: backupProject.id,
    });
    expect(published.response.status).toBe(201);
    const login = await oidcBrowserLogin(source.baseUrl);
    expect(login.status).toBe(303);
    const cookies = applicationCookies(login.headers.getSetCookie());
    const issueResponse = await fetch(`${source.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Restored reader",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(issueResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issueResponse.json());
    const actionPath =
      `/api/v1/artifacts/${published.body.artifact.id}/actions?projectId=${backupProject.id}`;
    const sourceActions = z.object({
      actions: z.array(z.object({
        action: z.string(),
        artifactId: z.string(),
        id: z.string(),
        versionId: z.string(),
      })),
    }).parse(await (await authenticatedFetch(
      source.baseUrl,
      backupIdentity.apiToken,
      actionPath,
    )).json()).actions;
    const archivedProjectResponse = await fetch(
      `${source.baseUrl}/api/v1/projects/${backupProject.id}/archive`,
      {headers: bearerHeaders(backupIdentity.apiToken), method: "POST"},
    );
    expect(archivedProjectResponse.status).toBe(200);
    const archivedProject = z.object({
      project: z.object({archivedAt: z.string(), id: z.string()}),
    }).parse(await archivedProjectResponse.json()).project;
    await source.stop();

    const [databaseDump, objectBackup] = await Promise.all([
      dumpPostgres(environment),
      backupBucket(s3Client, bucket),
    ]);
    expect(databaseDump.byteLength).toBeGreaterThan(0);
    expect(objectBackup.length).toBeGreaterThan(0);

    const restoreDatabase = `artifactserver_restore_${randomUUID().replaceAll("-", "")}`;
    const restoreBucket = `artifact-server-restore-${randomUUID()}`;
    await Promise.all([
      restorePostgres(environment, restoreDatabase, databaseDump),
      restoreBucketObjects(s3Client, restoreBucket, objectBackup),
    ]);

    const restoredEnvironment = {
      ...environment,
      databaseUrl: databaseUrlFor(environment.databaseUrl, restoreDatabase),
    };
    const restored = await startExternalStorageProcess(restoredEnvironment, {
      ...backupIdentity,
      storageBucket: restoreBucket,
    });
    const restoredProjectResponse = await authenticatedFetch(
      restored.baseUrl,
      backupIdentity.apiToken,
      `/api/v1/projects/${backupProject.id}`,
    );
    expect(restoredProjectResponse.status).toBe(200);
    await expect(restoredProjectResponse.json()).resolves.toMatchObject({
      project: {
        archivedAt: archivedProject.archivedAt,
        id: backupProject.id,
        name: "Backup project",
      },
    });
    const listed = await listArtifacts(
      restored.baseUrl,
      backupIdentity.apiToken,
      backupProject.id,
    );
    expect(listed.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: published.body.version.id,
          id: published.body.artifact.id,
          name: "Backup proof",
          projectId: backupProject.id,
        }),
      }),
    ]);
    expect(await bearerStatus(restored.baseUrl, issued.token)).toBe(200);
    expect((await fetch(`${restored.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(200);
    const restoredActions = z.object({
      actions: z.array(z.object({
        action: z.string(),
        artifactId: z.string(),
        id: z.string(),
        versionId: z.string(),
      })),
    }).parse(await (await authenticatedFetch(
      restored.baseUrl,
      backupIdentity.apiToken,
      actionPath,
    )).json()).actions;
    expect(restoredActions).toEqual(sourceActions);
    const rendered = await fetchContentThroughServer(
      restored.baseUrl,
      published.body.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe("<article>logical backup survives</article>");
  });

  test("external-storage foundation: invalid database and object-store credentials fail before readiness", async () => {
    expect.hasAssertions();
    const invalidStorage = {
      ...environment,
      secretKey: "wrong-object-store-secret",
    };
    await expect(startExternalStorageProcess(invalidStorage, {
      apiToken: managedTestKey("invalid-storage"),
      installationId: "invalid-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const databaseUrl = new URL(environment.databaseUrl);
    databaseUrl.password = "wrong-postgres-password";
    const invalidDatabase = {...environment, databaseUrl: databaseUrl.toString()};
    await expect(startExternalStorageProcess(invalidDatabase, {
      apiToken: managedTestKey("invalid-database"),
      installationId: "invalid-database-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const unavailableStorage = {
      ...environment,
      endpoint: "http://127.0.0.1:1",
    };
    await expect(startExternalStorageProcess(unavailableStorage, {
      apiToken: managedTestKey("unavailable-storage"),
      installationId: "unavailable-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);
  });

  test("OPS-001-B OPS-001-F: health and dependency readiness are separate and fail closed", async () => {
    expect.hasAssertions();
    const readinessBucket = `artifact-server-readiness-${randomUUID()}`;
    await s3Client.send(new CreateBucketCommand({Bucket: readinessBucket}));
    const server = await startExternalStorageProcess(environment, {
      apiToken: managedTestKey("readiness-runtime"),
      installationId: `readiness-${randomUUID()}`,
      storageBucket: readinessBucket,
    });

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({status: "ok"});

    const ready = await fetch(`${server.baseUrl}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      components: {
        configuration: {latencyMilliseconds: 0, status: "ready"},
        database: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        migrations: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        objectStorage: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
      },
      lifecycle: "ready",
      status: "ready",
    });

    await s3Client.send(new DeleteBucketCommand({Bucket: readinessBucket}));
    const unavailable = await fetch(`${server.baseUrl}/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      components: {
        configuration: {latencyMilliseconds: 0, status: "ready"},
        database: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        migrations: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        objectStorage: {
          latencyMilliseconds: expect.any(Number),
          status: "unavailable",
        },
      },
      lifecycle: "ready",
      status: "not_ready",
    });

    const stillAlive = await fetch(`${server.baseUrl}/health`);
    expect(stillAlive.status).toBe(200);
  });

  test("external-storage foundation: Postgres serves the comment lifecycle, paging, and same-instant ledger keys", async () => {
    expect.hasAssertions();
    const commentIdentity = {
      apiToken: managedTestKey("postgres-comment"),
      installationId: `postgres-comments-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      commentIdentity,
    );
    const first = await publishNew(server.baseUrl, commentIdentity.apiToken, {
      content: "<p>comment target version one</p>",
      idempotencyKey: `comment-publish-${randomUUID()}`,
      name: "Comment target",
    });
    const artifactId = first.body.artifact.id;
    const second = await publishVersion(
      server.baseUrl,
      commentIdentity.apiToken,
      {
        artifactId,
        content: "<p>comment target version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: `comment-publish-second-${randomUUID()}`,
      },
    );
    expect(second.response.status).toBe(201);
    const secondVersionId = publishResponseSchema.parse(second.body).version.id;

    const threadKey = `comment-thread-${randomUUID()}`;
    const created = await createCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      {artifactId, versionId: first.body.version.id},
      threadKey,
      {body: "The axis label is wrong.", path: "index.html"},
    );
    expect(created.response.status).toBe(201);
    const thread = commentCreationSchema.parse(created.body);
    expect(thread.replayed).toBe(false);
    expect(thread.thread.versionId).toBe(first.body.version.id);
    expect(thread.thread.versionId).not.toBe(secondVersionId);
    expect(thread.thread.replyCount).toBe(0);
    expect(thread.thread.author.displayName).toBe("Installation bootstrap key");

    const replayedCreate = await createCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      {artifactId, versionId: first.body.version.id},
      threadKey,
      {body: "The axis label is wrong.", path: "index.html"},
    );
    expect(replayedCreate.response.status).toBe(201);
    const replayedThread = commentCreationSchema.parse(replayedCreate.body);
    expect(replayedThread.replayed).toBe(true);
    expect(replayedThread.thread.id).toBe(thread.thread.id);
    expect(replayedThread.thread.createdAt).toBe(thread.thread.createdAt);

    const replyKey = `comment-reply-${randomUUID()}`;
    const reply = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      replyKey,
      "Corrected in the next publish.",
    );
    expect(reply.response.status).toBe(201);
    const replyBody = replyCreationSchema.parse(reply.body);
    expect(replyBody.replayed).toBe(false);
    const replayedReply = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      replyKey,
      "Corrected in the next publish.",
    );
    expect(replyCreationSchema.parse(replayedReply.body)).toMatchObject({
      replayed: true,
      reply: {id: replyBody.reply.id},
    });

    const resolved = await patchCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      {state: "resolved"},
    );
    expect(resolved.status).toBe(200);
    expect(commentThreadEnvelopeSchema.parse(await resolved.json()).thread)
      .toMatchObject({
        replyCount: 1,
        resolvedBy: {
          displayName: "Installation bootstrap key",
          principalKind: "service",
        },
        state: "resolved",
      });

    const refused = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      `comment-reply-refused-${randomUUID()}`,
      "Too late to answer.",
    );
    expect(refused.response.status).toBe(409);
    expect(commentFailureSchema.parse(refused.body).error.code)
      .toBe("COMMENT_RESOLVED");

    const reopened = await patchCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      {state: "open"},
    );
    expect(reopened.status).toBe(200);
    expect(commentThreadEnvelopeSchema.parse(await reopened.json()).thread)
      .toMatchObject({resolvedAt: null, resolvedBy: null, state: "open"});
    const acceptedAfterReopen = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      `comment-reply-after-reopen-${randomUUID()}`,
      "Reopened because the fix regressed.",
    );
    expect(acceptedAfterReopen.response.status).toBe(201);

    const extraThreads = await Promise.all([1, 2].map((index) =>
      createCommentThread(
        server.baseUrl,
        commentIdentity.apiToken,
        {artifactId, versionId: secondVersionId},
        `comment-thread-page-${index}-${randomUUID()}`,
        {body: `Paged observation ${index}.`, path: "index.html"},
      )
    ));
    expect(extraThreads.map(({response}) => response.status)).toEqual([201, 201]);
    const laterThreadIds = extraThreads.map(({body}) =>
      commentCreationSchema.parse(body).thread.id
    );

    const firstPage = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?limit=2`,
    )).json());
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?limit=2&cursor=${
        encodeURIComponent(firstPage.nextCursor ?? "")
      }`,
    )).json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map(({id}) => id)
      .toSorted()).toEqual([thread.thread.id, ...laterThreadIds].toSorted());
    const listedArtifact = await listArtifacts(server.baseUrl, commentIdentity.apiToken);
    expect(listedArtifact.body.artifacts).toEqual([
      expect.objectContaining({commentCount: 3}),
    ]);

    const versionFiltered = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?versionId=${first.body.version.id}`,
    )).json());
    expect(versionFiltered.items.map(({id}) => id)).toEqual([thread.thread.id]);

    // Two mutations on one thread can land in the same millisecond. The derived
    // ledger key must stay unique, or the Postgres uniqueness constraint on
    // (installation_id, project_id, idempotency_key) rejects the second write.
    const commentPrincipal = managedTestPrincipal(commentIdentity.apiToken);
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        commentIdentity.installationId,
      );
      const sameInstant = "2026-08-18T09:15:00.000Z";
      const sameInstantEdit = (body: string) => repository.updateThread({
        anchor: null,
        artifactId,
        authorizedByPrincipalId: commentPrincipal.authorizedByPrincipalId,
        body,
        principalId: commentPrincipal.principalId,
        projectId: thread.thread.projectId,
        state: null,
        threadId: thread.thread.id,
        updatedAt: sameInstant,
      });
      await sameInstantEdit("Same-instant edit one.");
      await sameInstantEdit("Same-instant edit two.");
    } finally {
      await database.close();
    }

    const ledger = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/actions`,
    );
    expect(ledger.status).toBe(200);
    const recorded = commentActionPageSchema.parse(await ledger.json()).actions
      .filter(({action}) => action.startsWith("comment_"))
      .map(({action}) => action);
    expect(recorded.toSorted()).toEqual([
      "comment_create",
      "comment_create",
      "comment_create",
      "comment_reopen",
      "comment_reply",
      "comment_reply",
      "comment_resolve",
      "comment_update",
      "comment_update",
    ]);

    const detail = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
    );
    expect(detail.status).toBe(200);
    expect(commentDetailsSchema.parse(await detail.json())).toMatchObject({
      thread: {body: "Same-instant edit two.", replyCount: 2},
    });

    const removed = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
      {headers: bearerHeaders(commentIdentity.apiToken), method: "DELETE"},
    );
    expect(removed.status).toBe(204);
    expect((await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
    )).status).toBe(404);
    await server.stop();
  });

  test("external-storage foundation: Postgres serves the dispatch mailbox, lease reclaim, and consumptive comment listings", async () => {
    expect.hasAssertions();
    const dispatchIdentity = {
      apiToken: managedTestKey("postgres-dispatch"),
      installationId: `postgres-dispatch-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      dispatchIdentity,
    );
    const published = await publishNew(
      server.baseUrl,
      dispatchIdentity.apiToken,
      {
        content: "<p>dispatch target</p>",
        idempotencyKey: `dispatch-publish-${randomUUID()}`,
        name: "Dispatch target",
      },
    );
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;
    const annotate = async (body: string): Promise<string> => {
      const created = await createCommentThread(
        server.baseUrl,
        dispatchIdentity.apiToken,
        {artifactId, versionId},
        `dispatch-thread-${randomUUID()}`,
        {body, path: "index.html"},
      );
      expect(created.response.status).toBe(201);
      return commentCreationSchema.parse(created.body).thread.id;
    };
    const listDefaultCommentIds = async (): Promise<readonly string[]> => {
      const listed = await authenticatedFetch(
        server.baseUrl,
        dispatchIdentity.apiToken,
        `/api/v1/artifacts/${artifactId}/comments`,
      );
      expect(listed.status).toBe(200);
      return commentPageSchema.parse(await listed.json()).items
        .map(({id}) => id);
    };
    const [firstThreadId, secondThreadId, thirdThreadId] = [
      await annotate("The axis label is wrong."),
      await annotate("The legend overlaps the chart."),
      await annotate("The footer year is stale."),
    ];
    expect((await listDefaultCommentIds()).toSorted()).toEqual(
      [firstThreadId, secondThreadId, thirdThreadId].toSorted(),
    );

    const baseInstant = Date.now();
    const at = (offsetMilliseconds: number): string =>
      new Date(baseInstant + offsetMilliseconds).toISOString();
    const sender = managedTestPrincipal(dispatchIdentity.apiToken);
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        dispatchIdentity.installationId,
      );
      const connectionKey = `dispatch-connection-${randomUUID()}`;
      const registration = {
        agentSessionId: "pi-session-one",
        capabilities: {beacon: false, evidence: "native"},
        connectionKey,
        displayName: "site",
        installationId: dispatchIdentity.installationId,
        kind: "pi",
        principalId: sender.principalId,
        workingDirectory: "/work/site",
      } as const;
      const agent = await repository.registerAgent({
        ...registration,
        id: `agt_${randomUUID()}`,
        registeredAt: at(0),
      });
      // The connection key is the identity: a restarted session upserts back
      // into the same row, so dispatches queued for it survive.
      const reregistered = await repository.registerAgent({
        ...registration,
        agentSessionId: "pi-session-two",
        displayName: "site (resumed)",
        id: `agt_${randomUUID()}`,
        registeredAt: at(500),
      });
      expect(reregistered).toMatchObject({
        agentSessionId: "pi-session-two",
        createdAt: at(0),
        displayName: "site (resumed)",
        id: agent.id,
        lastSeenAt: at(500),
      });

      const sendKey = `dispatch-send-${randomUUID()}`;
      const sent = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_000),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: sendKey,
        installationId: dispatchIdentity.installationId,
        note: "Fix both before the review.",
        projectId: defaultProjectId,
        sender,
        threadIds: [firstThreadId, secondThreadId],
      });
      expect(sent.replayed).toBe(false);
      expect(sent.dispatch).toMatchObject({
        agentId: agent.id,
        state: "queued",
        threadIds: [firstThreadId, secondThreadId],
      });
      const replayedSend = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_100),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: sendKey,
        installationId: dispatchIdentity.installationId,
        note: "Fix both before the review.",
        projectId: defaultProjectId,
        sender,
        threadIds: [firstThreadId, secondThreadId],
      });
      expect(replayedSend).toMatchObject({
        dispatch: {createdAt: at(1_000), id: sent.dispatch.id},
        replayed: true,
      });

      // Sending is consumptive: the annotations leave the default listing and
      // stay reachable only through the dispatched filter.
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);
      const listThreads = (dispatched: "exclude" | "include" | "only") =>
        repository.listThreads({
          artifactId,
          cursor: null,
          dispatched,
          limit: 20,
          projectId: defaultProjectId,
          since: null,
          state: null,
          versionId: null,
        });
      expect((await listThreads("only")).items.map(({id}) => id).toSorted())
        .toEqual([firstThreadId, secondThreadId].toSorted());
      expect((await listThreads("include")).items).toHaveLength(3);

      await expect(repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_200),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-send-${randomUUID()}`,
        installationId: dispatchIdentity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [secondThreadId, thirdThreadId],
      })).rejects.toMatchObject({_tag: "InvalidDispatch"});
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);

      const claimed = await repository.claimNextDispatch(agent.id, at(2_000), true);
      expect(claimed).toMatchObject({
        claimedAt: at(2_000),
        id: sent.dispatch.id,
        state: "claimed",
      });
      // One active claim per agent: the next poll waits for the report.
      expect(await repository.claimNextDispatch(agent.id, at(2_500), true)).toBeNull();
      // A held poll's re-check attempt answers the same way as a pure read.
      expect(await repository.claimNextDispatch(agent.id, at(2_600), false)).toBeNull();
      await expect(repository.markDelivered({
        agentId: `agt_${randomUUID()}`,
        deliveredAt: at(3_000),
        dispatchId: sent.dispatch.id,
        installationId: dispatchIdentity.installationId,
      })).rejects.toMatchObject({_tag: "DispatchStateConflict"});
      const delivered = await repository.markDelivered({
        agentId: agent.id,
        deliveredAt: at(3_000),
        dispatchId: sent.dispatch.id,
        installationId: dispatchIdentity.installationId,
      });
      expect(delivered).toMatchObject({
        deliveredAt: at(3_000),
        state: "delivered",
      });

      const resolve = async (threadId: string): Promise<void> => {
        const resolved = await patchCommentThread(
          server.baseUrl,
          dispatchIdentity.apiToken,
          artifactId,
          threadId,
          {state: "resolved"},
        );
        expect(resolved.status).toBe(200);
      };
      await resolve(firstThreadId);
      // Addressed is inferred from thread resolution, so a partly answered
      // bundle stays delivered.
      expect(await repository.findDispatch(
        dispatchIdentity.installationId,
        sent.dispatch.id,
        at(3_500),
      )).toMatchObject({addressedAt: null, state: "delivered"});
      await resolve(secondThreadId);
      expect(await repository.observeAddressed(sent.dispatch.id, at(4_000)))
        .toMatchObject({addressedAt: at(4_000), state: "addressed"});

      const second = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(5_000),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-send-${randomUUID()}`,
        installationId: dispatchIdentity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [thirdThreadId],
      });
      expect(await listDefaultCommentIds()).toEqual([]);
      expect(await repository.claimNextDispatch(agent.id, at(6_000), true))
        .toMatchObject({id: second.dispatch.id, state: "claimed"});
      // A claimer that never reports loses its lease, and the same dispatch
      // returns to the queue for the next poll — even for a heartbeat-free
      // re-check attempt, which opens the write path once a lease expires.
      const reclaimed = await repository.claimNextDispatch(
        agent.id,
        at(600_000),
        false,
      );
      expect(reclaimed).toMatchObject({
        claimedAt: at(600_000),
        id: second.dispatch.id,
        state: "claimed",
      });

      const canceled = await repository.cancelDispatch({
        canceledAt: at(660_000),
        dispatchId: second.dispatch.id,
        installationId: dispatchIdentity.installationId,
        projectId: defaultProjectId,
      });
      expect(canceled).toMatchObject({
        canceledAt: at(660_000),
        state: "canceled",
      });
      // Cancellation clears the markers, so the annotation comes back.
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);
      await expect(repository.cancelDispatch({
        canceledAt: at(661_000),
        dispatchId: second.dispatch.id,
        installationId: dispatchIdentity.installationId,
        projectId: defaultProjectId,
      })).rejects.toMatchObject({_tag: "DispatchStateConflict"});

      // Agent rows are disposable liveness records; the dispatch history is
      // the durable record and keeps its own name snapshot.
      await repository.registerAgent({
        ...registration,
        connectionKey: `dispatch-connection-${randomUUID()}`,
        displayName: "abandoned",
        id: `agt_${randomUUID()}`,
        registeredAt: new Date(baseInstant - 8 * 24 * 60 * 60 * 1_000)
          .toISOString(),
      });
      expect((await repository.listAgents(
        dispatchIdentity.installationId,
        at(700_000),
      )).map(({agent: listed}) => listed.id)).toEqual([agent.id]);

      const firstPage = await repository.listDispatches({
        agentId: null,
        cursor: null,
        installationId: dispatchIdentity.installationId,
        limit: 1,
        now: at(700_000),
        projectId: defaultProjectId,
        state: null,
      });
      expect(firstPage.items.map(({id, state}) => ({id, state}))).toEqual([
        {id: second.dispatch.id, state: "canceled"},
      ]);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await repository.listDispatches({
        agentId: agent.id,
        cursor: firstPage.nextCursor,
        installationId: dispatchIdentity.installationId,
        limit: 1,
        now: at(700_000),
        projectId: defaultProjectId,
        state: null,
      });
      expect(secondPage.items.map(({agentDisplayName, id, state}) => ({
        agentDisplayName,
        id,
        state,
      }))).toEqual([{
        agentDisplayName: "site (resumed)",
        id: sent.dispatch.id,
        state: "addressed",
      }]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await database.close();
    }
    await server.stop();
  });

  test("external-storage foundation: Postgres protects dispatched comments atomically through every dispatch state", async () => {
    expect.hasAssertions();
    const identity = {
      apiToken: managedTestKey("postgres-dispatch-deletion"),
      installationId: `postgres-dispatch-deletion-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content: "<p>dispatch deletion target</p>",
      idempotencyKey: `dispatch-deletion-publish-${randomUUID()}`,
      name: "Dispatch deletion target",
    });
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;
    const sender = managedTestPrincipal(identity.apiToken);
    const baseInstant = Date.now();
    let clockOffset = 0;
    const now = (): string =>
      new Date(baseInstant + ++clockOffset * 1_000).toISOString();
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        identity.installationId,
      );
      const agent = await repository.registerAgent({
        agentSessionId: "pi-session-dispatch-deletion",
        capabilities: {beacon: false, evidence: "native"},
        connectionKey: `dispatch-deletion-${randomUUID()}`,
        displayName: "deletion worker",
        id: `agt_${randomUUID()}`,
        installationId: identity.installationId,
        kind: "pi",
        principalId: sender.principalId,
        registeredAt: now(),
        workingDirectory: "/work/deletion-worker",
      });
      const annotate = async (body: string): Promise<string> => {
        const created = await createCommentThread(
          server.baseUrl,
          identity.apiToken,
          {artifactId, versionId},
          `dispatch-deletion-thread-${randomUUID()}`,
          {body, path: "index.html"},
        );
        expect(created.response.status).toBe(201);
        return commentCreationSchema.parse(created.body).thread.id;
      };
      const remove = (threadId: string) => repository.deleteThread({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        deletedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        threadId,
      });
      const send = (threadId: string) => repository.createDispatch({
        agentDisplayName: agent.displayName,
        agentId: agent.id,
        createdAt: now(),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-deletion-send-${randomUUID()}`,
        installationId: identity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [threadId],
      });

      const canceledThread = await annotate("Cancel this work.");
      const canceledDispatch = await send(canceledThread);
      await expect(remove(canceledThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await repository.cancelDispatch({
        canceledAt: now(),
        dispatchId: canceledDispatch.dispatch.id,
        installationId: identity.installationId,
        projectId: defaultProjectId,
      });
      await expect(remove(canceledThread)).resolves.toMatchObject({
        thread: {id: canceledThread},
      });

      const failedThread = await annotate("Fail this work.");
      const failedDispatch = await send(failedThread);
      expect(await repository.claimNextDispatch(agent.id, now(), true))
        .toMatchObject({id: failedDispatch.dispatch.id, state: "claimed"});
      await expect(remove(failedThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await repository.markFailed({
        agentId: agent.id,
        dispatchId: failedDispatch.dispatch.id,
        failedAt: now(),
        installationId: identity.installationId,
        reason: "Test delivery failure",
      });
      await expect(remove(failedThread)).resolves.toMatchObject({
        thread: {id: failedThread},
      });

      const addressedThread = await annotate("Address this work.");
      const addressedDispatch = await send(addressedThread);
      expect(await repository.claimNextDispatch(agent.id, now(), true))
        .toMatchObject({id: addressedDispatch.dispatch.id, state: "claimed"});
      await repository.markDelivered({
        agentId: agent.id,
        deliveredAt: now(),
        dispatchId: addressedDispatch.dispatch.id,
        installationId: identity.installationId,
      });
      await expect(remove(addressedThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await expect(repository.clearThreads({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        clearedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        scope: "all",
        versionId: null,
      })).resolves.toEqual({deleted: 0, skippedDispatched: 1});
      expect((await patchCommentThread(
        server.baseUrl,
        identity.apiToken,
        artifactId,
        addressedThread,
        {state: "resolved"},
      )).status).toBe(200);
      expect(await repository.observeAddressed(
        addressedDispatch.dispatch.id,
        now(),
      )).toMatchObject({state: "addressed"});
      await expect(repository.clearThreads({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        clearedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        scope: "all",
        versionId: null,
      })).resolves.toEqual({deleted: 1, skippedDispatched: 0});

      const racedThread = await annotate("Race this work.");
      const [sent, deleted] = await Promise.allSettled([
        send(racedThread),
        remove(racedThread),
      ]);
      expect([sent.status, deleted.status].filter((status) =>
        status === "fulfilled"
      )).toHaveLength(1);
      const raceOutcome = sent.status === "fulfilled"
        ? {
          deletedTag: deleted.status === "rejected"
            ? taggedFailureSchema.parse(deleted.reason)._tag
            : "committed",
          dispatchedThreadIds: (await repository.findDispatch(
            identity.installationId,
            sent.value.dispatch.id,
            now(),
          ))?.threadIds,
          sentTag: "committed",
        }
        : {
          deletedTag: deleted.status === "fulfilled"
            ? "committed"
            : taggedFailureSchema.parse(deleted.reason)._tag,
          dispatchedThreadIds: [],
          sentTag: taggedFailureSchema.parse(sent.reason)._tag,
        };
      expect(raceOutcome).toEqual(sent.status === "fulfilled"
        ? {
          deletedTag: "DispatchStateConflict",
          dispatchedThreadIds: [racedThread],
          sentTag: "committed",
        }
        : {
          deletedTag: "committed",
          dispatchedThreadIds: [],
          sentTag: "InvalidDispatch",
        });
    } finally {
      await database.close();
      await server.stop();
    }
  });
});

function readIntegrationEnvironment(): IntegrationEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"];
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  const endpoint = process.env["ARTIFACT_SERVER_TEST_S3_ENDPOINT"];
  const postgresContainer =
    process.env["ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER"];
  const postgresUser = process.env["ARTIFACT_SERVER_TEST_POSTGRES_USER"];
  const secretKey = process.env["ARTIFACT_SERVER_TEST_S3_SECRET_KEY"];
  if (
    accessKey === undefined || databaseUrl === undefined ||
    endpoint === undefined || postgresContainer === undefined ||
    postgresUser === undefined || secretKey === undefined
  ) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return {
    accessKey,
    databaseUrl,
    endpoint,
    postgresContainer,
    postgresUser,
    secretKey,
  };
}

function managedTestKey(label: string): string {
  const id = createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update(`secret:${label}`).digest("base64url");
  return `as_key_key_${id}_${secret}`;
}

function managedTestPrincipal(token: string) {
  const keyId = managedApiKeyCredentialPattern.exec(token)?.[1];
  if (keyId === undefined) throw new Error("The test key is not a managed API key.");
  return {
    authorizedByPrincipalId: "installation-bootstrap",
    displayName: "Installation bootstrap key",
    principalId: `service:${keyId}`,
    principalKind: "service",
  } as const;
}

function startExternalStorageProcess(
  environment: IntegrationEnvironment,
  identity: {
    readonly apiToken: string;
    readonly installationId: string;
    readonly storageBucket?: string;
  },
): Promise<ExternalStorageProcess> {
  const child = spawn(
    process.execPath,
    [externalStorageCli, "start-external-storage", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_API_TOKEN: identity.apiToken,
        ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: oidcAdministratorEmail,
        ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
        ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
        ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
        ARTIFACT_SERVER_OIDC_CLIENT_ID: "external-storage-integration",
        ARTIFACT_SERVER_OIDC_ISSUER: oidcProvider.issuer,
        ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
        ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
        ARTIFACT_SERVER_S3_ACCESS_KEY_ID: environment.accessKey,
        ARTIFACT_SERVER_S3_BUCKET: identity.storageBucket ?? bucket,
        ARTIFACT_SERVER_S3_ENDPOINT: environment.endpoint,
        ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
        ARTIFACT_SERVER_S3_REGION: region,
        ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: environment.secretKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  runningProcesses.add(child);
  return waitForExternalStorageProcess(child);
}

function runExternalCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{readonly exitCode: number; readonly output: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [externalStorageCli, ...arguments_], {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? -1,
      output: Buffer.concat(output).toString("utf8").trim(),
    }));
  });
}

async function startInProcessExternalStorageServer(
  environment: IntegrationEnvironment,
  identity: {readonly apiToken: string; readonly installationId: string},
  options: {
    readonly gitHistory?: NodeGitHistoryConfiguration;
    readonly gitHistoryHealthProbe?: GitHistoryProviderHealthProbe;
  } = {},
): Promise<InProcessExternalStorageServer> {
  const server = await startExternalStorageServer({
    apiToken: Redacted.make(identity.apiToken),
    applicationOrigin: "https://artifacts.example.com",
    bootstrapAdministratorEmail: oidcAdministratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    contentDomain: "content.example.net",
    databaseUrl: Redacted.make(environment.databaseUrl),
    hostname: "127.0.0.1",
    installationId: identity.installationId,
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin: "https://artifacts.example.com",
      clientId: "external-storage-integration",
      clientSecret: null,
      issuer: oidcProvider.issuer,
      scopes: "openid email profile",
    }),
    objectStorage: createS3ObjectStorageProviderFactory({
      accessKeyId: environment.accessKey,
      bucket,
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(environment.secretKey),
    }),
    port: 0,
    ...options,
  });
  let stopped = false;
  const running: InProcessExternalStorageServer = {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      runningInProcessServers.delete(running);
      await server.close();
    },
  };
  runningInProcessServers.add(running);
  return running;
}

function configuredGitHistory(namespace: string): NodeGitHistoryConfiguration {
  return {
    _tag: "CloudflareArtifactsRest",
    apiToken: Redacted.make("postgres-cloudflare-artifacts-token"),
    capability: {
      limits: {
        fileCopyBytes: 10 * 1024 * 1024,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: null,
        versionCopyBytes: 50 * 1024 * 1024,
      },
      provider: "cloudflare-artifacts",
      providerState: "checking",
    },
    identity: {
      accountId: "postgres-account",
      namespace,
      provider: "cloudflare-artifacts",
    },
    issues: [],
  };
}

async function readGitHistoryProviderState(
  baseUrl: string,
  token: string,
): Promise<string> {
  const response = await fetch(new URL("/api/v1/session", baseUrl), {
    headers: {Authorization: `Bearer ${token}`},
  });
  return z.object({
    capabilities: z.object({
      gitHistory: z.object({providerState: z.string()}).loose(),
    }).loose(),
  }).loose().parse(await response.json()).capabilities.gitHistory.providerState;
}

function waitForExternalStorageProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<ExternalStorageProcess> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`External-storage process did not become ready: ${output}`));
    }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Artifact Server \(external-storage\): (http:\/\/127\.0\.0\.1:\d+)/u.exec(
        output,
      );
      if (match?.[1] === undefined) return;
      cleanup();
      const baseUrl = match[1];
      resolve({baseUrl, child, stop: () => stopChild(child)});
    };
    const exit = () => {
      cleanup();
      reject(new Error(`External-storage process exited before readiness: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function publishNew(
  baseUrl: string,
  token: string,
  input: {
    readonly content: string;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly projectId?: string;
    readonly routingMode?: "spa" | "static";
  },
) {
  const upload = await stageExternalStorageFile(
    baseUrl,
    token,
    input.content,
    input.projectId,
    input.routingMode,
  );
  const response = await fetch(upload.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: input.name,
      tags: ["external-storage-runtime"],
    }}),
    headers: mutationHeaders(token, input.idempotencyKey),
    method: "POST",
  });
  const body: unknown = await response.json();
  return {body: publishResponseSchema.parse(body), response};
}

async function publishVersion(
  baseUrl: string,
  token: string,
  input: {
    readonly artifactId: string;
    readonly content: string;
    readonly expectedCurrentVersionId: string;
    readonly idempotencyKey: string;
    readonly projectId?: string;
  },
) {
  const upload = await stageExternalStorageFile(
    baseUrl,
    token,
    input.content,
    input.projectId,
  );
  const response = await fetch(upload.commitUrl, {
      body: JSON.stringify({target: {
        artifactId: input.artifactId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        kind: "new_version",
      }}),
      headers: mutationHeaders(token, input.idempotencyKey),
      method: "POST",
  });
  const body: unknown = await response.json();
  return {body, response};
}

async function stageExternalStorageFile(
  baseUrl: string,
  token: string,
  content: string,
  projectId?: string,
  routingMode?: "spa" | "static",
): Promise<z.infer<typeof uploadResponseSchema>> {
  const bytes = new TextEncoder().encode(content);
  const files = [{
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  }];
  const body = {entryPath: "index.html", files, projectId, routingMode};
  const createUpload = await fetch(`${baseUrl}/api/v1/uploads`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const upload = uploadResponseSchema.parse(await createUpload.json());
  const plannedFile = upload.files[0];
  if (plannedFile === undefined) {
    throw new Error("The external-storage upload plan did not contain its declared file.");
  }
  const uploaded = await fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${token}`},
    method: "PUT",
  });
  if (!uploaded.ok) {
    throw new Error(`The external-storage staged upload failed with HTTP ${uploaded.status}.`);
  }
  return upload;
}

async function listArtifacts(
  baseUrl: string,
  token: string,
  projectId?: string,
) {
  const url = new URL("/api/v1/artifacts", baseUrl);
  if (projectId !== undefined) url.searchParams.set("projectId", projectId);
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${token}`},
  });
  const body: unknown = await response.json();
  return {body: artifactListSchema.parse(body), response};
}

function externalStorageMcpRequest(
  baseUrl: string,
  token: string,
  method: string,
  parameters: McpTestParameters,
  name?: string,
): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    Host: "artifacts.example.com",
    Origin: "https://artifacts.example.com",
  });
  if (name !== undefined) headers.set("Mcp-Name", name);
  const body = JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "external-storage-runtime-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    });
  return rawHttpRequest(new URL("/mcp", baseUrl), headers, "POST", body);
}

function rawHttpRequest(
  target: URL,
  headers: Headers,
  method: string,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: Object.fromEntries(headers),
      hostname: target.hostname,
      method,
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            responseHeaders.append(name, value);
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          headers: responseHeaders,
          status: incoming.statusCode ?? 500,
        }));
      });
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

interface McpTestParameters {
  readonly [key: string]: McpTestParameterValue;
}

type McpTestParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpTestParameterValue[]
  | McpTestParameters;

function mutationHeaders(token: string, idempotencyKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}

function bearerHeaders(token: string): Headers {
  return new Headers({Authorization: `Bearer ${token}`});
}

function authenticatedFetch(
  baseUrl: string,
  token: string,
  pathname: string,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {headers: bearerHeaders(token)});
}

async function createCommentThread(
  baseUrl: string,
  token: string,
  target: {readonly artifactId: string; readonly versionId: string},
  idempotencyKey: string,
  input: {readonly body: string; readonly path?: string},
): Promise<{readonly body: unknown; readonly response: Response}> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${target.artifactId}/versions/${target.versionId}/comments`,
    {
      body: JSON.stringify(input),
      headers: mutationHeaders(token, idempotencyKey),
      method: "POST",
    },
  );
  return {body: await response.json(), response};
}

async function createCommentReply(
  baseUrl: string,
  token: string,
  artifactId: string,
  threadId: string,
  idempotencyKey: string,
  body: string,
): Promise<{readonly body: unknown; readonly response: Response}> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}/replies`,
    {
      body: JSON.stringify({body}),
      headers: mutationHeaders(token, idempotencyKey),
      method: "POST",
    },
  );
  return {body: await response.json(), response};
}

function patchCommentThread(
  baseUrl: string,
  token: string,
  artifactId: string,
  threadId: string,
  changes: {readonly body?: string; readonly state?: "open" | "resolved"},
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}`,
    {
      body: JSON.stringify(changes),
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }),
      method: "PATCH",
    },
  );
}

type ArtifactMutationBody =
  | {readonly expectedCurrentVersionId: string}
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly expectedCurrentVersionId: string;
  }
  | {
    readonly expectedCurrentVersionId: string;
    readonly tags: readonly string[];
  }
  | {
    readonly expectedCurrentVersionId: string;
    readonly versionId: string;
  };

function mutateArtifact(
  baseUrl: string,
  token: string,
  pathname: string,
  method: "DELETE" | "PATCH" | "POST",
  idempotencyKey: string,
  body: ArtifactMutationBody,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: mutationHeaders(token, idempotencyKey),
    method,
  });
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

async function oidcBrowserLogin(baseUrl: string): Promise<Response> {
  const authorization = await startStubOidcLogin(baseUrl);
  const callback = new URL(baseUrl);
  callback.pathname = authorization.callbackUrl.pathname;
  callback.search = authorization.callbackUrl.search;
  return fetch(callback, {
    headers: {Cookie: authorization.handshakeCookie},
    redirect: "manual",
  });
}

function applicationCookies(
  setCookieHeaders: readonly string[],
): ApplicationCookies {
  const session = setCookieHeaders.find((value) =>
    value.startsWith("artifact_session=") ||
    value.startsWith("__Host-artifact_session=")
  );
  const csrf = setCookieHeaders.find((value) =>
    value.startsWith("artifact_csrf=") ||
    value.startsWith("__Host-artifact_csrf=")
  );
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response issued a malformed application cookie.");
  }
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

function bearerStatus(baseUrl: string, token: string): Promise<number> {
  return fetch(`${baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

function replaceOrigin(url: string, baseUrl: string): string {
  const target = new URL(url);
  const replacement = new URL(baseUrl);
  target.protocol = replacement.protocol;
  target.host = replacement.host;
  return target.toString();
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fetchContentThroughServer(
  baseUrl: string,
  contentUrl: string,
  headers?: HeadersInit,
): Promise<Response> {
  const server = new URL(baseUrl);
  const target = new URL(contentUrl);
  return new Promise((resolve, reject) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Host", target.host);
    const outgoing = request(
      {
        headers: Object.fromEntries(requestHeaders),
        hostname: server.hostname,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              responseHeaders.append(name, value);
            }
          }
          resolve(new Response(bytes, {
            headers: responseHeaders,
            status: incoming.statusCode ?? 500,
          }));
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function dumpPostgres(
  environment: IntegrationEnvironment,
): Promise<Buffer> {
  return runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "pg_dump",
    "--username",
    environment.postgresUser,
    "--dbname",
    new URL(environment.databaseUrl).pathname.slice(1),
    "--no-owner",
    "--no-privileges",
  ]);
}

async function restorePostgres(
  environment: IntegrationEnvironment,
  database: string,
  dump: Uint8Array,
): Promise<void> {
  await runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "createdb",
    "--username",
    environment.postgresUser,
    database,
  ]);
  await runCommand(
    "docker",
    [
      "exec",
      "--interactive",
      environment.postgresContainer,
      "psql",
      "--username",
      environment.postgresUser,
      "--dbname",
      database,
      "--set",
      "ON_ERROR_STOP=on",
    ],
    dump,
  );
}

async function createPostgresDatabase(
  environment: IntegrationEnvironment,
  database: string,
): Promise<void> {
  await runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "createdb",
    "--username",
    environment.postgresUser,
    database,
  ]);
}

function databaseUrlFor(databaseUrl: string, database: string): string {
  const target = new URL(databaseUrl);
  target.pathname = `/${database}`;
  return target.toString();
}

async function backupBucket(
  client: S3Client,
  sourceBucket: string,
  continuationToken?: string,
): Promise<readonly BackedUpObject[]> {
  const page = await client.send(new ListObjectsV2Command({
    Bucket: sourceBucket,
    ContinuationToken: continuationToken,
  }));
  const objects = await Promise.all((page.Contents ?? []).map(async ({Key}) => {
    if (Key === undefined) throw new Error("An object-store listing omitted its key.");
    const object = await client.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key,
    }));
    if (object.Body === undefined) {
      throw new Error(`The object-store backup could not read ${Key}.`);
    }
    return {
      bytes: await object.Body.transformToByteArray(),
      contentType: object.ContentType,
      key: Key,
      metadata: object.Metadata,
    };
  }));
  if (!page.IsTruncated || page.NextContinuationToken === undefined) {
    return objects;
  }
  const remaining = await backupBucket(
    client,
    sourceBucket,
    page.NextContinuationToken,
  );
  return [...objects, ...remaining];
}

async function restoreBucketObjects(
  client: S3Client,
  targetBucket: string,
  objects: readonly BackedUpObject[],
): Promise<void> {
  await client.send(new CreateBucketCommand({Bucket: targetBucket}));
  await Promise.all(objects.map((object) => {
    let input: PutObjectCommandInput = {
      Body: object.bytes,
      Bucket: targetBucket,
      Key: object.key,
    };
    if (object.contentType !== undefined) {
      input = {...input, ContentType: object.contentType};
    }
    if (object.metadata !== undefined) {
      input = {...input, Metadata: object.metadata};
    }
    return client.send(new PutObjectCommand(input));
  }));
}

function runCommand(
  command: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["pipe", "pipe", "pipe"]});
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(
        `${command} exited with ${exitCode ?? "no status"}: ${
          Buffer.concat(stderr).toString("utf8")
        }`,
      ));
    });
    child.stdin.end(input);
  });
}
