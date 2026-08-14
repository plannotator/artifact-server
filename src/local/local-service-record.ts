import {chmod, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const localServiceRecordSchema = z.object({
  dataDirectory: z.string().min(1),
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  }, "The managed service origin must use loopback HTTP."),
  pid: z.number().int().positive(),
  productVersion: z.string().min(1),
  schemaVersion: z.literal(1),
  startedAt: z.iso.datetime(),
}).strict();
const systemErrorSchema = z.object({code: z.string().optional()});
const errorMessageSchema = z.object({message: z.string()});

/** Non-secret discovery record for one managed local service. */
export type LocalServiceRecord = z.infer<typeof localServiceRecordSchema>;

/** Result of inspecting a local service record without changing it. */
export type LocalServiceRecordInspection =
  | {readonly state: "missing"}
  | {readonly state: "invalid"; readonly reason: string}
  | {readonly state: "valid"; readonly record: LocalServiceRecord};

const serviceRecordFilename = "local-service.json";

/** Return the stable path of the non-secret local service record. */
export function localServiceRecordPath(dataDirectory: string): string {
  return path.join(dataDirectory, serviceRecordFilename);
}

/** Inspect the local service record without repairing or mutating it. */
export async function inspectLocalServiceRecord(
  dataDirectory: string,
): Promise<LocalServiceRecordInspection> {
  try {
    const raw = await readFile(localServiceRecordPath(dataDirectory), "utf8");
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = localServiceRecordSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {reason: z.prettifyError(parsed.error), state: "invalid"};
    }
    if (path.resolve(parsed.data.dataDirectory) !== path.resolve(dataDirectory)) {
      return {
        reason: "The service record belongs to another data directory.",
        state: "invalid",
      };
    }
    return {record: parsed.data, state: "valid"};
  } catch (error) {
    const systemError = systemErrorSchema.safeParse(error);
    if (systemError.success && systemError.data.code === "ENOENT") {
      return {state: "missing"};
    }
    const message = errorMessageSchema.safeParse(error);
    return {
      reason: message.success
        ? message.data.message
        : "The service record is unreadable.",
      state: "invalid",
    };
  }
}

/** Atomically publish a user-only local service record. */
export async function writeLocalServiceRecord(
  dataDirectory: string,
  record: LocalServiceRecord,
): Promise<void> {
  const validated = localServiceRecordSchema.parse(record);
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  const target = localServiceRecordPath(dataDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

/** Remove the record only when it still identifies the calling service. */
export async function removeOwnedLocalServiceRecord(
  dataDirectory: string,
  pid: number,
): Promise<void> {
  const inspected = await inspectLocalServiceRecord(dataDirectory);
  if (inspected.state !== "valid" || inspected.record.pid !== pid) return;
  await rm(localServiceRecordPath(dataDirectory), {force: true});
}
