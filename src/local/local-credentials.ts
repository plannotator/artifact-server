import {randomBytes} from "node:crypto";
import {chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

const systemErrorSchema = z.object({code: z.string().optional()});
const localCredentialPattern = /^[A-Za-z0-9_-]{43}$/u;

/** Filenames for the private credentials owned by one local installation. */
export const localCredentialFiles = {
  api: "local-api-token",
  browser: "local-browser-token",
} as const;

/** Read an existing local API credential without changing the file. */
export async function readLocalApiCredential(
  dataDirectory: string,
): Promise<string> {
  const credential = (await readFile(
    path.join(dataDirectory, localCredentialFiles.api),
    "utf8",
  )).trim();
  if (!localCredentialPattern.test(credential)) {
    throw new Error("The local API credential is missing or invalid.");
  }
  return credential;
}

/** Load a private local credential, creating it once when absent. */
export async function loadOrCreateLocalCredential(
  dataDirectory: string,
  filename: (typeof localCredentialFiles)[keyof typeof localCredentialFiles],
): Promise<string> {
  const credentialPath = path.join(dataDirectory, filename);
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  try {
    const credential = (await readFile(credentialPath, "utf8")).trim();
    if (!localCredentialPattern.test(credential)) {
      throw new Error(`The local credential file is invalid: ${credentialPath}`);
    }
    await chmod(credentialPath, 0o600);
    return credential;
  } catch (error) {
    const parsed = systemErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
  }

  const credential = randomBytes(32).toString("base64url");
  await writeFile(credentialPath, `${credential}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(credentialPath, 0o600);
  return credential;
}
