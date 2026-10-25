import type {JWTPayload} from "jose";
import {Effect, Schema} from "effect";

import {IdentityProviderFailure} from "../core/errors.js";
import type {GroupRolePolicy} from "../core/group-role-policy.js";

/** Claim read when an operator enables group roles without naming one. */
export const defaultOidcGroupsClaim = "groups";

/** Generic OIDC group roles: the claim to read and the groups it must name. */
export interface OidcGroupRoles extends GroupRolePolicy {
  readonly claim: string;
}

const decodeGroupNames = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

/**
 * Read one configured groups claim from claims the issuer vouched for. No
 * configured claim, or a claim the issuer left out, reads as null; a claim in
 * any shape other than a list of strings is a provider failure.
 */
export const readOidcGroupsClaim = Effect.fnUntraced(function*(
  claims: JWTPayload,
  claim: string | null,
): Effect.fn.Return<readonly string[] | null, IdentityProviderFailure> {
  if (claim === null || !Object.hasOwn(claims, claim)) return null;
  return yield* decodeGroupNames(claims[claim]).pipe(
    Effect.mapError(() => new IdentityProviderFailure({
      message: `The OIDC ${claim} claim is not a list of group names.`,
    })),
  );
});
