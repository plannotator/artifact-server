import {type Redacted, Schema} from "effect";
import {z} from "zod";

import {
  loadOptionalCredential,
  type LoadedSecret,
} from "../lifecycle/runtime-configuration.js";
import {runCliEffect} from "./run-cli-effect.js";

const workOsEnvironmentSchema = z.object({
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  ARTIFACT_SERVER_ORIGIN: z.url().optional(),
  ARTIFACT_SERVER_WORKOS_CLIENT_ID: z.string().min(1).optional(),
});

/** Complete optional WorkOS browser-login configuration. */
export interface WorkOsConfiguration {
  readonly apiKey: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clientId: string;
}

/** Load all-or-nothing WorkOS settings, including a file-backed API key. */
export async function loadWorkOsConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<WorkOsConfiguration | null> {
  const parsed = workOsEnvironmentSchema.parse(environment);
  const apiKey = await runCliEffect(loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_WORKOS_API_KEY",
    Schema.NonEmptyString,
  ));
  if (apiKey === null && parsed.ARTIFACT_SERVER_WORKOS_CLIENT_ID === undefined) {
    return null;
  }
  const requiredValues = [
    parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    parsed.ARTIFACT_SERVER_ORIGIN,
    apiKey,
    parsed.ARTIFACT_SERVER_WORKOS_CLIENT_ID,
  ];
  if (requiredValues.some((value) => value === undefined || value === null)) {
    throw new Error(
      "WorkOS login requires ARTIFACT_SERVER_ORIGIN, ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL, ARTIFACT_SERVER_WORKOS_API_KEY or ARTIFACT_SERVER_WORKOS_API_KEY_FILE, and ARTIFACT_SERVER_WORKOS_CLIENT_ID.",
    );
  }
  return {
    apiKey: requireCredential(apiKey),
    applicationOrigin: requireString(parsed.ARTIFACT_SERVER_ORIGIN),
    bootstrapAdministratorEmail: requireString(
      parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    ),
    clientId: requireString(parsed.ARTIFACT_SERVER_WORKOS_CLIENT_ID),
  };
}

function requireCredential(value: LoadedSecret | null): Redacted.Redacted {
  if (value === null) throw new Error("A required WorkOS value is missing.");
  return value.value;
}

function requireString(value: string | undefined): string {
  if (value === undefined) throw new Error("A required WorkOS value is missing.");
  return value;
}
