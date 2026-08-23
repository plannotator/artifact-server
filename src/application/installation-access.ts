import { createHash, timingSafeEqual } from "node:crypto";

import { Context, Effect, Layer, Redacted } from "effect";

import type { AuthenticatedApplicationSession } from "./authentication.js";
import {
  AuthenticationCache,
  type AuthenticationCachePolicy,
  defaultAuthenticationCachePolicy,
} from "./authentication-cache.js";
import {
  AuthenticationRequired,
  AuthorizationDenied,
  IdentityAdmissionDenied,
  IdentityConflict,
  IdentityNotFound,
} from "../core/errors.js";
import type {
  IdentityRepositoryFailure,
  LoginAttemptRejected,
} from "../core/errors.js";
import {
  type ApplicationSession,
  type ExternalIdentity,
  type InstallationMember,
  type IssuedApplicationSession,
  type IssuedManagedApiKey,
  type LoginAttempt,
  managedApiKeyCredentialPattern,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  isHumanAdministrator,
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type MembershipRole,
  type Principal,
  type PrincipalCapability,
} from "../core/identity.js";

const allCapabilities = Object.values(principalCapabilities);
const localBrowserLoginProvider = "artifact-server-local";

export interface InstallationIdentityRepository {
  readonly admitMember: (
    command: {
      readonly createdAt: string;
      readonly displayName: string;
      readonly email: string;
      readonly id: string;
      readonly installationId: string;
      readonly role: MembershipRole;
    },
  ) => Effect.Effect<InstallationMember, IdentityConflict | IdentityRepositoryFailure>;
  readonly bindExternalIdentity: (
    command: {
      readonly boundAt: string;
      readonly email: string;
      readonly memberId: string;
      readonly provider: string;
      readonly subject: string;
    },
  ) => Effect.Effect<void, IdentityConflict | IdentityRepositoryFailure>;
  readonly createApiKey: (
    key: StoredManagedApiKey,
  ) => Effect.Effect<ManagedApiKey, IdentityRepositoryFailure>;
  readonly createApplicationSession: (
    command: {
      readonly createdAt: string;
      readonly csrfDigest: string;
      readonly expiresAt: string;
      readonly id: string;
      readonly installationId: string;
      readonly memberId: string;
      readonly tokenDigest: string;
    },
  ) => Effect.Effect<ApplicationSession, IdentityRepositoryFailure>;
  readonly consumeLoginAttempt: (
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ) => Effect.Effect<
    LoginAttempt,
    LoginAttemptRejected | IdentityRepositoryFailure
  >;
  readonly createLoginAttempt: (
    attempt: LoginAttempt,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly deactivateMember: (
    installationId: string,
    memberId: string,
    updatedAt: string,
  ) => Effect.Effect<
    InstallationMember,
    IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly findActiveMemberByEmail: (
    installationId: string,
    email: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly findActiveMemberByExternalIdentity: (
    installationId: string,
    provider: string,
    subject: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly findMember: (
    installationId: string,
    memberId: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly findApiKey: (
    installationId: string,
    keyId: string,
  ) => Effect.Effect<StoredManagedApiKey | null, IdentityRepositoryFailure>;
  readonly findApplicationSession: (
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ) => Effect.Effect<ApplicationSession | null, IdentityRepositoryFailure>;
  readonly hasMembers: (
    installationId: string,
  ) => Effect.Effect<boolean, IdentityRepositoryFailure>;
  readonly listApiKeys: (
    installationId: string,
  ) => Effect.Effect<readonly ManagedApiKey[], IdentityRepositoryFailure>;
  readonly listMembers: (
    installationId: string,
  ) => Effect.Effect<readonly InstallationMember[], IdentityRepositoryFailure>;
  readonly revokeApiKey: (
    installationId: string,
    keyId: string,
    revokedAt: string,
  ) => Effect.Effect<ManagedApiKey, IdentityNotFound | IdentityRepositoryFailure>;
  readonly revokeApplicationSession: (
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly rotateApiKey: (
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
  ) => Effect.Effect<
    ManagedApiKey,
    IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
}

export interface IdentitySecretProvider {
  readonly digest: (value: string) => string;
  readonly issue: () => string;
}

export interface IdentityIdProvider {
  readonly apiKeyId: () => string;
  readonly memberId: () => string;
  readonly sessionId: () => string;
}

export interface InstallationAccessDependencies {
  /**
   * Bounded-staleness cache policy for successful session and managed-key
   * authentication, keyed by installation and credential digest. Omit it to
   * apply {@link defaultAuthenticationCachePolicy}; pass `null` to disable
   * caching. Only successes are cached, entries never outlive the credential's
   * own expiry, and local revocation paths evict, so a credential revoked in
   * another process may authenticate here for at most the TTL.
   */
  readonly authenticationCache?: AuthenticationCachePolicy | null;
  readonly bootstrapAdministratorEmail: string;
  readonly clock: {readonly now: () => Date};
  readonly ids: IdentityIdProvider;
  readonly installationId: string;
  readonly localBootstrapCredential: Redacted.Redacted | null;
  readonly localLoginAttemptLifetimeMilliseconds: number;
  /** Keep the installation's local-owner member permanently active. */
  readonly protectBootstrapAdministrator: boolean;
  readonly repository: InstallationIdentityRepository;
  readonly secrets: IdentitySecretProvider;
  readonly sessionLifetimeMilliseconds: number;
}

export interface AdmitMemberCommand {
  readonly displayName: string;
  readonly email: string;
  readonly principal: Principal;
  readonly role: MembershipRole;
}

export interface IssueApiKeyCommand {
  readonly capabilities: readonly PrincipalCapability[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
  readonly principal: Principal;
}

/** One short-lived credential intended for a single local browser navigation. */
export interface IssuedLocalBrowserLogin {
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
}

export interface InstallationAccessOperations {
  readonly admitMember: (
    command: AdmitMemberCommand,
  ) => Effect.Effect<
    InstallationMember,
    AuthorizationDenied | IdentityConflict | IdentityRepositoryFailure
  >;
  readonly authenticateManagedApiKey: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationRequired | IdentityRepositoryFailure>;
  readonly authenticateExternalIdentity: (
    identity: ExternalIdentity,
  ) => Effect.Effect<
    Principal,
    IdentityAdmissionDenied | IdentityConflict | IdentityRepositoryFailure
  >;
  readonly authenticateExternalSubject: (
    provider: string,
    subject: string,
  ) => Effect.Effect<Principal | null, IdentityRepositoryFailure>;
  readonly authenticateSession: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    AuthenticatedApplicationSession,
    AuthenticationRequired | IdentityRepositoryFailure
  >;
  readonly completeExternalIdentity: (
    identity: ExternalIdentity,
  ) => Effect.Effect<
    IssuedApplicationSession,
    | IdentityAdmissionDenied
    | IdentityConflict
    | IdentityRepositoryFailure
  >;
  readonly deactivateMember: (
    principal: Principal,
    memberId: string,
  ) => Effect.Effect<
    InstallationMember,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly issueApiKey: (
    command: IssueApiKeyCommand,
  ) => Effect.Effect<
    IssuedManagedApiKey,
    | AuthorizationDenied
    | IdentityConflict
    | IdentityNotFound
    | IdentityRepositoryFailure
  >;
  readonly listApiKeys: (
    principal: Principal,
  ) => Effect.Effect<readonly ManagedApiKey[], AuthorizationDenied | IdentityRepositoryFailure>;
  readonly listMembers: (
    principal: Principal,
  ) => Effect.Effect<
    readonly InstallationMember[],
    AuthorizationDenied | IdentityRepositoryFailure
  >;
  readonly issueLocalBrowserLogin: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    IssuedLocalBrowserLogin,
    AuthenticationRequired | IdentityRepositoryFailure
  >;
  readonly loginWithLocalBrowserToken: (
    token: Redacted.Redacted,
  ) => Effect.Effect<
    IssuedApplicationSession,
    IdentityConflict | IdentityRepositoryFailure | LoginAttemptRejected
  >;
  /** Issue a session for the stable administrator of a local-owner process. */
  readonly loginAsLocalOwner: () => Effect.Effect<
    IssuedApplicationSession,
    IdentityConflict | IdentityRepositoryFailure
  >;
  readonly revokeApiKey: (
    principal: Principal,
    keyId: string,
  ) => Effect.Effect<
    ManagedApiKey,
    AuthorizationDenied | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly revokeSession: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly rotateApiKey: (
    principal: Principal,
    keyId: string,
  ) => Effect.Effect<
    IssuedManagedApiKey,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
}

/** Installation membership, browser-session, and managed-key lifecycle. */
export class InstallationAccessService extends Context.Service<
  InstallationAccessService,
  InstallationAccessOperations
>()("artifact-server/application/InstallationAccessService") {
  static readonly layer = (
    dependencies: InstallationAccessDependencies,
  ): Layer.Layer<InstallationAccessService> =>
    Layer.succeed(
      InstallationAccessService,
      makeInstallationAccessService(dependencies),
    );
}

function makeInstallationAccessService(
  dependencies: InstallationAccessDependencies,
): InstallationAccessOperations {
  const cachePolicy = dependencies.authenticationCache === undefined
    ? defaultAuthenticationCachePolicy
    : dependencies.authenticationCache;
  const sessionCache = cachePolicy === null
    ? null
    : new AuthenticationCache<AuthenticatedApplicationSession>(cachePolicy);
  const apiKeyCache = cachePolicy === null
    ? null
    : new AuthenticationCache<Principal>(cachePolicy);
  const cacheKey = (digest: string): string =>
    `${dependencies.installationId}:${digest}`;

  const issueSession = Effect.fn(
    "InstallationAccessService.issueSession",
  )(function*(member: InstallationMember) {
    const now = dependencies.clock.now();
    const token = dependencies.secrets.issue();
    const csrfToken = dependencies.secrets.issue();
    const session = yield* dependencies.repository.createApplicationSession({
      createdAt: now.toISOString(),
      csrfDigest: dependencies.secrets.digest(csrfToken),
      expiresAt: new Date(
        now.getTime() + dependencies.sessionLifetimeMilliseconds,
      ).toISOString(),
      id: dependencies.ids.sessionId(),
      installationId: dependencies.installationId,
      memberId: member.id,
      tokenDigest: dependencies.secrets.digest(token),
    });
    return {csrfToken, session, token};
  });

  const requireLocalBootstrap = Effect.fn(
    "InstallationAccessService.requireLocalBootstrap",
  )(function*(credential: Redacted.Redacted) {
    const configuredCredential = dependencies.localBootstrapCredential;
    if (
      configuredCredential === null ||
      !identitySecretsEqual(
        Redacted.value(credential),
        Redacted.value(configuredCredential),
      )
    ) {
      return yield* Effect.fail(new AuthenticationRequired({
        message: "The local browser-login credential is invalid.",
      }));
    }
    return yield* Effect.void;
  });

  const issueLocalBrowserLogin = Effect.fn(
    "InstallationAccessService.issueLocalBrowserLogin",
  )(function*(credential: Redacted.Redacted) {
    yield* requireLocalBootstrap(credential);
    const now = dependencies.clock.now();
    const expiresAt = new Date(
      now.getTime() + dependencies.localLoginAttemptLifetimeMilliseconds,
    ).toISOString();
    const token = dependencies.secrets.issue();
    yield* dependencies.repository.createLoginAttempt({
      codeVerifier: "not-applicable",
      createdAt: now.toISOString(),
      expiresAt,
      nonce: null,
      provider: localBrowserLoginProvider,
      returnTo: "/",
      stateDigest: dependencies.secrets.digest(token),
    });
    return {
      expiresAt,
      token: Redacted.make(token, {label: "local-browser-login"}),
    };
  });

  const loginAsLocalOwner = Effect.fn(
    "InstallationAccessService.loginAsLocalOwner",
  )(function*() {
    const email = yield* normalizeEmail(dependencies.bootstrapAdministratorEmail);
    let member = yield* dependencies.repository.findActiveMemberByEmail(
      dependencies.installationId,
      email,
    );
    if (member === null) {
      if (yield* dependencies.repository.hasMembers(dependencies.installationId)) {
        return yield* Effect.fail(new IdentityConflict({
          message: "The configured local administrator is not an active member.",
        }));
      }
      member = yield* dependencies.repository.admitMember({
        createdAt: dependencies.clock.now().toISOString(),
        displayName: "Local administrator",
        email,
        id: dependencies.ids.memberId(),
        installationId: dependencies.installationId,
        role: membershipRoles.administrator,
      });
    }
    if (member.role !== membershipRoles.administrator) {
      return yield* Effect.fail(new IdentityConflict({
        message: "The configured local administrator is not an administrator.",
      }));
    }
    return yield* issueSession(member);
  });

  const loginWithLocalBrowserToken = Effect.fn(
    "InstallationAccessService.loginWithLocalBrowserToken",
  )(function*(token: Redacted.Redacted) {
    yield* dependencies.repository.consumeLoginAttempt(
      dependencies.secrets.digest(Redacted.value(token)),
      localBrowserLoginProvider,
      dependencies.clock.now().toISOString(),
    );
    return yield* loginAsLocalOwner();
  });

  const completeExternalIdentity = Effect.fn(
    "InstallationAccessService.completeExternalIdentity",
  )(function*(identity: ExternalIdentity) {
    const member = yield* resolveExternalMember(identity);
    return yield* issueSession(member);
  });

  const resolveExternalMember = Effect.fn(
    "InstallationAccessService.resolveExternalMember",
  )(function*(identity: ExternalIdentity) {
    if (!identity.emailVerified) {
      return yield* Effect.fail(new IdentityAdmissionDenied({
        message: "The login provider did not verify the email address.",
      }));
    }
    const email = yield* normalizeEmail(identity.email);
    let member = yield* dependencies.repository.findActiveMemberByExternalIdentity(
      dependencies.installationId,
      identity.provider,
      identity.subject,
    );
    if (member === null) {
      member = yield* dependencies.repository.findActiveMemberByEmail(
        dependencies.installationId,
        email,
      );
    }
    if (member === null) {
      const hasMembers = yield* dependencies.repository.hasMembers(
        dependencies.installationId,
      );
      const bootstrapAdministratorEmail = yield* normalizeEmail(
        dependencies.bootstrapAdministratorEmail,
      );
      if (
        hasMembers ||
        email !== bootstrapAdministratorEmail
      ) {
        return yield* Effect.fail(new IdentityAdmissionDenied({
          message: "This person has not been admitted to the Artifact Server.",
        }));
      }
      member = yield* dependencies.repository.admitMember({
        createdAt: dependencies.clock.now().toISOString(),
        displayName: identity.displayName,
        email,
        id: dependencies.ids.memberId(),
        installationId: dependencies.installationId,
        role: membershipRoles.administrator,
      });
    }
    yield* dependencies.repository.bindExternalIdentity({
      boundAt: dependencies.clock.now().toISOString(),
      email,
      memberId: member.id,
      provider: identity.provider,
      subject: identity.subject,
    });
    return member;
  });

  const authenticateExternalIdentity = Effect.fn(
    "InstallationAccessService.authenticateExternalIdentity",
  )(function*(identity: ExternalIdentity) {
    return humanPrincipal(yield* resolveExternalMember(identity));
  });

  const authenticateExternalSubject = Effect.fn(
    "InstallationAccessService.authenticateExternalSubject",
  )(function*(provider: string, subject: string) {
    const member = yield* dependencies.repository.findActiveMemberByExternalIdentity(
      dependencies.installationId,
      provider,
      subject,
    );
    return member === null ? null : humanPrincipal(member);
  });

  const authenticateSession = Effect.fn(
    "InstallationAccessService.authenticateSession",
  )(function*(credential: Redacted.Redacted) {
    const now = dependencies.clock.now();
    const tokenDigest = dependencies.secrets.digest(Redacted.value(credential));
    const cached = sessionCache?.get(cacheKey(tokenDigest), now.getTime());
    if (cached !== undefined) return cached;
    const session = yield* dependencies.repository.findApplicationSession(
      dependencies.installationId,
      tokenDigest,
      now.toISOString(),
    );
    if (session === null) {
      return yield* Effect.fail(new AuthenticationRequired({
        message: "A valid application session is required.",
      }));
    }
    const authenticated: AuthenticatedApplicationSession = {
      csrfDigest: session.csrfDigest,
      expiresAt: session.expiresAt,
      principal: humanPrincipal(session.member),
    };
    sessionCache?.set(
      cacheKey(tokenDigest),
      authenticated,
      now.getTime(),
      new Date(session.expiresAt).getTime(),
    );
    return authenticated;
  });

  const authenticateManagedApiKey = Effect.fn(
    "InstallationAccessService.authenticateManagedApiKey",
  )(function*(credential: Redacted.Redacted) {
    const raw = Redacted.value(credential);
    const parsed = managedApiKeyCredentialPattern.exec(raw);
    if (parsed === null || parsed[1] === undefined) {
      return yield* invalidApiKey();
    }
    const presentedDigest = dependencies.secrets.digest(raw);
    const requestTime = dependencies.clock.now();
    const cached = apiKeyCache?.get(
      cacheKey(presentedDigest),
      requestTime.getTime(),
    );
    if (cached !== undefined) return cached;
    const key = yield* dependencies.repository.findApiKey(
      dependencies.installationId,
      parsed[1],
    );
    const now = requestTime.toISOString();
    if (
      key === null || key.revokedAt !== null || key.expiresAt <= now ||
      !identitySecretsEqual(presentedDigest, key.secretDigest)
    ) {
      return yield* invalidApiKey();
    }
    const principal: Principal = {
      authorizedByPrincipalId: key.authorizedByPrincipalId,
      capabilities: key.capabilities,
      displayName: key.name,
      id: key.principalId,
      installationId: key.installationId,
      kind: key.principalKind,
      membershipRole: membershipRoles.member,
    };
    apiKeyCache?.set(
      cacheKey(presentedDigest),
      principal,
      requestTime.getTime(),
      new Date(key.expiresAt).getTime(),
    );
    return principal;
  });

  const admitMember = Effect.fn(
    "InstallationAccessService.admitMember",
  )(function*(command: AdmitMemberCommand) {
    yield* requireAdministrator(command.principal, dependencies.installationId);
    const displayName = yield* requireText(command.displayName, "display name");
    const email = yield* normalizeEmail(command.email);
    return yield* dependencies.repository.admitMember({
      createdAt: dependencies.clock.now().toISOString(),
      displayName,
      email,
      id: dependencies.ids.memberId(),
      installationId: dependencies.installationId,
      role: command.role,
    });
  });

  const listMembers = Effect.fn(
    "InstallationAccessService.listMembers",
  )(function*(principal: Principal) {
    yield* requireAdministrator(principal, dependencies.installationId);
    return yield* dependencies.repository.listMembers(dependencies.installationId);
  });

  const deactivateMember = Effect.fn(
    "InstallationAccessService.deactivateMember",
  )(function*(principal: Principal, memberId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    if (principal.id === memberId) {
      return yield* Effect.fail(new IdentityConflict({
        message: "An administrator cannot deactivate their current member.",
      }));
    }
    if (dependencies.protectBootstrapAdministrator) {
      const [member, bootstrapAdministratorEmail] = yield* Effect.all([
        dependencies.repository.findMember(
          dependencies.installationId,
          memberId,
        ),
        normalizeEmail(dependencies.bootstrapAdministratorEmail),
      ]);
      if (member?.email === bootstrapAdministratorEmail) {
        return yield* Effect.fail(new IdentityConflict({
          message: "The local-owner administrator cannot be deactivated.",
        }));
      }
    }
    const member = yield* dependencies.repository.deactivateMember(
      dependencies.installationId,
      memberId,
      dependencies.clock.now().toISOString(),
    );
    // Session entries are keyed by token digest, not member, so this rare
    // administrative mutation clears the whole cache instead of indexing it.
    sessionCache?.clear();
    apiKeyCache?.clear();
    return member;
  });

  const issueApiKey = Effect.fn(
    "InstallationAccessService.issueApiKey",
  )(function*(command: IssueApiKeyCommand) {
    yield* requireAdministrator(command.principal, dependencies.installationId);
    const capabilities = yield* normalizeCapabilities(command.capabilities);
    const expiresAt = yield* requireFutureDate(
      command.expiresAt,
      dependencies.clock.now(),
    );
    const name = yield* requireText(command.name, "API key name");
    const id = dependencies.ids.apiKeyId();
    const secret = dependencies.secrets.issue();
    const token = `as_key_${id}_${secret}`;
    const member = command.memberId === undefined
      ? null
      : yield* dependencies.repository.findMember(
        dependencies.installationId,
        command.memberId,
      );
    if (command.memberId !== undefined && member?.status !== memberStatuses.active) {
      return yield* Effect.fail(new IdentityNotFound({
        message: "The active member for this API key does not exist.",
      }));
    }
    const key: StoredManagedApiKey = {
      authorizedByPrincipalId: command.principal.id,
      capabilities,
      createdAt: dependencies.clock.now().toISOString(),
      expiresAt,
      id,
      installationId: dependencies.installationId,
      name,
      prefix: token.slice(0, Math.min(token.length, 32)),
      principalId: member?.id ?? `service:${id}`,
      principalKind: member === null ? principalKinds.service : principalKinds.human,
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: dependencies.secrets.digest(token),
    };
    const apiKey = yield* dependencies.repository.createApiKey(key);
    return {apiKey, token};
  });

  const listApiKeys = Effect.fn(
    "InstallationAccessService.listApiKeys",
  )(function*(principal: Principal) {
    yield* requireAdministrator(principal, dependencies.installationId);
    return yield* dependencies.repository.listApiKeys(dependencies.installationId);
  });

  const revokeApiKey = Effect.fn(
    "InstallationAccessService.revokeApiKey",
  )(function*(principal: Principal, keyId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    const revoked = yield* dependencies.repository.revokeApiKey(
      dependencies.installationId,
      keyId,
      dependencies.clock.now().toISOString(),
    );
    // Key entries are keyed by presented-credential digest, not key id, so
    // this rare administrative mutation clears the cache instead of indexing.
    apiKeyCache?.clear();
    return revoked;
  });

  const rotateApiKey = Effect.fn(
    "InstallationAccessService.rotateApiKey",
  )(function*(principal: Principal, keyId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    const now = dependencies.clock.now();
    const previous = yield* dependencies.repository.findApiKey(
      dependencies.installationId,
      keyId,
    );
    if (previous === null) {
      return yield* Effect.fail(new IdentityNotFound({
        message: "The API key does not exist.",
      }));
    }
    if (previous.revokedAt !== null || previous.expiresAt <= now.toISOString()) {
      return yield* Effect.fail(new IdentityConflict({
        message: "A revoked or expired API key cannot be rotated.",
      }));
    }
    const replacementId = dependencies.ids.apiKeyId();
    const secret = dependencies.secrets.issue();
    const token = `as_key_${replacementId}_${secret}`;
    const replacement: StoredManagedApiKey = {
      ...previous,
      createdAt: now.toISOString(),
      id: replacementId,
      prefix: token.slice(0, Math.min(token.length, 32)),
      principalId: `service:${replacementId}`,
      revokedAt: null,
      rotatedFromId: previous.id,
      secretDigest: dependencies.secrets.digest(token),
    };
    const apiKey = yield* dependencies.repository.rotateApiKey(
      dependencies.installationId,
      previous.id,
      replacement,
      now.toISOString(),
    );
    apiKeyCache?.clear();
    return {apiKey, token};
  });

  const revokeSession = Effect.fn(
    "InstallationAccessService.revokeSession",
  )(function*(credential: Redacted.Redacted) {
    const tokenDigest = dependencies.secrets.digest(Redacted.value(credential));
    yield* dependencies.repository.revokeApplicationSession(
      dependencies.installationId,
      tokenDigest,
      dependencies.clock.now().toISOString(),
    );
    sessionCache?.evict(cacheKey(tokenDigest));
  });

  return InstallationAccessService.of({
    admitMember,
    authenticateExternalIdentity,
    authenticateExternalSubject,
    authenticateManagedApiKey,
    authenticateSession,
    completeExternalIdentity,
    deactivateMember,
    issueApiKey,
    issueLocalBrowserLogin,
    loginAsLocalOwner,
    listApiKeys,
    listMembers,
    loginWithLocalBrowserToken,
    revokeApiKey,
    revokeSession,
    rotateApiKey,
  });
}

function humanPrincipal(member: InstallationMember): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: member.displayName,
    id: member.id,
    installationId: member.installationId,
    kind: principalKinds.human,
    membershipRole: member.role,
  };
}

function requireAdministrator(
  principal: Principal,
  installationId: string,
): Effect.Effect<void, AuthorizationDenied> {
  return principal.installationId === installationId &&
      isHumanAdministrator(principal)
    ? Effect.void
    : Effect.fail(new AuthorizationDenied({
      message: "An Artifact Server administrator is required.",
    }));
}

function invalidApiKey(): Effect.Effect<never, AuthenticationRequired> {
  return Effect.fail(new AuthenticationRequired({
    message: "A valid Artifact Server API key is required.",
  }));
}

const normalizeEmail = Effect.fn("InstallationAccessService.normalizeEmail")(
  function*(value: string): Effect.fn.Return<string, IdentityConflict> {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    if (
      normalized.length < 3 || normalized.length > 320 ||
      !normalized.includes("@")
    ) {
      return yield* new IdentityConflict({
        message: "A valid email address is required.",
      });
    }
    return normalized;
  },
);

const requireText = Effect.fn("InstallationAccessService.requireText")(
  function*(value: string, label: string): Effect.fn.Return<string, IdentityConflict> {
    const normalized = value.trim();
    if (normalized.length < 1 || normalized.length > 200) {
      return yield* new IdentityConflict({
        message: `A valid ${label} is required.`,
      });
    }
    return normalized;
  },
);

const requireFutureDate = Effect.fn("InstallationAccessService.requireFutureDate")(
  function*(value: string, now: Date): Effect.fn.Return<string, IdentityConflict> {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      return yield* new IdentityConflict({
        message: "The API key expiration must be a future date and time.",
      });
    }
    return parsed.toISOString();
  },
);

const normalizeCapabilities = Effect.fn(
  "InstallationAccessService.normalizeCapabilities",
)(function*(
  capabilities: readonly PrincipalCapability[],
): Effect.fn.Return<readonly PrincipalCapability[], IdentityConflict> {
  const unique = [...new Set(capabilities)];
  if (
    unique.length === 0 ||
    unique.some((capability) => !allCapabilities.includes(capability))
  ) {
    return yield* new IdentityConflict({
      message: "At least one recognized API key capability is required.",
    });
  }
  return unique.toSorted();
});

/** Constant-time comparison for identity secrets presented by a caller. */
export function identitySecretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes);
}

/** SHA-256 secret digests used by local installation adapters. */
export function digestIdentitySecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
