import {Effect} from "effect";

import {ArtifactNotFound} from "./errors.js";
import {
  isHumanAdministrator,
  principalKinds,
  type Principal,
} from "./identity.js";
import {accessSettings, type ArtifactRecord} from "./model.js";
import type {RestrictedArtifactScope} from "./ports.js";

/**
 * Report whether one principal may see an artifact at all.
 *
 * Only `restricted` artifacts narrow visibility: their owner, through any of
 * the owner's own channels, and installation administrators see them. Service
 * principals never do, whatever their capabilities. Every other access setting
 * leaves the decision to the ordinary capability checks.
 */
export function canSeeArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): boolean {
  if (artifact.accessSetting !== accessSettings.restricted) return true;
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact);
}

/** Fail exactly like a missing artifact when the principal may not see it. */
export function requireArtifactVisible(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): Effect.Effect<void, ArtifactNotFound> {
  return canSeeArtifact(principal, artifact)
    ? Effect.void
    : Effect.fail(new ArtifactNotFound({message: "The artifact does not exist."}));
}

/** Report whether a principal may move an artifact to or from `restricted`. */
export function mayChangeRestriction(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact);
}

/** The restricted artifacts one principal may list. */
export function restrictedArtifactScope(
  principal: Principal,
): RestrictedArtifactScope {
  if (isHumanAdministrator(principal)) return {kind: "all"};
  if (principal.kind === principalKinds.human) {
    return {kind: "owned", principalId: principal.id};
  }
  return {kind: "none"};
}

function ownsArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  // A member-bound API key carries the member's id, so it counts as the owner.
  return principal.kind === principalKinds.human &&
    artifact.ownerPrincipalId !== null &&
    artifact.ownerPrincipalId === principal.id;
}
