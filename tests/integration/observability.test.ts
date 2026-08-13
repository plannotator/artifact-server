import {createServer} from "node:http";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

const exportedSignalSchema = z.object({
  resourceLogs: z.array(z.unknown()).optional(),
  resourceMetrics: z.array(z.unknown()).optional(),
  resourceSpans: z.array(z.unknown()).optional(),
});
const collectorAddressSchema = z.object({
  address: z.string(),
  family: z.string(),
  port: z.number().int().positive(),
});

interface CapturedSignal {
  readonly body: z.infer<typeof exportedSignalSchema>;
  readonly path: string;
}

describe("Effect OTLP observability", () => {
  const closeables: Array<() => Promise<void>> = [];
  const originalEnvironment = new Map<string, string | undefined>();

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((close) => close()));
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnvironment.clear();
  });

  test("OPS-009-B OPS-009-F: deployed HTTP and MCP requests export safe correlated telemetry", async () => {
    expect.hasAssertions();
    const signals: CapturedSignal[] = [];
    const collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        signals.push({
          body: exportedSignalSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
          path: request.url ?? "",
        });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collectorAddressSchema.parse(collector.address());
    closeables.push(async () => {
      await new Promise<void>((resolve, reject) => {
        collector.close((error) => error === undefined ? resolve() : reject(error));
      });
    });

    configureOtlp(address.port);

    const installation = await createTestInstallation();
    closeables.push(() => removeTestInstallation(installation));
    const artifactServer = await startTestServer(installation, {
      completedRequestLogSampleRate: 1,
      observability: true,
    });
    closeables.push(() => artifactServer.stop());

    const health = await fetch(
      `${artifactServer.baseUrl}/health?credential=query-secret`,
      {
        headers: {
          Authorization: "Bearer header-secret",
          Cookie: "session=cookie-secret",
          "X-Request-Id": "caller-controlled-request-id",
        },
      },
    );
    expect(health.status).toBe(200);
    const requestId = z.uuid().parse(health.headers.get("x-request-id"));
    expect(requestId).not.toBe("caller-controlled-request-id");
    const mcp = await fetch(`${artifactServer.baseUrl}/mcp`, {
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "server/discover"}),
      headers: {
        Authorization:
          "Bearer mcp-secret-token-with-sufficient-entropy-000000",
        "Content-Type": "application/json",
        Host: `127.0.0.1:${artifactServer.port}`,
      },
      method: "POST",
    });
    expect(mcp.status).toBe(401);
    const unmatched = await fetch(
      `${artifactServer.baseUrl}/unbounded/identifier-secret`,
      {method: "PATCH"},
    );
    expect(unmatched.status).toBe(404);

    await waitForSignals(signals, ["unmatched"]);
    expect(signals.map((signal) => signal.path)).toEqual(
      expect.arrayContaining(["/v1/logs", "/v1/metrics", "/v1/traces"]),
    );
    const serialized = JSON.stringify(signals);
    expect(serialized).toContain("artifact_server_http_requests_total");
    expect(serialized).toContain("artifact_server_http_request_duration");
    expect(serialized).toContain("http.request.completed");
    expect(serialized).toContain("http.request");
    expect(serialized).toContain(requestId);
    expect(serialized).toContain("/health");
    expect(serialized).toContain("/mcp");
    expect(serialized).toContain("unmatched");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("cookie-secret");
    expect(serialized).not.toContain("caller-controlled-request-id");
    expect(serialized).not.toContain("mcp-secret-token");
    expect(serialized).not.toContain("identifier-secret");
  });

  test("an unavailable telemetry collector does not take down HTTP", async () => {
    expect.hasAssertions();
    const unavailablePort = await reserveClosedPort();
    configureOtlp(unavailablePort);

    const installation = await createTestInstallation();
    closeables.push(() => removeTestInstallation(installation));
    const artifactServer = await startTestServer(installation, {
      observability: true,
    });
    closeables.push(() => artifactServer.stop());

    const firstHealth = await fetch(`${artifactServer.baseUrl}/health`);
    expect(firstHealth.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondHealth = await fetch(`${artifactServer.baseUrl}/health`);
    expect(secondHealth.status).toBe(200);
    expect(await secondHealth.json()).toEqual({status: "ok"});
  });

  function configureOtlp(port: number): void {
    setEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${port}`);
    setEnvironment("OTEL_EXPORTER_OTLP_TIMEOUT", "100");
    setEnvironment("OTEL_LOGS_EXPORTER", "otlp");
    setEnvironment("OTEL_METRICS_EXPORTER", "otlp");
    setEnvironment("OTEL_TRACES_EXPORTER", "otlp");
    setEnvironment("OTEL_BLRP_SCHEDULE_DELAY", "25");
    setEnvironment("OTEL_METRIC_EXPORT_INTERVAL", "25");
    setEnvironment("OTEL_BSP_SCHEDULE_DELAY", "25");
  }

  function setEnvironment(name: string, value: string): void {
    originalEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
});

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = collectorAddressSchema.parse(server.address());
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function waitForSignals(
  signals: readonly CapturedSignal[],
  requiredContent: readonly string[] = [],
): Promise<void> {
  return waitForSignalsAttempt(signals, requiredContent, 200);
}

async function waitForSignalsAttempt(
  signals: readonly CapturedSignal[],
  requiredContent: readonly string[],
  remainingAttempts: number,
): Promise<void> {
  const paths = new Set(signals.map((signal) => signal.path));
  if (
    paths.has("/v1/logs") && paths.has("/v1/metrics") &&
    paths.has("/v1/traces") && requiredContent.every((value) =>
      JSON.stringify(signals).includes(value)
    )
  ) return;
  if (remainingAttempts === 0) {
    throw new Error(`OTLP signals did not arrive: ${JSON.stringify(signals)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  return waitForSignalsAttempt(signals, requiredContent, remainingAttempts - 1);
}
