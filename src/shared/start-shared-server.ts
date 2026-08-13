import {once} from "node:events";
import {createServer} from "node:http";

import {getRequestListener} from "@hono/node-server";
import {z} from "zod";

import {
  createSharedRuntime,
  type SharedRuntimeConfig,
} from "./create-shared-runtime.js";

const serverAddressSchema = z.object({
  address: z.string().min(1),
  port: z.number().int().positive(),
});

/** Shared server settings for one process. */
export interface SharedServerConfig extends SharedRuntimeConfig {
  readonly hostname: string;
  readonly port: number;
}

/** One running stateless shared-server process. */
export interface RunningSharedServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Start one shared-server process after provider readiness succeeds. */
export async function startSharedServer(
  config: SharedServerConfig,
): Promise<RunningSharedServer> {
  const runtime = await createSharedRuntime(config);
  const server = createServer(
    getRequestListener(runtime.app.fetch, {hostname: config.hostname}),
  );
  server.listen(config.port, config.hostname);
  try {
    await once(server, "listening");
  } catch (cause) {
    server.closeAllConnections();
    await runtime.close();
    throw cause;
  }
  const address = serverAddressSchema.parse(server.address());
  return {
    hostname: address.address,
    port: address.port,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeIdleConnections();
      server.closeAllConnections();
      await Promise.all([closed, runtime.close()]);
    },
  };
}
