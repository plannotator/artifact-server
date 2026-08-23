import {type Redacted, Schema} from "effect";
import {z} from "zod";

import {defaultOidcScopes} from "../identity/oidc-identity-provider.js";
import {requireOidcIssuer} from "../identity/oidc-issuer.js";
import {
  loadOptionalCredential,
  type LoadedSecret,
} from "../lifecycle/runtime-configuration.js";
import {runCliEffect} from "./run-cli-effect.js";

const oidcEnvironmentSchema = z.object({
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  ARTIFACT_SERVER_OIDC_CLIENT_ID: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_ISSUER: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_SCOPES: z.string().min(1).optional(),
  ARTIFACT_SERVER_ORIGIN: z.url().optional(),
});

/** Complete optional generic OIDC browser-login configuration. */
export interface OidcConfiguration {
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  readonly issuer: string;
  readonly scopes: string;
}

/** Load all-or-nothing OIDC settings, including a file-backed client secret. */
export async function loadOidcConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<OidcConfiguration | null> {
  const parsed = oidcEnvironmentSchema.parse(environment);
  const clientSecret = await runCliEffect(loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_OIDC_CLIENT_SECRET",
    Schema.NonEmptyString,
  ));
  if (
    clientSecret === null &&
    parsed.ARTIFACT_SERVER_OIDC_CLIENT_ID === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_ISSUER === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_SCOPES === undefined
  ) {
    return null;
  }
  const requiredValues = [
    parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    parsed.ARTIFACT_SERVER_ORIGIN,
    parsed.ARTIFACT_SERVER_OIDC_CLIENT_ID,
    parsed.ARTIFACT_SERVER_OIDC_ISSUER,
  ];
  if (requiredValues.some((value) => value === undefined)) {
    throw new Error(
      "Generic OIDC authentication requires ARTIFACT_SERVER_ORIGIN, ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL, ARTIFACT_SERVER_OIDC_ISSUER, and ARTIFACT_SERVER_OIDC_CLIENT_ID. ARTIFACT_SERVER_OIDC_CLIENT_SECRET or ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE and ARTIFACT_SERVER_OIDC_SCOPES are optional.",
    );
  }
  return {
    applicationOrigin: requireString(parsed.ARTIFACT_SERVER_ORIGIN),
    bootstrapAdministratorEmail: requireString(
      parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    ),
    clientId: requireString(parsed.ARTIFACT_SERVER_OIDC_CLIENT_ID),
    clientSecret: credentialOrNull(clientSecret),
    issuer: requireOidcIssuer(
      requireString(parsed.ARTIFACT_SERVER_OIDC_ISSUER),
      "ARTIFACT_SERVER_OIDC_ISSUER",
    ),
    scopes: parsed.ARTIFACT_SERVER_OIDC_SCOPES ?? defaultOidcScopes,
  };
}

/**
 * Refuse an installation that configures WorkOS and generic OIDC together.
 *
 * Presence of any variable in either family selects that provider, matching the
 * Cloudflare worker guard: a leftover `ARTIFACT_SERVER_WORKOS_ISSUER` beside a
 * complete OIDC family must fail startup rather than boot silently on OIDC.
 */
export function assertAtMostOneBrowserLoginProvider(
  environment: NodeJS.ProcessEnv,
): void {
  if (
    !hasBrowserLoginVariable(environment, "ARTIFACT_SERVER_WORKOS_") ||
    !hasBrowserLoginVariable(environment, "ARTIFACT_SERVER_OIDC_")
  ) {
    return;
  }
  throw new Error(
    "One installation has one browser-login provider: configure ARTIFACT_SERVER_WORKOS_* or ARTIFACT_SERVER_OIDC_*, not both.",
  );
}

function hasBrowserLoginVariable(
  environment: NodeJS.ProcessEnv,
  prefix: string,
): boolean {
  return Object.entries(environment).some(([name, value]) =>
    name.startsWith(prefix) && value !== undefined && value.trim() !== ""
  );
}

function credentialOrNull(value: LoadedSecret | null): Redacted.Redacted | null {
  return value === null ? null : value.value;
}

function requireString(value: string | undefined): string {
  if (value === undefined) throw new Error("A required OIDC value is missing.");
  return value;
}
