import type {
  ApplicationSession,
  InstallationMember,
  LoginAttempt,
  ManagedApiKey,
  StoredManagedApiKey,
} from "./installation-identity.js";

/** Values persisted when admitting one installation member. */
export interface AdmitMemberRecord {
  readonly createdAt: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly installationId: string;
  readonly role: InstallationMember["role"];
}

/** Values persisted when binding one external identity to a member. */
export interface BindExternalIdentityRecord {
  readonly boundAt: string;
  readonly email: string;
  readonly memberId: string;
  readonly provider: string;
  readonly subject: string;
}

/** Values persisted when creating one browser application session. */
export interface CreateApplicationSessionRecord {
  readonly createdAt: string;
  readonly csrfDigest: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly memberId: string;
  readonly tokenDigest: string;
}

/** Persistent identity operations required by the Node application composition. */
export interface IdentityRepository {
  admitMember(command: AdmitMemberRecord): Promise<InstallationMember>;
  bindExternalIdentity(command: BindExternalIdentityRecord): Promise<void>;
  consumeLoginAttempt(
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ): Promise<LoginAttempt>;
  createApiKey(key: StoredManagedApiKey): Promise<ManagedApiKey>;
  createApplicationSession(
    command: CreateApplicationSessionRecord,
  ): Promise<ApplicationSession>;
  createLoginAttempt(attempt: LoginAttempt): Promise<void>;
  deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
  ): Promise<InstallationMember>;
  findActiveMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null>;
  findActiveMemberByExternalIdentity(
    installationId: string,
    provider: string,
    subject: string,
  ): Promise<InstallationMember | null>;
  findApiKey(
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null>;
  findApplicationSession(
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ): Promise<ApplicationSession | null>;
  findMember(
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null>;
  hasMembers(installationId: string): Promise<boolean>;
  listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]>;
  listMembers(installationId: string): Promise<readonly InstallationMember[]>;
  revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
  ): Promise<ManagedApiKey>;
  revokeApplicationSession(
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ): Promise<void>;
  rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
  ): Promise<ManagedApiKey>;
}
