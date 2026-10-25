import {type Redacted, Schema} from "effect";
import {z} from "zod";

import {
  defaultOidcGroupsClaim,
  type OidcGroupRoles,
} from "../identity/oidc-groups-claim.js";
import {defaultOidcScopes} from "../identity/oidc-identity-provider.js";
import {keycloakAdminBaseUrl} from "../identity/keycloak-directory.js";
import {requireOidcIssuer} from "../identity/oidc-issuer.js";
import {
  loadOptionalCredential,
  type LoadedSecret,
} from "../lifecycle/runtime-configuration.js";
import {runCliEffect} from "./run-cli-effect.js";

const oidcEnvironmentSchema = z.object({
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_CLIENT_ID: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_GROUPS_CLAIM: z.string().trim().min(1).optional(),
  ARTIFACT_SERVER_OIDC_ISSUER: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: z.string().min(1).optional(),
  ARTIFACT_SERVER_OIDC_SCOPES: z.string().min(1).optional(),
  ARTIFACT_SERVER_ORIGIN: z.url().optional(),
});

/** A directory that lists group members before they ever sign in. */
export interface OidcDirectoryConfiguration {
  /** Admin REST base derived from the realm issuer. */
  readonly adminBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly provider: "keycloak";
}

/** Complete optional generic OIDC browser-login configuration. */
export interface OidcConfiguration {
  readonly applicationOrigin: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  /** Directory sync settings; null when the directory is not synced. */
  readonly directory: OidcDirectoryConfiguration | null;
  /** Issuer groups that admit people and set their role; null keeps it manual. */
  readonly groupRoles: OidcGroupRoles | null;
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
  const directorySecret = await runCliEffect(loadOptionalCredential(
    environment,
    "ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET",
    Schema.NonEmptyString,
  ));
  if (
    clientSecret === null &&
    directorySecret === null &&
    parsed.ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_CLIENT_ID === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_ISSUER === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_SCOPES === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_GROUPS_CLAIM === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_MEMBER_GROUPS === undefined &&
    parsed.ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS === undefined
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
  const issuer = requireOidcIssuer(
    requireString(parsed.ARTIFACT_SERVER_OIDC_ISSUER),
    "ARTIFACT_SERVER_OIDC_ISSUER",
  );
  const groupRoles = oidcGroupRoles(parsed);
  return {
    applicationOrigin: requireString(parsed.ARTIFACT_SERVER_ORIGIN),
    bootstrapAdministratorEmail: requireString(
      parsed.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    ),
    clientId: requireString(parsed.ARTIFACT_SERVER_OIDC_CLIENT_ID),
    clientSecret: credentialOrNull(clientSecret),
    directory: oidcDirectory(
      parsed,
      credentialOrNull(directorySecret),
      issuer,
      groupRoles,
    ),
    groupRoles,
    issuer,
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

/** Read the opt-in group roles; with no group list set, admission stays manual. */
function oidcGroupRoles(
  parsed: z.infer<typeof oidcEnvironmentSchema>,
): OidcGroupRoles | null {
  const memberGroups = groupNames(
    "ARTIFACT_SERVER_OIDC_MEMBER_GROUPS",
    parsed.ARTIFACT_SERVER_OIDC_MEMBER_GROUPS,
  );
  const administratorGroups = groupNames(
    "ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS",
    parsed.ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS,
  );
  if (memberGroups.length === 0 && administratorGroups.length === 0) {
    if (parsed.ARTIFACT_SERVER_OIDC_GROUPS_CLAIM !== undefined) {
      throw new Error(
        "ARTIFACT_SERVER_OIDC_GROUPS_CLAIM requires ARTIFACT_SERVER_OIDC_MEMBER_GROUPS or ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS.",
      );
    }
    return null;
  }
  return {
    administratorGroups,
    claim: parsed.ARTIFACT_SERVER_OIDC_GROUPS_CLAIM ?? defaultOidcGroupsClaim,
    memberGroups,
  };
}

/** Read the opt-in directory sync, which only group roles can give meaning. */
function oidcDirectory(
  parsed: z.infer<typeof oidcEnvironmentSchema>,
  clientSecret: Redacted.Redacted | null,
  issuer: string,
  groupRoles: OidcGroupRoles | null,
): OidcDirectoryConfiguration | null {
  const provider = parsed.ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER;
  const clientId = parsed.ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID;
  if (provider === undefined && clientId === undefined && clientSecret === null) {
    return null;
  }
  if (groupRoles === null) {
    throw new Error(
      "The ARTIFACT_SERVER_OIDC_DIRECTORY_* settings require ARTIFACT_SERVER_OIDC_MEMBER_GROUPS or ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS.",
    );
  }
  if (provider === undefined || clientId === undefined || clientSecret === null) {
    throw new Error(
      "Directory sync requires ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER, ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID, and ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET or ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET_FILE.",
    );
  }
  if (provider !== "keycloak") {
    throw new Error(
      "ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER supports only keycloak.",
    );
  }
  const adminBaseUrl = keycloakAdminBaseUrl(issuer);
  if (adminBaseUrl === null) {
    throw new Error(
      "Keycloak directory sync requires ARTIFACT_SERVER_OIDC_ISSUER in the form <base>/realms/<realm>.",
    );
  }
  return {adminBaseUrl, clientId, clientSecret, provider};
}

/** Split one comma-separated list of exact, case-sensitive group names. */
function groupNames(name: string, value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  const groups = [...new Set(
    value.split(",").map((group) => group.trim()).filter((group) => group !== ""),
  )];
  if (groups.length === 0) {
    throw new Error(`${name} must name at least one group.`);
  }
  return groups;
}

function credentialOrNull(value: LoadedSecret | null): Redacted.Redacted | null {
  return value === null ? null : value.value;
}

function requireString(value: string | undefined): string {
  if (value === undefined) throw new Error("A required OIDC value is missing.");
  return value;
}
