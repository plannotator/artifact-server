import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { z } from "zod";

import {
  IdentityConflict,
  IdentityNotFound,
  LoginAttemptRejected,
} from "../core/errors.js";
import {
  type ApplicationSession,
  type InstallationMember,
  type LoginAttempt,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../core/identity.js";
import type {
  AdmitMemberRecord,
  BindExternalIdentityRecord,
  CreateApplicationSessionRecord,
  IdentityRepository,
} from "../core/identity-ports.js";

const membershipRoleSchema = z.enum([
  membershipRoles.administrator,
  membershipRoles.member,
]);
const memberStatusSchema = z.enum([
  memberStatuses.active,
  memberStatuses.inactive,
]);
const principalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);
const principalCapabilitySchema = z.enum([
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageOwnedArtifact,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.publishOwnedArtifact,
  principalCapabilities.readArtifacts,
]);
const memberRowSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: memberStatusSchema,
  updatedAt: z.string(),
});
const sessionRowSchema = z.object({
  createdAt: z.string(),
  csrfDigest: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  memberCreatedAt: z.string(),
  memberDisplayName: z.string(),
  memberEmail: z.string(),
  memberId: z.string(),
  memberRole: membershipRoleSchema,
  memberStatus: memberStatusSchema,
  memberUpdatedAt: z.string(),
  revokedAt: z.string().nullable(),
  tokenDigest: z.string(),
});
const apiKeyRowSchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilitiesJson: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
  secretDigest: z.string(),
});
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  provider: z.string(),
  returnTo: z.string(),
  stateDigest: z.string(),
});
const presenceRowSchema = z.object({present: z.union([z.literal(0), z.literal(1)])});
const countRowSchema = z.object({count: z.number().int().nonnegative()});

/** SQLite persistence for installation membership, sessions, and API keys. */
export class SqliteIdentityRepository implements IdentityRepository {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.enableDefensive(true);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA synchronous = FULL;");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  async hasMembers(installationId: string): Promise<boolean> {
    const row = this.#database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM installation_members WHERE installation_id = ?
      ) AS present
    `).get(installationId);
    return presenceRowSchema.parse(row).present === 1;
  }

  async admitMember(command: AdmitMemberRecord): Promise<InstallationMember> {
    try {
      this.#database.prepare(`
        INSERT INTO installation_members (
          id, installation_id, email, display_name, role, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.id,
        command.installationId,
        command.email,
        command.displayName,
        command.role,
        memberStatuses.active,
        command.createdAt,
        command.createdAt,
      );
    } catch (cause) {
      if (isSqliteConstraint(cause)) {
        throw new IdentityConflict({
          message: "That email is already admitted to this installation.",
        });
      }
      throw cause;
    }
    const member = await this.findMember(command.installationId, command.id);
    if (member === null) throw new Error("The admitted member was not persisted.");
    return member;
  }

  async listMembers(installationId: string): Promise<readonly InstallationMember[]> {
    const rows = this.#database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        email,
        display_name AS displayName,
        role,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM installation_members
      WHERE installation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(installationId);
    return rows.map((row) => memberRowSchema.parse(row));
  }

  async findMember(
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null> {
    return this.#findMember(installationId, memberId);
  }

  #findMember(
    installationId: string,
    memberId: string,
  ): InstallationMember | null {
    const row = this.#database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        email,
        display_name AS displayName,
        role,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM installation_members
      WHERE installation_id = ? AND id = ?
    `).get(installationId, memberId);
    return row === undefined ? null : memberRowSchema.parse(row);
  }

  async findActiveMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null> {
    const row = this.#database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        email,
        display_name AS displayName,
        role,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM installation_members
      WHERE installation_id = ? AND email = ? AND status = ?
    `).get(installationId, email, memberStatuses.active);
    return row === undefined ? null : memberRowSchema.parse(row);
  }

  async findActiveMemberByExternalIdentity(
    installationId: string,
    provider: string,
    subject: string,
  ): Promise<InstallationMember | null> {
    const row = this.#database.prepare(`
      SELECT
        member.id,
        member.installation_id AS installationId,
        member.email,
        member.display_name AS displayName,
        member.role,
        member.status,
        member.created_at AS createdAt,
        member.updated_at AS updatedAt
      FROM external_identities AS external
      JOIN installation_members AS member ON member.id = external.member_id
      WHERE
        member.installation_id = ? AND external.provider = ? AND
        external.subject = ? AND member.status = ?
    `).get(installationId, provider, subject, memberStatuses.active);
    return row === undefined ? null : memberRowSchema.parse(row);
  }

  async bindExternalIdentity(command: BindExternalIdentityRecord): Promise<void> {
    try {
      const result = this.#database.prepare(`
        INSERT INTO external_identities (
          provider, subject, member_id, email, bound_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET
          email = excluded.email,
          bound_at = excluded.bound_at
        WHERE external_identities.member_id = excluded.member_id
      `).run(
        command.provider,
        command.subject,
        command.memberId,
        command.email,
        command.boundAt,
      );
      if (result.changes !== 1) {
        throw new IdentityConflict({
          message: "That external identity is already bound to another member.",
        });
      }
    } catch (cause) {
      if (isSqliteConstraint(cause)) {
        throw new IdentityConflict({
          message: "That external identity is already bound to another member.",
        });
      }
      throw cause;
    }
  }

  async deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
  ): Promise<InstallationMember> {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.#findMember(installationId, memberId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The member does not exist."});
      }
      if (
        existing.status === memberStatuses.active &&
        existing.role === membershipRoles.administrator
      ) {
        const activeAdministratorCount = countRowSchema.parse(
          this.#database.prepare(`
          SELECT COUNT(*) AS count
          FROM installation_members
          WHERE installation_id = ? AND role = ? AND status = ?
          `).get(
            installationId,
            membershipRoles.administrator,
            memberStatuses.active,
          ),
        );
        if (activeAdministratorCount.count <= 1) {
          throw new IdentityConflict({
            message: "The installation must retain one active administrator.",
          });
        }
      }
      this.#database.prepare(`
        UPDATE installation_members
        SET status = ?, updated_at = ?
        WHERE installation_id = ? AND id = ?
      `).run(memberStatuses.inactive, updatedAt, installationId, memberId);
      this.#database.prepare(`
        UPDATE application_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND member_id = ?
      `).run(updatedAt, installationId, memberId);
      this.#database.prepare(`
        UPDATE managed_api_keys
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE
          installation_id = ? AND principal_kind = ? AND principal_id = ?
      `).run(updatedAt, installationId, principalKinds.human, memberId);
      this.#database.exec("COMMIT;");
      return {...existing, status: memberStatuses.inactive, updatedAt};
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }

  async createApplicationSession(
    command: CreateApplicationSessionRecord,
  ): Promise<ApplicationSession> {
    this.#database.prepare(`
      INSERT INTO application_sessions (
        id, installation_id, member_id, token_digest, csrf_digest,
        created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      command.id,
      command.installationId,
      command.memberId,
      command.tokenDigest,
      command.csrfDigest,
      command.createdAt,
      command.expiresAt,
    );
    const session = await this.findApplicationSession(
      command.installationId,
      command.tokenDigest,
      command.createdAt,
    );
    if (session === null) throw new Error("The application session was not persisted.");
    return session;
  }

  async findApplicationSession(
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ): Promise<ApplicationSession | null> {
    const row = this.#database.prepare(`
      SELECT
        session.id,
        session.installation_id AS installationId,
        session.token_digest AS tokenDigest,
        session.csrf_digest AS csrfDigest,
        session.created_at AS createdAt,
        session.expires_at AS expiresAt,
        session.revoked_at AS revokedAt,
        member.id AS memberId,
        member.email AS memberEmail,
        member.display_name AS memberDisplayName,
        member.role AS memberRole,
        member.status AS memberStatus,
        member.created_at AS memberCreatedAt,
        member.updated_at AS memberUpdatedAt
      FROM application_sessions AS session
      JOIN installation_members AS member ON member.id = session.member_id
      WHERE
        session.installation_id = ? AND session.token_digest = ? AND
        session.revoked_at IS NULL AND session.expires_at > ? AND
        member.status = ?
    `).get(
      installationId,
      tokenDigest,
      requestTime,
      memberStatuses.active,
    );
    if (row === undefined) return null;
    const parsed = sessionRowSchema.parse(row);
    return {
      createdAt: parsed.createdAt,
      csrfDigest: parsed.csrfDigest,
      expiresAt: parsed.expiresAt,
      id: parsed.id,
      installationId: parsed.installationId,
      member: {
        createdAt: parsed.memberCreatedAt,
        displayName: parsed.memberDisplayName,
        email: parsed.memberEmail,
        id: parsed.memberId,
        installationId: parsed.installationId,
        role: parsed.memberRole,
        status: parsed.memberStatus,
        updatedAt: parsed.memberUpdatedAt,
      },
      revokedAt: parsed.revokedAt,
      tokenDigest: parsed.tokenDigest,
    };
  }

  async revokeApplicationSession(
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ): Promise<void> {
    this.#database.prepare(`
      UPDATE application_sessions
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE installation_id = ? AND token_digest = ?
    `).run(revokedAt, installationId, tokenDigest);
  }

  async createApiKey(key: StoredManagedApiKey): Promise<ManagedApiKey> {
    this.#insertApiKey(key);
    return withoutSecretDigest(key);
  }

  async findApiKey(
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null> {
    return this.#findApiKey(installationId, keyId);
  }

  #findApiKey(
    installationId: string,
    keyId: string,
  ): StoredManagedApiKey | null {
    const row = this.#database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        name,
        prefix,
        secret_digest AS secretDigest,
        principal_id AS principalId,
        principal_kind AS principalKind,
        capabilities_json AS capabilitiesJson,
        authorized_by_principal_id AS authorizedByPrincipalId,
        created_at AS createdAt,
        expires_at AS expiresAt,
        revoked_at AS revokedAt,
        rotated_from_id AS rotatedFromId
      FROM managed_api_keys
      WHERE installation_id = ? AND id = ?
    `).get(installationId, keyId);
    return row === undefined ? null : parseApiKey(row);
  }

  async listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]> {
    const rows = this.#database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        name,
        prefix,
        secret_digest AS secretDigest,
        principal_id AS principalId,
        principal_kind AS principalKind,
        capabilities_json AS capabilitiesJson,
        authorized_by_principal_id AS authorizedByPrincipalId,
        created_at AS createdAt,
        expires_at AS expiresAt,
        revoked_at AS revokedAt,
        rotated_from_id AS rotatedFromId
      FROM managed_api_keys
      WHERE installation_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(installationId);
    return rows.map((row) => withoutSecretDigest(parseApiKey(row)));
  }

  async revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
  ): Promise<ManagedApiKey> {
    const result = this.#database.prepare(`
      UPDATE managed_api_keys
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE installation_id = ? AND id = ?
    `).run(revokedAt, installationId, keyId);
    if (result.changes !== 1) {
      throw new IdentityNotFound({message: "The API key does not exist."});
    }
    const key = await this.findApiKey(installationId, keyId);
    if (key === null) throw new Error("The revoked API key disappeared.");
    return withoutSecretDigest(key);
  }

  async rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
  ): Promise<ManagedApiKey> {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.#database.prepare(`
        UPDATE managed_api_keys
        SET revoked_at = ?
        WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
      `).run(revokedAt, installationId, previousKeyId);
      if (result.changes !== 1) {
        const existing = this.#findApiKey(installationId, previousKeyId);
        if (existing === null) {
          throw new IdentityNotFound({message: "The API key does not exist."});
        }
        throw new IdentityConflict({
          message: "A revoked API key cannot be rotated.",
        });
      }
      this.#insertApiKey(replacement);
      this.#database.exec("COMMIT;");
      return withoutSecretDigest(replacement);
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }

  async createLoginAttempt(attempt: LoginAttempt): Promise<void> {
    this.#database.prepare(`
      INSERT INTO login_attempts (
        state_digest, provider, code_verifier, return_to, created_at,
        expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      attempt.stateDigest,
      attempt.provider,
      attempt.codeVerifier,
      attempt.returnTo,
      attempt.createdAt,
      attempt.expiresAt,
    );
  }

  async consumeLoginAttempt(
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ): Promise<LoginAttempt> {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database.prepare(`
        SELECT
          state_digest AS stateDigest,
          provider,
          code_verifier AS codeVerifier,
          return_to AS returnTo,
          created_at AS createdAt,
          expires_at AS expiresAt
        FROM login_attempts
        WHERE
          state_digest = ? AND provider = ? AND consumed_at IS NULL AND
          expires_at > ?
      `).get(stateDigest, provider, consumedAt);
      if (row === undefined) {
        throw new LoginAttemptRejected({
          message: "The browser login attempt is invalid or no longer active.",
        });
      }
      const result = this.#database.prepare(`
        UPDATE login_attempts SET consumed_at = ?
        WHERE state_digest = ? AND consumed_at IS NULL
      `).run(consumedAt, stateDigest);
      if (result.changes !== 1) {
        throw new LoginAttemptRejected({
          message: "The browser login attempt was already used.",
        });
      }
      this.#database.exec("COMMIT;");
      return loginAttemptRowSchema.parse(row);
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }

  #insertApiKey(key: StoredManagedApiKey): void {
    this.#database.prepare(`
      INSERT INTO managed_api_keys (
        id, installation_id, name, prefix, secret_digest, principal_id,
        principal_kind, capabilities_json, authorized_by_principal_id,
        created_at, expires_at, revoked_at, rotated_from_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key.id,
      key.installationId,
      key.name,
      key.prefix,
      key.secretDigest,
      key.principalId,
      key.principalKind,
      JSON.stringify(key.capabilities),
      key.authorizedByPrincipalId,
      key.createdAt,
      key.expiresAt,
      key.revokedAt,
      key.rotatedFromId,
    );
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS installation_members (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (installation_id, email)
      );

      CREATE TABLE IF NOT EXISTS external_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES installation_members(id),
        email TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (provider, subject),
        UNIQUE (provider, member_id)
      );

      CREATE TABLE IF NOT EXISTS application_sessions (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES installation_members(id),
        token_digest TEXT NOT NULL UNIQUE,
        csrf_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS application_sessions_member_idx
        ON application_sessions(installation_id, member_id);

      CREATE TABLE IF NOT EXISTS managed_api_keys (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        secret_digest TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_kind TEXT NOT NULL CHECK (principal_kind IN ('human', 'service')),
        capabilities_json TEXT NOT NULL,
        authorized_by_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        rotated_from_id TEXT REFERENCES managed_api_keys(id),
        UNIQUE (installation_id, prefix)
      );

      CREATE TABLE IF NOT EXISTS login_attempts (
        state_digest TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        return_to TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
    `);
  }
}

function parseApiKey(
  input: Readonly<Record<string, SQLOutputValue>>,
): StoredManagedApiKey {
  const row = apiKeyRowSchema.parse(input);
  const capabilities = z.array(principalCapabilitySchema).parse(
    JSON.parse(row.capabilitiesJson),
  );
  return {
    authorizedByPrincipalId: row.authorizedByPrincipalId,
    capabilities,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    prefix: row.prefix,
    principalId: row.principalId,
    principalKind: row.principalKind,
    revokedAt: row.revokedAt,
    rotatedFromId: row.rotatedFromId,
    secretDigest: row.secretDigest,
  };
}

function withoutSecretDigest(key: StoredManagedApiKey): ManagedApiKey {
  const {secretDigest: _secretDigest, ...metadata} = key;
  return metadata;
}

function isSqliteConstraint(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("constraint failed");
}
