import {membershipRoles, type MembershipRole} from "./identity.js";

/**
 * Issuer group names that admit people to one installation and set their role.
 * Names compare exactly and case-sensitively.
 */
export interface GroupRolePolicy {
  readonly administratorGroups: readonly string[];
  readonly memberGroups: readonly string[];
}

/**
 * Return the role a person's issuer groups grant, or null when no configured
 * group admits them. An administrator group outranks a member group, and a
 * provider that reported no groups admits no one.
 */
export function groupMembershipRole(
  policy: GroupRolePolicy,
  groups: readonly string[] | null,
): MembershipRole | null {
  if (groups === null) return null;
  if (groups.some((group) => policy.administratorGroups.includes(group))) {
    return membershipRoles.administrator;
  }
  if (groups.some((group) => policy.memberGroups.includes(group))) {
    return membershipRoles.member;
  }
  return null;
}
