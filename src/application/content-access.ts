import {
  Context,
  DateTime,
  Effect,
  Layer,
  type Redacted,
} from "effect";

import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  ContentBootstrapRejected,
  ContentSessionRequired,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type PublishedVersion,
  type VersionContent,
} from "../core/model.js";
import type {
  CreateContentBootstrap,
  ExchangeContentBootstrap,
} from "../core/ports.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import type { PublishingClock } from "./publish-artifact.js";

const bootstrapLifetimeMilliseconds = 2 * 60 * 1_000;
const contentSessionLifetimeMilliseconds = 15 * 60 * 1_000;

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
  readonly findCurrentVersion: (
    artifactId: string,
  ) => Effect.Effect<PublishedVersion | null, ArtifactRepositoryFailure>;
  readonly findVersionContent: (
    contentToken: string,
    path: string,
  ) => Effect.Effect<VersionContent | null, ArtifactRepositoryFailure>;
}

/** Dependencies used to construct private and public content access. */
export interface ContentAccessDependencies {
  readonly clock: PublishingClock;
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

/** Input for issuing one private-content bootstrap. */
export interface IssueContentBootstrapCommand {
  readonly artifactId: string;
  readonly principal: Principal;
}

/** Input for exchanging a one-time bootstrap on its bound content host. */
export interface ExchangeContentBootstrapCommand {
  readonly contentToken: string;
  readonly token: Redacted.Redacted;
}

/** Input for authorizing one immutable-version file read. */
export interface AuthorizeVersionContentCommand {
  readonly contentToken: string;
  readonly path: string;
  readonly sessionToken: Redacted.Redacted | null;
}

/** Expected failures from private and public content access. */
export type ContentAccessFailure =
  | ArtifactNotFound
  | AuthorizationDenied
  | ContentBootstrapRejected
  | ContentSessionRequired
  | ArtifactRepositoryFailure;

interface ContentAccessOperations {
  readonly authorizeVersionContent: (
    command: AuthorizeVersionContentCommand,
  ) => Effect.Effect<VersionContent | null, ContentAccessFailure>;
  readonly exchangeContentBootstrap: (
    command: ExchangeContentBootstrapCommand,
  ) => Effect.Effect<IssuedContentSession, ContentAccessFailure>;
  readonly issueContentBootstrap: (
    command: IssueContentBootstrapCommand,
  ) => Effect.Effect<IssuedContentBootstrap, ContentAccessFailure>;
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
  ): Layer.Layer<ContentAccessService, never, AuthorizationService> =>
    Layer.effect(
      ContentAccessService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeContentAccessService(dependencies, authorization);
      }),
    );
}

function makeContentAccessService(
  dependencies: ContentAccessDependencies,
  authorization: AuthorizationOperations,
): ContentAccessOperations {
  const issueContentBootstrap = Effect.fn(
    "ContentAccessService.issueContentBootstrap",
  )(function*(command: IssueContentBootstrapCommand) {
    const current = yield* dependencies.repository.findCurrentVersion(
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

    const now = yield* dependencies.clock.now;
    const secret = dependencies.secrets.issue();
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, bootstrapLifetimeMilliseconds),
    );
    yield* dependencies.repository.createContentBootstrap({
      artifactId: current.artifact.id,
      contentToken: current.version.contentToken,
      createdAt: DateTime.formatIso(now),
      expiresAt,
      principalId: command.principal.id,
      tokenDigest: secret.digest,
      versionId: current.version.id,
    });
    return {
      contentToken: current.version.contentToken,
      expiresAt,
      token: secret.token,
      versionId: current.version.id,
    };
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
    );
    if (content === null) return null;
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

  const resolvePublicArtifact = Effect.fn(
    "ContentAccessService.resolvePublicArtifact",
  )(function*(artifactId: string) {
    const current = yield* dependencies.repository.findCurrentVersion(artifactId);
    if (current === null) {
      return yield* Effect.fail(
        new ArtifactNotFound({message: "The artifact does not exist."}),
      );
    }
    if (current.artifact.accessSetting !== accessSettings.publicLink) {
      return yield* sessionRequired();
    }
    return current;
  });

  return ContentAccessService.of({
    authorizeVersionContent,
    exchangeContentBootstrap,
    issueContentBootstrap,
    resolvePublicArtifact,
  });
}

function sessionRequired(): Effect.Effect<never, ContentSessionRequired> {
  return Effect.fail(new ContentSessionRequired({
    message: "This artifact version requires an authorized content session.",
  }));
}
