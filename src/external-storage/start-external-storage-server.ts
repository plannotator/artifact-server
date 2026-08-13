import {once} from "node:events";
import {createServer} from "node:http";

import {getRequestListener} from "@hono/node-server";
import {z} from "zod";

import {
  createExternalStorageRuntime,
  type ExternalStorageRuntimeConfig,
} from "./create-external-storage-runtime.js";

const serverAddressSchema = z.object({
  address: z.string().min(1),
  port: z.number().int().positive(),
});

/** External-storage server settings for one process. */
export interface ExternalStorageServerConfig extends ExternalStorageRuntimeConfig {
  readonly hostname: string;
  readonly port: number;
}

/** One running stateless external-storage process. */
export interface RunningExternalStorageServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Start one external-storage process after provider readiness succeeds. */
export async function startExternalStorageServer(
  config: ExternalStorageServerConfig,
): Promise<RunningExternalStorageServer> {
  const runtime = await createExternalStorageRuntime(config);
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
