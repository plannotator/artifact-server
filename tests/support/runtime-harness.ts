import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {startLocalServer} from "../../src/local/start-local-server.js";

export interface TestInstallation {
  readonly apiToken: string;
  readonly dataDirectory: string;
}

export interface RunningTestServer {
  readonly baseUrl: string;
  readonly hostname: "127.0.0.1";
  readonly port: number;
  stop(): Promise<void>;
}

export async function createTestInstallation(): Promise<TestInstallation> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-test-"),
  );
  return {
    apiToken: "test-local-api-token-with-sufficient-entropy",
    dataDirectory,
  };
}

export async function removeTestInstallation(
  installation: TestInstallation,
): Promise<void> {
  await rm(installation.dataDirectory, {force: true, recursive: true});
}

export async function startTestServer(
  installation: TestInstallation,
): Promise<RunningTestServer> {
  const server = await startLocalServer({
    apiToken: installation.apiToken,
    contentDomain: "localhost",
    dataDirectory: installation.dataDirectory,
    port: 0,
  });

  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    hostname: server.hostname,
    port: server.port,
    stop: () => server.close(),
  };
}

export async function fetchVersion(
  server: RunningTestServer,
  versionUrl: string,
  method = "GET",
  headers?: HeadersInit,
): Promise<Response> {
  const target = new URL(versionUrl);
  const requestHeaders = ["Host", `${target.hostname}:${server.port}`];
  for (const [name, value] of new Headers(headers)) {
    requestHeaders.push(name, value);
  }
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        headers: requestHeaders,
        hostname: "127.0.0.1",
        method,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
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
          const bytes = Buffer.concat(chunks);
          const body = new Uint8Array(bytes.byteLength);
          body.set(bytes);
          resolve(
            new Response(body.buffer, {
              headers: responseHeaders,
              status: incoming.statusCode ?? 500,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export function apiHeaders(
  installation: TestInstallation,
  idempotencyKey: string,
): Headers {
  return new Headers({
    Authorization: `Bearer ${installation.apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}
