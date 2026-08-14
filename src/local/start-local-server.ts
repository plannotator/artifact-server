import {once} from "node:events";
import {createServer} from "node:http";

import {getRequestListener} from "@hono/node-server";
import {z} from "zod";

import {createLocalRuntime, type LocalRuntimeConfig} from "./create-local-runtime.js";
import {createGracefulHttpShutdown} from
  "../lifecycle/graceful-http-shutdown.js";
import {createRuntimeLifecycle} from "../lifecycle/runtime-readiness.js";

const loopbackHostname = "127.0.0.1";
const serverAddressSchema = z.object({
  address: z.string().min(1),
  port: z.number().int().positive(),
});

export interface LocalServerConfig extends LocalRuntimeConfig {
  readonly hostname?: string;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds?: number;
  readonly shutdownDeadlineMilliseconds?: number;
}

export interface RunningLocalServer {
  readonly hostname: string;
  readonly port: number;
  /** Withdraw readiness and gracefully drain accepted HTTP work. */
  close(): Promise<void>;
}

export async function startLocalServer(
  config: LocalServerConfig,
): Promise<RunningLocalServer> {
  const lifecycle = config.runtimeLifecycle ?? createRuntimeLifecycle();
  const hostname = config.hostname ?? loopbackHostname;
  const runtime = await createLocalRuntime({
    ...config,
    observability: config.observability ?? true,
    runtimeLifecycle: lifecycle,
  });
  const server = createServer(
    getRequestListener(runtime.app.fetch, {hostname}),
  );
  const listening = once(server, "listening");
  try {
    server.listen(config.port, hostname);
    await listening;
  } catch (error) {
    server.closeAllConnections();
    await runtime.close();
    throw error;
  }
  const address = serverAddressSchema.parse(server.address());
  lifecycle.markReady();
  const close = createGracefulHttpShutdown({
    closeResources: () => runtime.close(),
    lifecycle,
    readinessWithdrawalMilliseconds:
      config.readinessWithdrawalMilliseconds ?? 0,
    server,
    shutdownDeadlineMilliseconds:
      config.shutdownDeadlineMilliseconds ?? 10_000,
  });

  return {
    hostname: address.address,
    port: address.port,
    close,
  };
}
