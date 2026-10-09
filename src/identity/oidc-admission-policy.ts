import {z} from "zod";

import type {ExternalIdentityAdmissionPolicy} from
  "../core/installation-identity.js";
import {requireOidcIssuer} from "./oidc-issuer.js";

const autoAdmitSchema = z.enum(["true", "false"]);
const emailDomainSchema = z.string().max(253).regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u,
);

/** Validate operator settings for browser-only OIDC member admission. */
export function parseOidcAdmissionPolicy(
  issuer: string,
  autoAdmit: string | undefined,
  allowedEmailDomains: string | undefined,
): ExternalIdentityAdmissionPolicy | null {
  const enabled = autoAdmitSchema.safeParse(autoAdmit ?? "false");
  if (!enabled.success) {
    throw new Error("ARTIFACT_SERVER_OIDC_AUTO_ADMIT must be exactly true or false.");
  }
  const domains = allowedEmailDomains === undefined ||
      allowedEmailDomains.trim() === ""
    ? []
    : allowedEmailDomains.split(",").map((domain) => domain.trim().toLowerCase());
  if (domains.some((domain) => !emailDomainSchema.safeParse(domain).success)) {
    throw new Error(
      "ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS must contain comma-separated exact hostnames without wildcards.",
    );
  }
  if (enabled.data === "false") return null;
  return {
    allowedEmailDomains: domains,
    provider: `oidc:${requireOidcIssuer(issuer, "ARTIFACT_SERVER_OIDC_ISSUER")}`,
  };
}
