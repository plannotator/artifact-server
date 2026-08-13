import type {
  MembershipRole,
  PrincipalCapability,
  PrincipalKind,
} from "./identity.js";

/** Installation member lifecycle states. */
export const memberStatuses = {
  active: "active",
  inactive: "inactive",
} as const;

/** One installation member lifecycle state. */
export type MemberStatus =
  (typeof memberStatuses)[keyof typeof memberStatuses];

/** A person explicitly admitted to one Artifact Server installation. */
export interface InstallationMember {
  readonly createdAt: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly installationId: string;
  readonly role: MembershipRole;
  readonly status: MemberStatus;
  readonly updatedAt: string;
}

/** Identity information returned by a configured interactive-login provider. */
export interface ExternalIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly provider: string;
  readonly subject: string;
}

/** One server-side browser session after its opaque credential is verified. */
export interface ApplicationSession {
  readonly createdAt: string;
  readonly csrfDigest: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly member: InstallationMember;
  readonly revokedAt: string | null;
  readonly tokenDigest: string;
}

/** One persisted browser-login attempt. */
export interface LoginAttempt {
  readonly codeVerifier: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly provider: string;
  readonly returnTo: string;
  readonly stateDigest: string;
}

/** Metadata for a managed Artifact Server API key. */
export interface ManagedApiKey {
  readonly authorizedByPrincipalId: string;
  readonly capabilities: readonly PrincipalCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
}

/** Managed-key metadata plus its stored secret digest. */
export interface StoredManagedApiKey extends ManagedApiKey {
  readonly secretDigest: string;
}

/** An application session credential returned once to the browser adapter. */
export interface IssuedApplicationSession {
  readonly csrfToken: string;
  readonly session: ApplicationSession;
  readonly token: string;
}

/** A managed API key credential returned exactly once. */
export interface IssuedManagedApiKey {
  readonly apiKey: ManagedApiKey;
  readonly token: string;
}
