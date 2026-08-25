import {createHash, randomBytes, randomUUID} from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const systemErrorSchema = z.object({code: z.string().optional()});
const publicationOperationSchema = z.object({
  createdAt: z.iso.datetime(),
  idempotencyKey: z.string().min(16).max(200),
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  operationScopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  origin: z.url(),
  schemaVersion: z.literal(1),
}).strict();

/** One pending publication that survives a CLI process restart. */
export interface PublicationOperation {
  readonly complete: () => Promise<void>;
  readonly idempotencyKey: string;
}

/**
 * Resume the exact pending publish, or durably create its operation identity
 * before the first network mutation.
 */
export async function resumePublicationOperation(
  dataDirectory: string,
  origin: string,
  operationScopeDigest: string,
  operationDigest: string,
): Promise<PublicationOperation> {
  const operationDirectory = path.join(dataDirectory, "publication-operations");
  const scopeDigest = createHash("sha256")
    .update(JSON.stringify({operationScopeDigest, origin}))
    .digest("hex");
  const operationPath = path.join(operationDirectory, `${scopeDigest}.json`);
  const existing = await readOperation(operationPath);
  if (existing !== null) {
    if (
      existing.origin !== origin
      || existing.operationScopeDigest !== operationScopeDigest
      || existing.operationDigest !== operationDigest
    ) {
      throw new Error(
        "The publication input changed while an earlier attempt is still pending. Restore the original input and retry so Artifact Server can reconcile it without creating a duplicate version.",
      );
    }
    return operation(existing.idempotencyKey, operationPath);
  }

  const created = publicationOperationSchema.parse({
    createdAt: new Date().toISOString(),
    idempotencyKey: randomBytes(24).toString("base64url"),
    operationDigest,
    operationScopeDigest,
    origin,
    schemaVersion: 1,
  });
  await mkdir(operationDirectory, {mode: 0o700, recursive: true});
  await chmod(operationDirectory, 0o700);
  const temporary = `${operationPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeSyncedPrivateFile(temporary, `${JSON.stringify(created, null, 2)}\n`);
  try {
    await link(temporary, operationPath);
    return operation(created.idempotencyKey, operationPath);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
    const raced = await readOperation(operationPath);
    if (
      raced === null
      || raced.origin !== origin
      || raced.operationScopeDigest !== operationScopeDigest
      || raced.operationDigest !== operationDigest
    ) {
      throw new Error(
        "A concurrent publication operation could not be resumed.",
        {cause: error},
      );
    }
    return operation(raced.idempotencyKey, operationPath);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function writeSyncedPrivateFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

function operation(
  idempotencyKey: string,
  operationPath: string,
): PublicationOperation {
  return {
    complete: () => rm(operationPath, {force: true}),
    idempotencyKey,
  };
}

async function readOperation(
  operationPath: string,
): Promise<z.infer<typeof publicationOperationSchema> | null> {
  try {
    const decoded: unknown = JSON.parse(await readFile(operationPath, "utf8"));
    return publicationOperationSchema.parse(decoded);
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    throw error;
  }
}
