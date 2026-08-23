import {once} from "node:events";
import {createServer, type IncomingMessage, type Server} from "node:http";

import {Effect, Redacted} from "effect";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {CloudflareArtifactsRestHealthProbe} from
  "../../src/git-history/cloudflare-artifacts-rest-health-probe.js";

interface ResponsePlan {
  readonly body: string;
  readonly status: number;
}
const assignedAddressSchema = z.object({port: z.number().int().positive()});

describe("Cloudflare Artifacts REST availability", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server !== null) await closeHttpServer(server);
    server = null;
  });

  test("GIT-010 GIT-013 foundation: the read-only namespace check is path-scoped, authenticated, bounded, and safely classified", async () => {
    let plan: ResponsePlan = {
      body: JSON.stringify({errors: [], result: {}, success: true}),
      status: 200,
    };
    const requests: Array<{
      readonly authorization: string | undefined;
      readonly method: string | undefined;
      readonly url: string | undefined;
    }> = [];
    const provider = await startProviderServer(
      () => plan,
      (request) => requests.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url,
      }),
    );
    server = provider.server;
    const secret = "cloudflare-artifacts-health-secret";
    const probe = new CloudflareArtifactsRestHealthProbe({
      apiOrigin: provider.origin,
      apiToken: Redacted.make(secret, {label: "test-cloudflare-token"}),
      identity: {
        accountId: "account/with-slash",
        namespace: "namespace/with-slash",
        provider: "cloudflare-artifacts",
      },
    });

    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      state: "available",
    });
    expect(requests).toEqual([{
      authorization: `Bearer ${secret}`,
      method: "GET",
      url: "/client/v4/accounts/account%2Fwith-slash/artifacts/namespaces/namespace%2Fwith-slash",
    }]);

    plan = {body: JSON.stringify({success: false}), status: 401};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "access_rejected",
      state: "misconfigured",
    });

    plan = {body: JSON.stringify({success: false}), status: 404};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "namespace_missing",
      state: "misconfigured",
    });

    plan = {body: JSON.stringify({success: false}), status: 429};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "rate_limited",
      state: "degraded",
    });

    plan = {body: JSON.stringify({success: false}), status: 503};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "provider_unavailable",
      state: "degraded",
    });

    plan = {body: "not-json", status: 200};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "invalid_response",
      state: "degraded",
    });

    plan = {body: "x".repeat(16 * 1024 + 1), status: 200};
    await expect(Effect.runPromise(probe.check())).resolves.toEqual({
      reason: "invalid_response",
      state: "degraded",
    });
  });
});

async function startProviderServer(
  responsePlan: () => ResponsePlan,
  observe: (request: IncomingMessage) => void,
): Promise<{readonly origin: URL; readonly server: Server}> {
  const server = createServer((request, response) => {
    observe(request);
    const plan = responsePlan();
    response.writeHead(plan.status, {"Content-Type": "application/json"});
    response.end(plan.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = assignedAddressSchema.parse(server.address());
  return {
    origin: new URL(`http://127.0.0.1:${address.port}`),
    server,
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
