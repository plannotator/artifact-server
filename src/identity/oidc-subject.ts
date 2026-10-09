import {Predicate} from "effect";
import type {JWTPayload} from "jose";

/** The claim that names a person when a deployment does not choose one. */
export const defaultOidcSubjectClaim = "sub";

const claimNamePattern = /^[A-Za-z0-9_.:-]+$/u;

/** Validate one configured JWT claim name, or refuse the configuration by name. */
export function requireOidcClaimName(value: string, name: string): string {
  const trimmed = value.trim();
  if (!claimNamePattern.test(trimmed)) {
    throw new Error(`${name} must name one JWT claim, such as sub or oid.`);
  }
  return trimmed;
}

/**
 * Read the configured subject claim from verified token claims.
 *
 * Microsoft Entra ID issues a different `sub` to every app registration, so a
 * deployment can bind people by a claim that stays stable across them, such as
 * `oid`. The value must be a non-blank string; anything else names nobody.
 */
export function oidcSubjectOf(
  claims: JWTPayload,
  claim: string,
): string | null {
  const value = claims[claim];
  if (!Predicate.isString(value) || value.trim() === "") return null;
  return value;
}
