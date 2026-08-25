import {
  Context,
  DateTime,
  Effect,
  Layer,
  Redacted,
} from "effect";

import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  ContentBootstrapRejected,
  ContentSessionRequired,
  VersionNotFound,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type ArtifactVersion,
  type PublishedVersion,
  type VersionContent,
} from "../core/model.js";
import type {
  CreateContentBootstrap,
  CreatePreviewLease,
  ExchangeContentBootstrap,
} from "../core/ports.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import type { ApplicationClock } from "./application-clock.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";

const bootstrapLifetimeMilliseconds = 2 * 60 * 1_000;
const contentSessionLifetimeMilliseconds = 15 * 60 * 1_000;
/** Distinguishes short-lived Review leases from immutable content tokens. */
export const previewLeaseTokenPrefix = "review-";

/** Return whether a content-host token represents a Review preview lease. */
export function isPreviewLeaseToken(token: string): boolean {
  return token.startsWith(previewLeaseTokenPrefix);
}

/** Secret material generated for private-content authorization. */
export interface IssuedContentSecret {
  readonly digest: string;
  readonly token: Redacted.Redacted;
}

/** Secret operations required by private-content authorization. */
export interface ContentSecretProvider {
  readonly digest: (token: Redacted.Redacted) => string;
  readonly issue: () => IssuedContentSecret;
}

/** Repository capabilities required by content access policy. */
export interface ContentAccessRepository {
  readonly createContentBootstrap: (
    command: CreateContentBootstrap,
  ) => Effect.Effect<ContentBootstrapRecord, ArtifactRepositoryFailure>;
  readonly exchangeContentBootstrap: (
    command: ExchangeContentBootstrap,
  ) => Effect.Effect<ContentSessionRecord | null, ArtifactRepositoryFailure>;
  readonly findContentSession: (
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ) => Effect.Effect<ContentSessionRecord | null, ArtifactRepositoryFailure>;
  readonly createPreviewLease: (
    command: CreatePreviewLease,
  ) => Effect.Effect<ContentSessionRecord, ArtifactRepositoryFailure>;
  readonly findPreviewLease: (
    tokenDigest: string,
    requestTime: string,
  ) => Effect.Effect<ContentSessionRecord | null, ArtifactRepositoryFailure>;
  readonly findCurrentVersion: (
    projectId: string | null,
    artifactId: string,
  ) => Effect.Effect<PublishedVersion | null, ArtifactRepositoryFailure>;
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
  readonly findVersionContent: (
    contentToken: string,
    path: string,
    fallback: VersionContentFallback,
  ) => Effect.Effect<VersionContent | null, ArtifactRepositoryFailure>;
}

/** The only repository-level fallback allowed for one content lookup. */
export type VersionContentFallback = "entry" | "none";

/** Dependencies used to construct private and public content access. */
export interface ContentAccessDependencies {
  readonly clock: ApplicationClock;
  readonly repository: ContentAccessRepository;
  readonly secrets: ContentSecretProvider;
}

/** Successful one-time bootstrap issuance for one current immutable version. */
export interface IssuedContentBootstrap {
  readonly contentToken: string;
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
  readonly versionId: string;
}

/** Successful exchange for one host-only browser content session. */
export interface IssuedContentSession {
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
}

/** One short-lived content-host lease for embedded exact-version Review. */
export interface IssuedPreviewLease {
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
  readonly versionId: string;
}

/** Input for issuing one private-content bootstrap. */
export interface IssueContentBootstrapCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly target:
    | {readonly kind: "current"}
    | {readonly kind: "version"; readonly versionId: string};
}

/** Input for exchanging a one-time bootstrap on its bound content host. */
export interface ExchangeContentBootstrapCommand {
  readonly contentToken: string;
  readonly token: Redacted.Redacted;
}

/** Input for authorizing one immutable-version file read. */
export interface AuthorizeVersionContentCommand {
  readonly contentToken: string;
  readonly fallback: VersionContentFallback;
  readonly path: string;
  readonly sessionToken: Redacted.Redacted | null;
}

/** Input for issuing one embedded Review lease for an exact saved version. */
export interface IssuePreviewLeaseCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly versionId: string;
}

/** Input for authorizing one manifest path through a Review lease hostname. */
export interface AuthorizePreviewContentCommand {
  readonly fallback: VersionContentFallback;
  readonly path: string;
  readonly token: Redacted.Redacted;
}

/** Expected failures from private and public content access. */
export type ContentAccessFailure =
  | ArtifactNotFound
  | AuthorizationDenied
  | ContentBootstrapRejected
  | ContentSessionRequired
  | VersionNotFound
  | ArtifactRepositoryFailure
  | ProjectManagementFailure;

interface ContentAccessOperations {
  readonly authorizePreviewContent: (
    command: AuthorizePreviewContentCommand,
  ) => Effect.Effect<VersionContent | null, ContentAccessFailure>;
  readonly authorizeVersionContent: (
    command: AuthorizeVersionContentCommand,
  ) => Effect.Effect<VersionContent | null, ContentAccessFailure>;
  readonly exchangeContentBootstrap: (
    command: ExchangeContentBootstrapCommand,
  ) => Effect.Effect<IssuedContentSession, ContentAccessFailure>;
  readonly issueContentBootstrap: (
    command: IssueContentBootstrapCommand,
  ) => Effect.Effect<IssuedContentBootstrap, ContentAccessFailure>;
  readonly issuePreviewLease: (
    command: IssuePreviewLeaseCommand,
  ) => Effect.Effect<IssuedPreviewLease, ContentAccessFailure>;
  readonly resolvePublicArtifact: (
    artifactId: string,
  ) => Effect.Effect<PublishedVersion, ContentAccessFailure>;
}

/** Owns public-link and private version-scoped browser authorization. */
export class ContentAccessService extends Context.Service<
  ContentAccessService,
  ContentAccessOperations
>()("artifact-server/application/ContentAccessService") {
  /** Construct content access from deployment-neutral storage and secret ports. */
  static readonly layer = (
    dependencies: ContentAccessDependencies,
  ): Layer.Layer<
    ContentAccessService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      ContentAccessService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeContentAccessService(dependencies, authorization, projects);
      }),
    );
}

function makeContentAccessService(
  dependencies: ContentAccessDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): ContentAccessOperations {
  const resolveAuthorizedTarget = Effect.fn(
    "ContentAccessService.resolveAuthorizedTarget",
  )(function*(command: IssueContentBootstrapCommand) {
    const project = command.projectId === null
      ? yield* projects.resolveActiveProject({
        principal: command.principal,
        projectId: null,
      })
      : yield* projects.getProject({
        principal: command.principal,
        projectId: command.projectId,
      });
    const current = yield* dependencies.repository.findCurrentVersion(
      project.id,
      command.artifactId,
    );
    if (current === null) {
      return yield* Effect.fail(
        new ArtifactNotFound({message: "The artifact does not exist."}),
      );
    }
    yield* authorization.requireContentSession(
      command.principal,
      current.artifact,
    );
    const target = command.target.kind === "current"
      ? current.version
      : (yield* dependencies.repository.findVersionRecord(
        project.id,
        current.artifact.id,
        command.target.versionId,
      ))?.version;
    if (target === undefined) {
      return yield* Effect.fail(
        new VersionNotFound({message: "The saved version does not exist on this artifact."}),
      );
    }
    return {artifact: current.artifact, project, target};
  });

  const issueContentBootstrap = Effect.fn(
    "ContentAccessService.issueContentBootstrap",
  )(function*(command: IssueContentBootstrapCommand) {
    const {artifact, project, target} = yield* resolveAuthorizedTarget(command);

    const now = yield* dependencies.clock.now;
    const secret = dependencies.secrets.issue();
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, bootstrapLifetimeMilliseconds),
    );
    yield* dependencies.repository.createContentBootstrap({
      artifactId: artifact.id,
      contentToken: target.contentToken,
      createdAt: DateTime.formatIso(now),
      expiresAt,
      principalId: command.principal.id,
      projectId: project.id,
      tokenDigest: secret.digest,
      versionId: target.id,
    });
    return {
      contentToken: target.contentToken,
      expiresAt,
      token: secret.token,
      versionId: target.id,
    };
  });

  const issuePreviewLease = Effect.fn(
    "ContentAccessService.issuePreviewLease",
  )(function*(command: IssuePreviewLeaseCommand) {
    const {artifact, project, target} = yield* resolveAuthorizedTarget({
      artifactId: command.artifactId,
      principal: command.principal,
      projectId: command.projectId,
      target: {kind: "version", versionId: command.versionId},
    });
    const now = yield* dependencies.clock.now;
    const issued = dependencies.secrets.issue();
    // A DNS label may contain at most 63 characters. The provider digest is
    // uniform lowercase hexadecimal, so 56 characters plus the `review-`
    // discriminator gives the lease 224 bits of entropy and a valid label on
    // every deployment without case-folding secret material in DNS.
    const token = Redacted.make(
      `${previewLeaseTokenPrefix}${issued.digest.slice(0, 56)}`,
      {label: "preview-lease-token"},
    );
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, contentSessionLifetimeMilliseconds),
    );
    yield* dependencies.repository.createPreviewLease({
      artifactId: artifact.id,
      contentToken: target.contentToken,
      createdAt: DateTime.formatIso(now),
      expiresAt,
      principalId: command.principal.id,
      projectId: project.id,
      tokenDigest: dependencies.secrets.digest(token),
      versionId: target.id,
    });
    return {expiresAt, token, versionId: target.id};
  });

  const exchangeContentBootstrap = Effect.fn(
    "ContentAccessService.exchangeContentBootstrap",
  )(function*(command: ExchangeContentBootstrapCommand) {
    const now = yield* dependencies.clock.now;
    const sessionSecret = dependencies.secrets.issue();
    const sessionExpiresAt = DateTime.formatIso(
      DateTime.addDuration(now, contentSessionLifetimeMilliseconds),
    );
    const session = yield* dependencies.repository.exchangeContentBootstrap({
      bootstrapTokenDigest: dependencies.secrets.digest(command.token),
      contentToken: command.contentToken,
      exchangedAt: DateTime.formatIso(now),
      session: {
        createdAt: DateTime.formatIso(now),
        expiresAt: sessionExpiresAt,
        tokenDigest: sessionSecret.digest,
      },
    });
    if (session === null) {
      return yield* Effect.fail(new ContentBootstrapRejected({
        message: "The private-content bootstrap is invalid or no longer available.",
      }));
    }
    return {expiresAt: session.expiresAt, token: sessionSecret.token};
  });

  const authorizeVersionContent = Effect.fn(
    "ContentAccessService.authorizeVersionContent",
  )(function*(command: AuthorizeVersionContentCommand) {
    const content = yield* dependencies.repository.findVersionContent(
      command.contentToken,
      command.path,
      command.fallback,
    );
    if (content === null) return null;
    yield* Effect.annotateCurrentSpan({"artifact.project.id": content.projectId});
    if (
      content.accessSetting === accessSettings.publicLink &&
      content.isCurrent
    ) {
      return content;
    }
    if (command.sessionToken === null) {
      return yield* sessionRequired();
    }
    const now = DateTime.formatIso(yield* dependencies.clock.now);
    const session = yield* dependencies.repository.findContentSession(
      dependencies.secrets.digest(command.sessionToken),
      command.contentToken,
      now,
    );
    return session === null ? yield* sessionRequired() : content;
  });

  const authorizePreviewContent = Effect.fn(
    "ContentAccessService.authorizePreviewContent",
  )(function*(command: AuthorizePreviewContentCommand) {
    const now = DateTime.formatIso(yield* dependencies.clock.now);
    const lease = yield* dependencies.repository.findPreviewLease(
      dependencies.secrets.digest(command.token),
      now,
    );
    if (lease === null) return yield* sessionRequired();
    const content = yield* dependencies.repository.findVersionContent(
      lease.contentToken,
      command.path,
      command.fallback,
    );
    if (content === null) return null;
    if (
      content.projectId !== lease.projectId
      || content.artifactId !== lease.artifactId
      || content.versionId !== lease.versionId
    ) return yield* sessionRequired();
    yield* Effect.annotateCurrentSpan({"artifact.project.id": content.projectId});
    return content;
  });

  const resolvePublicArtifact = Effect.fn(
    "ContentAccessService.resolvePublicArtifact",
  )(function*(artifactId: string) {
    const current = yield* dependencies.repository.findCurrentVersion(null, artifactId);
    if (current === null) {
      return yield* Effect.fail(
        new ArtifactNotFound({message: "The artifact does not exist."}),
      );
    }
    yield* Effect.annotateCurrentSpan({
      "artifact.project.id": current.artifact.projectId,
    });
    if (current.artifact.accessSetting !== accessSettings.publicLink) {
      return yield* sessionRequired();
    }
    return current;
  });

  return ContentAccessService.of({
    authorizePreviewContent,
    authorizeVersionContent,
    exchangeContentBootstrap,
    issueContentBootstrap,
    issuePreviewLease,
    resolvePublicArtifact,
  });
}

function sessionRequired(): Effect.Effect<never, ContentSessionRequired> {
  return Effect.fail(new ContentSessionRequired({
    message: "This artifact version requires an authorized content session.",
  }));
}
