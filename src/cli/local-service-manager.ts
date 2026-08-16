import {spawn} from "node:child_process";
import {mkdir, open, rm, stat} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import type {CliInvocation} from "./current-cli-invocation.js";
import {
  inspectLocalServiceRecord,
  type LocalServiceRecord,
} from "../local/local-service-record.js";

const serviceStartupTimeoutMilliseconds = 15_000;
const serviceLockStaleMilliseconds = 30_000;
const systemErrorSchema = z.object({code: z.string().optional()});
const healthResponseSchema = z.object({status: z.literal("ok")}).strict();

/** Health and discovery state for one managed local service. */
export interface LocalServiceInspection {
  readonly processAlive: boolean | null;
  readonly record: LocalServiceRecord | null;
  readonly recordState: "invalid" | "missing" | "valid";
  readonly recordReason: string | null;
  readonly reachable: boolean;
}

/** Inspect the managed service without starting or changing it. */
export async function inspectManagedLocalService(
  dataDirectory: string,
): Promise<LocalServiceInspection> {
  const inspected = await inspectLocalServiceRecord(dataDirectory);
  if (inspected.state === "missing") {
    return {
      processAlive: null,
      reachable: false,
      record: null,
      recordReason: null,
      recordState: "missing",
    };
  }
  if (inspected.state === "invalid") {
    return {
      processAlive: null,
      reachable: false,
      record: null,
      recordReason: inspected.reason,
      recordState: "invalid",
    };
  }
  const [processAlive, reachable] = await Promise.all([
    isProcessAlive(inspected.record.pid),
    isHealthy(inspected.record.origin),
  ]);
  return {
    processAlive,
    reachable,
    record: inspected.record,
    recordReason: null,
    recordState: "valid",
  };
}

/** Locate a healthy per-user service or start exactly one detached process. */
export async function ensureManagedLocalService(
  dataDirectory: string,
  invocation: CliInvocation,
): Promise<LocalServiceRecord> {
  const resolvedDataDirectory = path.resolve(dataDirectory);
  const existing = await inspectManagedLocalService(resolvedDataDirectory);
  if (existing.reachable && existing.record !== null) return existing.record;
  refuseCompetingDatabaseOwner(existing);

  const releaseLock = await acquireStartupLock(resolvedDataDirectory);
  if (releaseLock === null) {
    return waitForHealthyService(resolvedDataDirectory);
  }

  try {
    const afterLock = await inspectManagedLocalService(resolvedDataDirectory);
    if (afterLock.reachable && afterLock.record !== null) return afterLock.record;
    refuseCompetingDatabaseOwner(afterLock);
    await spawnManagedService(resolvedDataDirectory, invocation);
    return await waitForHealthyService(resolvedDataDirectory);
  } finally {
    await releaseLock();
  }
}

async function acquireStartupLock(
  dataDirectory: string,
): Promise<null | (() => Promise<void>)> {
  const lockPath = path.join(dataDirectory, "local-service-start.lock");
  await openDirectoryForLock(dataDirectory);
  try {
    const lock = await open(lockPath, "wx", 0o600);
    try {
      await lock.writeFile(`${process.pid}\n`);
      await lock.chmod(0o600);
    } catch (error) {
      await lock.close();
      await rm(lockPath, {force: true});
      throw error;
    }
    await lock.close();
    return () => rm(lockPath, {force: true});
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
  }

  try {
    const details = await stat(lockPath);
    if (Date.now() - details.mtimeMs <= serviceLockStaleMilliseconds) return null;
    await rm(lockPath, {force: true});
    return acquireStartupLock(dataDirectory);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") {
      return acquireStartupLock(dataDirectory);
    }
    throw error;
  }
}

async function openDirectoryForLock(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
}

async function spawnManagedService(
  dataDirectory: string,
  invocation: CliInvocation,
): Promise<void> {
  const logPath = path.join(dataDirectory, "local-service.log");
  const log = await open(logPath, "a", 0o600);
  try {
    await log.chmod(0o600);
    const child = spawn(
      invocation.command,
      [
        ...invocation.prefixArguments,
        "start",
        "--data",
        dataDirectory,
        "--port",
        "0",
        "--managed",
      ],
      {
        detached: true,
        env: {
          ...process.env,
          ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE:
            process.env["ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE"] ?? "0",
        },
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    child.unref();
  } finally {
    await log.close();
  }
}

async function waitForHealthyService(
  dataDirectory: string,
): Promise<LocalServiceRecord> {
  const deadline = Date.now() + serviceStartupTimeoutMilliseconds;
  return waitForHealthyServiceAttempt(dataDirectory, deadline, undefined);
}

async function waitForHealthyServiceAttempt(
  dataDirectory: string,
  deadline: number,
  previous: LocalServiceInspection | undefined,
): Promise<LocalServiceRecord> {
  if (Date.now() >= deadline) {
    const detail = previous?.recordReason
      ?? `record=${previous?.recordState ?? "unknown"}`;
    throw new Error(`The local Artifact Server did not become healthy (${detail}).`);
  }
  const inspected = await inspectManagedLocalService(dataDirectory);
  if (inspected.reachable && inspected.record !== null) return inspected.record;
  await new Promise((resolve) => setTimeout(resolve, 75));
  return waitForHealthyServiceAttempt(dataDirectory, deadline, inspected);
}

async function isHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", origin), {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    return healthResponseSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    return !parsed.success || parsed.data.code !== "ESRCH";
  }
}

function refuseCompetingDatabaseOwner(inspection: LocalServiceInspection): void {
  if (
    inspection.recordState === "valid"
    && inspection.processAlive === true
    && !inspection.reachable
  ) {
    throw new Error(
      "The managed local Artifact Server process is running but is not healthy. Run artifactserver doctor; a second process was not started against the same database.",
    );
  }
}
