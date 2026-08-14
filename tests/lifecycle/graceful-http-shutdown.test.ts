import {once} from "node:events";
import {createServer} from "node:http";

import {describe, expect, test} from "vitest";
import {z} from "zod";

import {createGracefulHttpShutdown} from
  "../../src/lifecycle/graceful-http-shutdown.js";
import {createRuntimeLifecycle} from
  "../../src/lifecycle/runtime-readiness.js";

const addressSchema = z.object({port: z.number().int().positive()});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function noop(): void {}

function createDeferred(): Deferred {
  let resolve = noop;
  const promise = new Promise<void>((complete) => {
    resolve = () => complete();
  });
  return {promise, resolve};
}

describe("graceful HTTP shutdown", () => {
  test("withdraws readiness and preserves accepted work before closing resources", async () => {
    const accepted = createDeferred();
    const finish = createDeferred();
    let resourcesClosed = false;
    const lifecycle = createRuntimeLifecycle();
    const server = createServer((_request, response) => {
      accepted.resolve();
      void finish.promise.then(() => response.end("completed"));
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    lifecycle.markReady();
    const close = createGracefulHttpShutdown({
      closeResources: () => {
        resourcesClosed = true;
        return Promise.resolve();
      },
      lifecycle,
      readinessWithdrawalMilliseconds: 0,
      server,
      shutdownDeadlineMilliseconds: 2_000,
    });
    const {port} = addressSchema.parse(server.address());
    const response = fetch(`http://127.0.0.1:${port}/accepted`);
    await accepted.promise;

    const firstClose = close();
    const secondClose = close();
    expect(firstClose).toBe(secondClose);
    expect(lifecycle.current()).toBe("draining");
    expect(resourcesClosed).toBe(false);

    finish.resolve();
    expect(await (await response).text()).toBe("completed");
    await firstClose;
    expect(resourcesClosed).toBe(true);
  });

  test("terminates stuck work at the configured deadline before closing resources", async () => {
    const accepted = createDeferred();
    let resourcesClosed = false;
    const lifecycle = createRuntimeLifecycle();
    const server = createServer(() => accepted.resolve());
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    lifecycle.markReady();
    const close = createGracefulHttpShutdown({
      closeResources: () => {
        resourcesClosed = true;
        return Promise.resolve();
      },
      lifecycle,
      readinessWithdrawalMilliseconds: 0,
      server,
      shutdownDeadlineMilliseconds: 20,
    });
    const {port} = addressSchema.parse(server.address());
    const response = fetch(`http://127.0.0.1:${port}/stuck`);
    await accepted.promise;

    await close();
    expect(resourcesClosed).toBe(true);
    await expect(response).rejects.toBeInstanceOf(TypeError);
  });
});
