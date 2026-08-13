import {randomUUID} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type FilePublicationCommand,
  type FilePublicationFailure,
  type FilePublicationResult,
  mediaTypeForPath,
  publishPath,
} from "../../src/client/file-publication-client.js";
import {
  createTestInstallation,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

interface ClientSuccess {
  readonly result: FilePublicationResult;
  readonly success: true;
}

interface ClientFailure {
  readonly error: FilePublicationFailure;
  readonly success: false;
}

type ClientOutcome = ClientFailure | ClientSuccess;
const assignedAddressSchema = z.object({port: z.number().int().positive()});

describe("file publication client", () => {
  let fixtureDirectory: string;
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeAll(async () => {
    installation = await createTestInstallation();
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-client-"));
    server = await startTestServer(installation);
  });

  afterAll(async () => {
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtureDirectory, {force: true, recursive: true}),
    ]);
  });

  test("publishes an ordinary file, a complete directory, and an optimistic new version", async () => {
    const reportPath = path.join(fixtureDirectory, "report.pdf");
    const firstReport = Buffer.from("%PDF-1.4\nfirst client version\n%%EOF\n");
    await writeFile(reportPath, firstReport);

    const report = await executeClient(
      server.baseUrl,
      installation.apiToken,
      newArtifactCommand(reportPath, "public_link"),
    );
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.result.artifact).toMatchObject({
      accessSetting: "public_link",
      name: "report.pdf",
      tags: ["client-test"],
    });
    const openedReport = await fetch(report.result.links.version);
    expect(openedReport.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await openedReport.arrayBuffer())).toEqual(firstReport);

    const sitePath = path.join(fixtureDirectory, "site");
    await mkdir(path.join(sitePath, "assets"), {recursive: true});
    await Promise.all([
      writeFile(path.join(sitePath, "home.html"), "<h1>Complete client site</h1>"),
      writeFile(path.join(sitePath, "assets/app.js"), "document.body.dataset.ready = 'yes';"),
    ]);
    const site = await executeClient(
      server.baseUrl,
      installation.apiToken,
      {
        ...newArtifactCommand(sitePath, "account_required"),
        entryPath: "home.html",
      },
    );
    expect(site.success).toBe(true);
    if (!site.success) return;
    expect(site.result.version.entryPath).toBe("home.html");

    const secondReport = Buffer.from("%PDF-1.4\nsecond client version\n%%EOF\n");
    await writeFile(reportPath, secondReport);
    const version = await executeClient(
      server.baseUrl,
      installation.apiToken,
      {
        idempotencyKey: randomUUID(),
        inputPath: reportPath,
        target: {
          artifactId: report.result.artifact.id,
          expectedCurrentVersionId: report.result.version.id,
          kind: "new_version",
        },
      },
    );
    expect(version.success).toBe(true);
    if (!version.success) return;
    expect(version.result.version).toMatchObject({number: 2});
    const openedVersion = await fetch(version.result.links.version);
    expect(Buffer.from(await openedVersion.arrayBuffer())).toEqual(secondReport);
  });

  test("classifies unsafe filesystem inputs before it creates an upload", async () => {
    const emptyPath = path.join(fixtureDirectory, "empty");
    const missingEntryPath = path.join(fixtureDirectory, "missing-entry");
    const unsafePath = path.join(fixtureDirectory, "unsafe");
    await Promise.all([
      mkdir(emptyPath),
      mkdir(missingEntryPath),
      mkdir(path.join(unsafePath, ".git"), {recursive: true}),
    ]);
    await Promise.all([
      writeFile(path.join(missingEntryPath, "page.html"), "<h1>Wrong entry</h1>"),
      writeFile(path.join(unsafePath, ".git/config"), "[core]\n"),
    ]);

    const [empty, missingEntry, unsafe] = await Promise.all([
      executeClient(server.baseUrl, installation.apiToken, newArtifactCommand(emptyPath)),
      executeClient(
        server.baseUrl,
        installation.apiToken,
        newArtifactCommand(missingEntryPath),
      ),
      executeClient(server.baseUrl, installation.apiToken, newArtifactCommand(unsafePath)),
    ]);
    expect(failureReason(empty)).toBe("empty_directory");
    expect(failureReason(missingEntry)).toBe("invalid_entry");
    expect(failureReason(unsafe)).toBe("invalid_path");
  });

  test("fails closed for invalid credentials, invalid server origins, and cross-origin upload plans", async () => {
    const filePath = path.join(fixtureDirectory, "safe.txt");
    await writeFile(filePath, "safe publication input");

    const unauthorized = await executeClient(
      server.baseUrl,
      "invalid-credential-with-sufficient-entropy",
      newArtifactCommand(filePath),
    );
    expect(unauthorized).toMatchObject({
      error: {
        _tag: "FilePublicationProtocolError",
        operation: "create_upload",
        serverCode: "AUTHENTICATION_REQUIRED",
        status: 401,
      },
      success: false,
    });

    const invalidOrigin = await executeClient(
      "https://username:password@example.test",
      installation.apiToken,
      newArtifactCommand(filePath),
    );
    expect(invalidOrigin).toMatchObject({
      error: {
        _tag: "FilePublicationConfigurationError",
        reason: "invalid_server",
      },
      success: false,
    });

    const uploadPlanServer = await startUnsafeUploadPlanServer();
    try {
      const unsafePlan = await executeClient(
        uploadPlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(unsafePlan).toMatchObject({
        error: {
          _tag: "FilePublicationConfigurationError",
          reason: "unsafe_upload_plan",
        },
        success: false,
      });
    } finally {
      await closeServer(uploadPlanServer.server);
    }
  });

  test("rejects incomplete and malformed plans and reports an unavailable server as protocol failures", async () => {
    const filePath = path.join(fixtureDirectory, "protocol.txt");
    await writeFile(filePath, "protocol failure fixture");

    const incompletePlanServer = await startResponseServer((origin) => JSON.stringify({
      commitUrl: `${origin}/commit`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      files: [],
      manifestDigest: "0".repeat(64),
      uploadId: "incomplete-upload-plan",
    }));
    try {
      const incomplete = await executeClient(
        incompletePlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(incomplete).toMatchObject({
        error: {
          _tag: "FilePublicationConfigurationError",
          reason: "unsafe_upload_plan",
        },
        success: false,
      });
    } finally {
      await closeServer(incompletePlanServer.server);
    }

    const malformedPlanServer = await startResponseServer(() => "{}");
    try {
      const malformed = await executeClient(
        malformedPlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(malformed).toMatchObject({
        error: {
          _tag: "FilePublicationProtocolError",
          operation: "create_upload",
          status: 201,
        },
        success: false,
      });
    } finally {
      await closeServer(malformedPlanServer.server);
    }

    const unavailableServer = await startResponseServer(() => "{}");
    await closeServer(unavailableServer.server);
    const unavailable = await executeClient(
      unavailableServer.origin,
      installation.apiToken,
      newArtifactCommand(filePath),
    );
    expect(unavailable).toMatchObject({
      error: {
        _tag: "FilePublicationProtocolError",
        operation: "create_upload",
        serverCode: null,
        status: null,
      },
      success: false,
    });

    const unstructuredFailureServer = await startResponseServer(
      () => "not a JSON error",
      500,
    );
    try {
      const unstructured = await executeClient(
        unstructuredFailureServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(unstructured).toMatchObject({
        error: {
          _tag: "FilePublicationProtocolError",
          operation: "create_upload",
          serverCode: null,
          status: 500,
        },
        success: false,
      });
    } finally {
      await closeServer(unstructuredFailureServer.server);
    }
  });

  test("uses deterministic media types and a safe binary fallback", () => {
    expect([
      mediaTypeForPath("index.HTML"),
      mediaTypeForPath("document.pdf"),
      mediaTypeForPath("movie.mp4"),
      mediaTypeForPath("unknown.custom"),
    ]).toEqual([
      "text/html; charset=utf-8",
      "application/pdf",
      "video/mp4",
      "application/octet-stream",
    ]);
  });
});

function newArtifactCommand(
  inputPath: string,
  accessSetting: "account_required" | "public_link" = "account_required",
): FilePublicationCommand {
  return {
    idempotencyKey: randomUUID(),
    inputPath,
    target: {
      accessSetting,
      kind: "new_artifact",
      tags: ["client-test"],
    },
  };
}

function executeClient(
  serverOrigin: string,
  apiToken: string,
  command: FilePublicationCommand,
): Promise<ClientOutcome> {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: Redacted.make(apiToken, {label: "test-api-token"}),
        serverOrigin,
      },
      command,
    ).pipe(
      Effect.match({
        onFailure: (error): ClientFailure => ({error, success: false}),
        onSuccess: (result): ClientSuccess => ({result, success: true}),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function failureReason(outcome: ClientOutcome): string | undefined {
  return outcome.success ? undefined : "reason" in outcome.error
    ? outcome.error.reason
    : undefined;
}

async function startUnsafeUploadPlanServer(): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  return startResponseServer(() => JSON.stringify({
      commitUrl: "https://elsewhere.example.test/commit",
      expiresAt: "2099-01-01T00:00:00.000Z",
      files: [{
        method: "PUT",
        path: "safe.txt",
        size: 22,
        uploadUrl: "https://elsewhere.example.test/upload",
      }],
      manifestDigest: "0".repeat(64),
      uploadId: "unsafe-upload-plan",
    }));
}

async function startResponseServer(
  responseForOrigin: (origin: string) => string,
  status = 201,
): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  let origin = "";
  const server = createServer((_request, response) => {
    response.writeHead(status, {"Content-Type": "application/json"});
    response.end(responseForOrigin(origin));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = assignedAddressSchema.safeParse(server.address());
  if (!address.success) {
    await closeServer(server);
    throw new Error("The unsafe upload-plan test server did not receive a TCP port.");
  }
  origin = `http://127.0.0.1:${address.data.port}`;
  return {origin, server};
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
