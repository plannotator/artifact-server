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
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {defaultProjectId} from "../../src/core/model.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const externalStorageCli = path.join(repositoryRoot, "dist/cli/main.js");
const region = "us-east-1";
const bucket = "artifact-server-external-storage-integration";
const installationId = "external-storage-integration-installation";
const apiToken = "external-storage-integration-api-token-with-sufficient-entropy";
const browserBootstrapToken =
  "external-storage-browser-bootstrap-token-with-sufficient-entropy";
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const runningInProcessServers = new Set<InProcessExternalStorageServer>();

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

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});

const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}),
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
  })),
});

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
      requiredVersion: 3,
    });

    const applied = await runExternalCli(["migrate", "apply"], migrationEnvironment);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.output)).toMatchObject({
      compatibility: "current",
      currentVersion: 3,
      requiredVersion: 3,
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

  test("a populated Postgres v1 installation migrates without changing identity or bytes", async () => {
    const databaseName = `artifactserver_project_migration_${randomUUID().replaceAll("-", "")}`;
    await createPostgresDatabase(environment, databaseName);
    const migrationEnvironment = {
      ...environment,
      databaseUrl: databaseUrlFor(environment.databaseUrl, databaseName),
    };
    const identity = {
      apiToken: "postgres-project-migration-token-with-sufficient-entropy",
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
          "ALTER TABLE artifacts DROP COLUMN project_id CASCADE",
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
      requiredVersion: 3,
    });
    const migrated = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(migrated.exitCode).toBe(0);
    expect(JSON.parse(migrated.output)).toMatchObject({
      compatibility: "current",
      currentVersion: 3,
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
      currentVersion: 3,
    });
  });

  test("Postgres project scope survives restart", async () => {
    const identity = {
      apiToken: "postgres-project-api-token-with-sufficient-entropy-000",
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

  afterAll(() => {
    s3Client.destroy();
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

    const isolated = await startExternalStorageProcess(environment, {
      apiToken: "isolated-api-token-with-sufficient-entropy-000000",
      installationId: "isolated-external-storage-installation",
    });
    const isolatedList = await listArtifacts(
      isolated.baseUrl,
      "isolated-api-token-with-sufficient-entropy-000000",
    );
    expect(isolatedList.response.status).toBe(200);
    expect(isolatedList.body.artifacts).toEqual([]);
    const guessed = await fetch(
      `${isolated.baseUrl}/api/v1/artifacts/${initial.body.artifact.id}`,
      {
        headers: {
          Authorization:
            "Bearer isolated-api-token-with-sufficient-entropy-000000",
        },
      },
    );
    expect(guessed.status).toBe(404);
  });

  test("foundation: independent external-storage processes expose the same stateless MCP installation", async () => {
    expect.hasAssertions();
    const identity = {
      apiToken: "external-storage-mcp-api-token-with-sufficient-entropy-000000",
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

  test("external-storage foundation: browser sessions, managed keys, and staged uploads cross process boundaries", async () => {
    expect.hasAssertions();
    const externalStorageIdentity = {
      apiToken: "identity-api-token-with-sufficient-entropy-000000",
      installationId: "external-storage-identity-installation",
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, externalStorageIdentity),
      startInProcessExternalStorageServer(environment, externalStorageIdentity),
    ]);

    const login = await fetch(
      `${first.baseUrl}/auth/local?token=${browserBootstrapToken}`,
      {redirect: "manual"},
    );
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
    expect(z.object({apiKeys: z.array(z.object({id: z.string()}))})
      .parse(await keyList.json()).apiKeys).toHaveLength(1);
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

  test("external-storage foundation: Postgres serves management, history, comparison, idempotency, and private content", async () => {
    expect.hasAssertions();
    const repositoryIdentity = {
      apiToken: "repository-api-token-with-sufficient-entropy-000000",
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
      apiToken: "integrity-api-token-with-sufficient-entropy-000000",
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
      apiToken: "backup-api-token-with-sufficient-entropy-00000000",
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
    const login = await fetch(
      `${source.baseUrl}/auth/local?token=${browserBootstrapToken}`,
      {redirect: "manual"},
    );
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
      apiToken: "invalid-storage-api-token-with-sufficient-entropy",
      installationId: "invalid-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const databaseUrl = new URL(environment.databaseUrl);
    databaseUrl.password = "wrong-postgres-password";
    const invalidDatabase = {...environment, databaseUrl: databaseUrl.toString()};
    await expect(startExternalStorageProcess(invalidDatabase, {
      apiToken: "invalid-database-api-token-with-sufficient-entropy",
      installationId: "invalid-database-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const unavailableStorage = {
      ...environment,
      endpoint: "http://127.0.0.1:1",
    };
    await expect(startExternalStorageProcess(unavailableStorage, {
      apiToken: "unavailable-storage-api-token-with-sufficient-entropy",
      installationId: "unavailable-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);
  });

  test("OPS-001-B OPS-001-F: health and dependency readiness are separate and fail closed", async () => {
    expect.hasAssertions();
    const readinessBucket = `artifact-server-readiness-${randomUUID()}`;
    await s3Client.send(new CreateBucketCommand({Bucket: readinessBucket}));
    const server = await startExternalStorageProcess(environment, {
      apiToken: "readiness-api-token-with-sufficient-entropy-000000",
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
        ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
        ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
        ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
        ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
        ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: browserBootstrapToken,
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
): Promise<InProcessExternalStorageServer> {
  const server = await startExternalStorageServer({
    apiToken: Redacted.make(identity.apiToken),
    applicationOrigin: "https://artifacts.example.com",
    bootstrapAdministratorEmail: "admin@example.test",
    contentDomain: "content.example.net",
    databaseUrl: Redacted.make(environment.databaseUrl),
    hostname: "127.0.0.1",
    installationId: identity.installationId,
    localBootstrapCredential: Redacted.make(browserBootstrapToken),
    objectStorage: createS3ObjectStorageProviderFactory({
      accessKeyId: environment.accessKey,
      bucket,
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(environment.secretKey),
    }),
    port: 0,
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
