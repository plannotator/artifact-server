/**
 * A loopback HTTP proxy in front of the real Artifact Server whose claim route
 * the test can close. Closing it is what makes a dispatch sit `queued` at a
 * chosen moment — the live suite needs that to hold a bundle in the mailbox
 * across a Pi session replacement instead of racing the bridge's claim loop.
 *
 * Everything else is forwarded untouched, so the bridge still talks to the real
 * server over a real network boundary.
 */

import {createServer, type Server} from "node:http";

import {z} from "zod";

/** The running proxy. */
export interface ClaimGateProxy {
  /** Answer claim polls with "no work" instead of forwarding them. */
  closeClaims(): void;
  /** Forward claim polls again. */
  openClaims(): void;
  readonly origin: string;
  stop(): Promise<void>;
}

const claimRoute = /^\/api\/v1\/agents\/[^/]+\/claims(?:\?|$)/u;
const heldClaimMilliseconds = 1_000;
const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/** Start the proxy in front of one origin. */
export async function startClaimGateProxy(
  targetOrigin: string,
): Promise<ClaimGateProxy> {
  let claimsClosed = false;
  // Claim polls are long-held upstream. Closing the gate has to break the
  // polls already in flight too, or the next send is answered by a request
  // that was forwarded before the gate closed.
  const inFlightClaims = new Set<AbortController>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", resolve);
        request.on("error", reject);
      });

      const isClaim = request.method === "POST" && claimRoute.test(target);
      if (claimsClosed && isClaim) {
        // The bridge treats 204 as "nothing queued for me" and polls again;
        // the pause keeps that loop from spinning while the gate is closed.
        await new Promise((resolve) => {
          setTimeout(resolve, heldClaimMilliseconds);
        });
        response.writeHead(204);
        response.end();
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("host", new URL(targetOrigin).host);
      const method = request.method ?? "GET";
      const controller = new AbortController();
      const forwarded: RequestInit = method === "GET" || method === "HEAD"
        ? {headers, method, signal: controller.signal}
        : {
          body: Buffer.concat(chunks),
          headers,
          method,
          signal: controller.signal,
        };
      if (isClaim) inFlightClaims.add(controller);
      let answerBody: Buffer;
      let answer: Response;
      try {
        answer = await fetch(new URL(target, targetOrigin), forwarded);
        answerBody = Buffer.from(await answer.arrayBuffer());
      } catch (error) {
        if (isClaim && controller.signal.aborted) {
          // A poll cut short by the gate simply answers "nothing queued".
          response.writeHead(204);
          response.end();
          return;
        }
        throw error;
      } finally {
        inFlightClaims.delete(controller);
      }
      const outgoing: Record<string, string> = {};
      answer.headers.forEach((value, name) => {
        if (!hopByHopHeaders.has(name)) outgoing[name] = value;
      });
      response.writeHead(answer.status, outgoing);
      response.end(answerBody);
    })().catch(() => {
      response.writeHead(502);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({port: z.number()}).parse(server.address());

  return {
    closeClaims: () => {
      claimsClosed = true;
      for (const controller of inFlightClaims) controller.abort();
      inFlightClaims.clear();
    },
    openClaims: () => {
      claimsClosed = false;
    },
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
