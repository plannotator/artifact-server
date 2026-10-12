import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {z} from "zod";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Clock} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const mcpOnlyToken = "mcp-oauth-only-member-token";
const uploadPlanSchema = z.object({
  files: z.array(z.object({
    authorization: z.object({
      credential: z.literal("upload_grant"),
      scheme: z.literal("Bearer"),
    }),
    path: z.string(),
    uploadUrl: z.url(),
  })).min(1),
  uploadGrant: z.object({
    expiresAt: z.string(),
    scheme: z.literal("Bearer"),
    token: z.string().startsWith("as_upg_"),
  }),
  uploadId: z.string(),
});
const toolCallResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
});

const grantedBytes = new TextEncoder().encode("granted upload");
const declaredFile = {
  mediaType: "text/plain",
  path: "proof.txt",
  sha256: createHash("sha256").update(grantedBytes).digest("hex"),
  size: grantedBytes.byteLength,
};

describe("upload grants: staged upload service", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let identityRepository: SqliteIdentityRepository;
  let repository: SqliteArtifactRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-upload-grant-service-"));
    clock = new ControlledClock(new Date("2026-10-12T08:00:00.000Z"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      bootstrapAdministratorEmail: "admin@example.test",
      clock,
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalMcpBearerVerifier: null,
      externalMcpOAuthVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: "test-installation",
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  const createGranted = () =>
    runStaged(runtime, (service) =>
      service.createUploadWithGrant({
        entryPath: declaredFile.path,
        files: [declaredFile],
        principal: owner,
      })
    );

  test("issues a grant once, stores only its digest, and accepts it for its own file", async () => {
    expect.hasAssertions();
    const {grant, upload} = await createGranted();
    const token = Redacted.value(grant);
    expect(token.startsWith("as_upg_")).toBe(true);
    const stored = await repository.findStagedUploadGrant(upload.id);
    expect(stored?.grantDigest).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The upload has no file slot.");

    const uploaded = await runStaged(runtime, (service) =>
      service.uploadFileWithGrant({
        body: byteStream(grantedBytes),
        grant,
        projectId: null,
        storageToken: slot.storageToken,
        uploadId: upload.id,
      })
    );
    expect(uploaded.files[0]?.uploadedAt).not.toBeNull();
  });

  test("refuses a wrong grant, another upload's grant, an unknown upload, and the wrong project alike", async () => {
    expect.hasAssertions();
    const first = await createGranted();
    const second = await createGranted();
    const slot = first.upload.files[0];
    if (slot === undefined) throw new Error("The upload has no file slot.");
    const attempts = [
      {grant: `as_upg_${"A".repeat(43)}`, projectId: null, uploadId: first.upload.id},
      {grant: Redacted.value(second.grant), projectId: null, uploadId: first.upload.id},
      {grant: Redacted.value(first.grant), projectId: null, uploadId: "upl_missing"},
      {
        grant: Redacted.value(first.grant),
        projectId: "prj_00000000-0000-4000-8000-000000000000",
        uploadId: first.upload.id,
      },
    ];
    await Promise.all(attempts.map((attempt) =>
      expectStagedFailure(runtime, "AuthenticationRequired", (service) =>
        service.uploadFileWithGrant({
          body: byteStream(grantedBytes),
          grant: Redacted.make(attempt.grant),
          projectId: attempt.projectId,
          storageToken: slot.storageToken,
          uploadId: attempt.uploadId,
        })
      )
    ));
  });

  test("an upload created without a grant refuses every grant", async () => {
    expect.hasAssertions();
    const plain = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: declaredFile.path,
        files: [declaredFile],
        principal: owner,
      })
    );
    const {grant} = await createGranted();
    const slot = plain.files[0];
    if (slot === undefined) throw new Error("The upload has no file slot.");
    await expectStagedFailure(runtime, "AuthenticationRequired", (service) =>
      service.uploadFileWithGrant({
        body: byteStream(grantedBytes),
        grant,
        projectId: null,
        storageToken: slot.storageToken,
        uploadId: plain.id,
      })
    );
    expect((await repository.findStagedUploadGrant(plain.id))?.grantDigest).toBeNull();
  });

  test("a matching grant is refused once the upload expired or was committed", async () => {
    expect.hasAssertions();
    const expiring = await createGranted();
    const expiringSlot = expiring.upload.files[0];
    if (expiringSlot === undefined) throw new Error("The upload has no file slot.");
    clock.set(new Date("2026-10-12T09:00:00.000Z"));
    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.uploadFileWithGrant({
        body: byteStream(grantedBytes),
        grant: expiring.grant,
        projectId: null,
        storageToken: expiringSlot.storageToken,
        uploadId: expiring.upload.id,
      })
    );

    const fresh = await createGranted();
    const freshSlot = fresh.upload.files[0];
    if (freshSlot === undefined) throw new Error("The upload has no file slot.");
    const upload = (service: StagedUploadService["Service"]) =>
      service.uploadFileWithGrant({
        body: byteStream(grantedBytes),
        grant: fresh.grant,
        projectId: null,
        storageToken: freshSlot.storageToken,
        uploadId: fresh.upload.id,
      });
    await runStaged(runtime, upload);
    await runStaged(runtime, (service) =>
      service.commitUpload({
        idempotencyKey: "upload-grant-service-commit",
        principal: owner,
        target: {
          accessSetting: "account_required",
          kind: "new_artifact",
          name: "Granted upload",
        },
        uploadId: fresh.upload.id,
      })
    );
    await expectStagedFailure(runtime, "UploadClosed", upload);
  });
});

const owner: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [
    principalCapabilities.createArtifact,
    principalCapabilities.issueContentSession,
    principalCapabilities.publishAnyArtifact,
  ],
  displayName: "Upload grant fixture",
  id: "principal-owner",
  installationId: "test-installation",
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};

class ControlledClock implements Clock {
  #current: Date;

  constructor(initial: Date) {
    this.#current = initial;
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(current: Date): void {
    this.#current = current;
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function runStaged<A, E>(
  runtime: ApplicationRuntime,
  operation: (service: StagedUploadService["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(StagedUploadService.use(operation));
}

async function expectStagedFailure<A, E extends {_tag: string}>(
  runtime: ApplicationRuntime,
  expectedTag: E["_tag"],
  operation: (service: StagedUploadService["Service"]) => Effect.Effect<A, E>,
): Promise<void> {
  const result = await runtime.runPromise(
    Effect.result(StagedUploadService.use(operation)),
  );
  const actualTag = Result.match(result, {
    onFailure: (failure) => failure._tag,
    onSuccess: () => "UnexpectedSuccess",
  });
  expect(actualTag).toBe(expectedTag);
}

describe("upload grants: HTTP and MCP", () => {
  let clock: ControlledClock;
  let installation: TestInstallation;
  let output: string[];
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new ControlledClock(new Date());
    output = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      output.push(Buffer.from(chunk).toString("utf8"));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    // A credential only MCP accepts, like an Entra access token: /api/ refuses it.
    const mcpOnlyVerifier: BearerCredentialVerifier = {
      verify: (credential) => Redacted.value(credential) === mcpOnlyToken
        ? Effect.succeed({
          authorizedByPrincipalId: null,
          capabilities: [
            principalCapabilities.createArtifact,
            principalCapabilities.readArtifacts,
          ],
          displayName: "MCP-only member",
          id: "mcp-only-member",
          installationId: "local",
          kind: principalKinds.service,
          membershipRole: membershipRoles.member,
        })
        : Effect.fail(new AuthenticationRequired({
          message: "The external token is invalid.",
        })),
    };
    server = await startTestServer(installation, {
      clock,
      completedRequestLogSampleRate: 1,
      externalMcpBearerVerifier: mcpOnlyVerifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
    await removeTestInstallation(installation);
  });

  const createPlan = async (
    files: readonly {readonly bytes: Uint8Array; readonly path: string}[],
  ) => {
    const result = await callTool(server, mcpOnlyToken, "artifact_create_upload", {
      entryPath: files[0]?.path ?? "index.html",
      files: files.map(({bytes, path: filePath}) => ({
        mediaType: filePath.endsWith(".css") ? "text/css" : "text/html",
        path: filePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      })),
    });
    expect(result.isError).not.toBe(true);
    return uploadPlanSchema.parse(result.structuredContent);
  };
  const commit = (uploadId: string, idempotencyKey: string) =>
    callTool(server, mcpOnlyToken, "artifact_commit_upload", {
      idempotencyKey,
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Granted upload",
      },
      uploadId,
    });

  test("PUB-014-B: an MCP client without an API key uploads with the returned grant and commits through MCP", async () => {
    expect.hasAssertions();
    const index = new TextEncoder().encode("<h1>granted</h1>");
    const style = new TextEncoder().encode("h1{color:red}");
    const plan = await createPlan([
      {bytes: index, path: "index.html"},
      {bytes: style, path: "style.css"},
    ]);
    const first = plan.files[0];
    if (first === undefined) throw new Error("The upload plan is empty.");

    // The MCP credential itself still cannot reach /api/.
    expect((await sendFile(first.uploadUrl, mcpOnlyToken, index)).status).toBe(401);

    const bodies = new Map([["index.html", index], ["style.css", style]]);
    const responses = await Promise.all(plan.files.map((file) =>
      sendFile(file.uploadUrl, plan.uploadGrant.token, bodies.get(file.path) ?? new Uint8Array())
    ));
    expect(responses.map(({status}) => status)).toEqual([200, 200]);

    const committed = await commit(plan.uploadId, "upload-grant-http-commit");
    expect(committed.isError).not.toBe(true);
    expect(committed.structuredContent).toMatchObject({
      links: {review: expect.any(String)},
    });
    expect(output.join("")).not.toContain(plan.uploadGrant.token);
  });

  test("PUB-014-F: a grant is refused everywhere except its own upload's file uploads", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("<p>a</p>");
    const [own, other] = await Promise.all([
      createPlan([{bytes, path: "index.html"}]),
      createPlan([{bytes, path: "index.html"}]),
    ]);
    const ownFile = own.files[0];
    const otherFile = other.files[0];
    if (ownFile === undefined || otherFile === undefined) {
      throw new Error("An upload plan is empty.");
    }
    const grant = own.uploadGrant.token;
    const ownPath = ownFile.uploadUrl.split("?")[0] ?? ownFile.uploadUrl;
    const changedGrant = `${grant.slice(0, -1)}${grant.endsWith("A") ? "B" : "A"}`;
    const refused = await Promise.all([
      sendFile(otherFile.uploadUrl, grant, bytes),
      sendFile(`${ownPath}/`, grant, bytes),
      sendFile(`${ownPath}/extra`, grant, bytes),
      sendFile(ownFile.uploadUrl, grant, bytes, "POST"),
      fetch(`${server.baseUrl}/api/v1/artifacts`, {
        headers: {Authorization: `Bearer ${grant}`},
      }),
      fetch(`${server.baseUrl}/api/v1/uploads/${own.uploadId}/commit`, {
        body: "{}",
        headers: {
          Authorization: `Bearer ${grant}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "grant-must-not-commit",
        },
        method: "POST",
      }),
      sendFile(
        ownFile.uploadUrl.replace(
          /projectId=[^&]+/u,
          "projectId=prj_00000000-0000-4000-8000-000000000000",
        ),
        grant,
        bytes,
      ),
      sendFile(ownFile.uploadUrl, changedGrant, bytes),
    ]);
    expect(refused.map(({status}) => status)).toEqual(Array(8).fill(401));

    expect((await sendFile(ownFile.uploadUrl, grant, bytes)).status).toBe(200);
    expect((await commit(own.uploadId, "upload-grant-http-closed")).isError).not.toBe(true);
    expect((await sendFile(ownFile.uploadUrl, grant, bytes)).status).toBe(409);

    clock.set(new Date(Date.parse(other.uploadGrant.expiresAt) + 1_000));
    expect((await sendFile(otherFile.uploadUrl, other.uploadGrant.token, bytes)).status)
      .toBe(410);
  });
});

function sendFile(
  url: string,
  token: string,
  bytes: Uint8Array,
  method: "POST" | "PUT" = "PUT",
): Promise<Response> {
  return fetch(url, {
    body: Buffer.from(bytes),
    headers: {Authorization: `Bearer ${token}`},
    method,
  });
}

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;

async function callTool(
  server: RunningTestServer,
  token: string,
  name: string,
  parameters: McpParameters,
) {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: parameters,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  return toolCallResultSchema.parse(await response.json()).result;
}
