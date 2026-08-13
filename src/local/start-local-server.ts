import {once} from "node:events";
import {createServer} from "node:http";

import {getRequestListener} from "@hono/node-server";
import {z} from "zod";

import {createLocalRuntime, type LocalRuntimeConfig} from "./create-local-runtime.js";

const loopbackHostname = "127.0.0.1";
const serverAddressSchema = z.object({
  address: z.literal(loopbackHostname),
  port: z.number().int().positive(),
});

export interface LocalServerConfig extends LocalRuntimeConfig {
  readonly port: number;
}

export interface RunningLocalServer {
  readonly hostname: typeof loopbackHostname;
  readonly port: number;
  close(): Promise<void>;
}

export async function startLocalServer(
  config: LocalServerConfig,
): Promise<RunningLocalServer> {
  const runtime = await createLocalRuntime(config);
  const server = createServer(
    getRequestListener(runtime.app.fetch, {hostname: loopbackHostname}),
  );
  server.listen(config.port, loopbackHostname);
  try {
    await once(server, "listening");
  } catch (error) {
    server.closeAllConnections();
    await runtime.close();
    throw error;
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
