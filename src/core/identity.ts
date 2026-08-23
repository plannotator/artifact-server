/** Principal kinds recognized by Artifact Server policy. */
export const principalKinds = {
  human: "human",
  service: "service",
} as const;

/** One provider-neutral principal kind. */
export type PrincipalKind =
  (typeof principalKinds)[keyof typeof principalKinds];

/** Standalone installation membership roles. */
export const membershipRoles = {
  administrator: "administrator",
  member: "member",
} as const;

/** One standalone installation membership role. */
export type MembershipRole =
  (typeof membershipRoles)[keyof typeof membershipRoles];

/** Explicit capabilities assignable to API keys and service principals. */
export const principalCapabilities = {
  connectAgents: "agent:connect",
  createArtifact: "artifact:create",
  issueContentSession: "content-session:issue",
  manageAnyArtifact: "artifact:manage:any",
  publishAnyArtifact: "artifact:publish:any",
  readArtifacts: "artifact:read",
  manageProjects: "project:manage",
  writeComments: "comment:write",
} as const;

/** One explicit capability granted to a principal. */
export type PrincipalCapability =
  (typeof principalCapabilities)[keyof typeof principalCapabilities];

/** A credential-independent identity used by every application operation. */
export interface Principal {
  readonly authorizedByPrincipalId: string | null;
  readonly capabilities: readonly PrincipalCapability[];
  /** Name captured with every write this principal makes; never re-read later. */
  readonly displayName: string;
  readonly id: string;
  readonly installationId: string;
  readonly kind: PrincipalKind;
  readonly membershipRole: MembershipRole;
}

/** Determine whether a principal has an explicit capability. */
export function hasCapability(
  principal: Principal,
  capability: PrincipalCapability,
): boolean {
  return principal.capabilities.includes(capability);
}

/** Determine whether a human principal administers the standalone installation. */
export function isHumanAdministrator(principal: Principal): boolean {
  return isDirectHumanPrincipal(principal) &&
    principal.membershipRole === membershipRoles.administrator;
}

/** Determine whether a principal came from a person's interactive session. */
export function isDirectHumanPrincipal(principal: Principal): boolean {
  return principal.kind === principalKinds.human &&
    principal.authorizedByPrincipalId === null;
}
