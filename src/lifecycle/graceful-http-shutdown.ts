import {once} from "node:events";
import type {Server, ServerResponse} from "node:http";

import type {RuntimeLifecycle} from "./runtime-readiness.js";

/** Inputs shared by every Node HTTP deployment during graceful shutdown. */
export interface GracefulHttpShutdownOptions {
  /** Dispose database, storage, and telemetry only after HTTP work drains. */
  readonly closeResources: () => Promise<void>;
  /** Process lifecycle gate exposed through readiness. */
  readonly lifecycle: RuntimeLifecycle;
  /** Bounded time for routing withdrawal before the listener closes. */
  readonly readinessWithdrawalMilliseconds: number;
  /** Maximum drain time before remaining sockets are terminated. */
  readonly shutdownDeadlineMilliseconds: number;
  /** Owned Node HTTP server. */
  readonly server: Server;
}

/**
 * Build an idempotent shutdown operation that preserves accepted work until
 * the deadline and never disposes providers while a request is still running.
 */
export function createGracefulHttpShutdown(
  options: GracefulHttpShutdownOptions,
): () => Promise<void> {
  assertNonNegativeDuration(
    "readiness withdrawal",
    options.readinessWithdrawalMilliseconds,
  );
  assertNonNegativeDuration(
    "shutdown deadline",
    options.shutdownDeadlineMilliseconds,
  );
  let shutdown: Promise<void> | null = null;
  options.server.on("request", (_request, response) => {
    closeIdleConnectionAfterResponse(options, response);
  });
  return () => {
    shutdown ??= runGracefulHttpShutdown(options);
    return shutdown;
  };
}

function closeIdleConnectionAfterResponse(
  options: GracefulHttpShutdownOptions,
  response: ServerResponse,
): void {
  response.once("finish", () => {
    if (options.lifecycle.current() === "draining") {
      options.server.closeIdleConnections();
    }
  });
}

async function runGracefulHttpShutdown(
  options: GracefulHttpShutdownOptions,
): Promise<void> {
  options.lifecycle.startDraining();
  await delay(options.readinessWithdrawalMilliseconds);
  const closed = once(options.server, "close");
  options.server.close();
  options.server.closeIdleConnections();
  const forceClose = setTimeout(
    () => options.server.closeAllConnections(),
    options.shutdownDeadlineMilliseconds,
  );
  try {
    await closed;
  } finally {
    clearTimeout(forceClose);
    await options.closeResources();
  }
}

function assertNonNegativeDuration(name: string, milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`${name} must be a non-negative integer number of milliseconds.`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}
