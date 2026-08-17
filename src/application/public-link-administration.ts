import {Context, Effect, Layer} from "effect";

import {
  type ArtifactManagementFailure,
  ArtifactManagementService,
} from "./artifact-management.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  InvalidPagination,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import {
  accessSettings,
  type ArtifactRecord,
  type ArtifactState,
  type PageCursor,
  type ProjectRecord,
  type VersionRecord,
} from "../core/model.js";

const maximumPageSize = 100;
const maximumBulkSize = 100;

/** One active public-link artifact with its project and current-version context. */
export interface PublicLinkInventoryItem {
  readonly artifact: ArtifactRecord;
  readonly currentVersion: VersionRecord;
  readonly project: ProjectRecord;
}

/** One bounded cross-project page of active public-link artifacts. */
export interface PublicLinkInventoryPage {
  readonly items: readonly PublicLinkInventoryItem[];
  readonly nextCursor: PageCursor | null;
}

/** Values used by the public-link inventory persistence query. */
export interface ListPublicLinks {
  readonly cursor: PageCursor | null;
  readonly limit: number;
}

/** Persistence required by installation-level public-link administration. */
export interface PublicLinkAdministrationRepository {
  readonly listPublicLinks: (
    command: ListPublicLinks,
  ) => Effect.Effect<PublicLinkInventoryPage, ArtifactRepositoryFailure>;
}

/** Input for listing active public links across the installation. */
export interface ListPublicLinksCommand extends ListPublicLinks {
  readonly principal: Principal;
}

/** One optimistic visibility command inside a bounded make-private request. */
export interface MakePublicLinkPrivateItem {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
}

/** Input for making one bounded selection of public links private. */
export interface MakePublicLinksPrivateCommand {
  readonly items: readonly MakePublicLinkPrivateItem[];
  readonly principal: Principal;
}

/** Observable result of one item in a bounded make-private request. */
export type MakePublicLinkPrivateResult =
  | {
    readonly item: MakePublicLinkPrivateItem;
    readonly replayed: boolean;
    readonly state: ArtifactState;
    readonly status: "made_private";
  }
  | {
    readonly failure: ArtifactManagementFailure;
    readonly item: MakePublicLinkPrivateItem;
    readonly status: "failed";
  };

/** Expected top-level failures produced by public-link administration. */
export type PublicLinkAdministrationFailure =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | InvalidPagination;

interface PublicLinkAdministrationOperations {
  readonly listPublicLinks: (
    command: ListPublicLinksCommand,
  ) => Effect.Effect<PublicLinkInventoryPage, PublicLinkAdministrationFailure>;
  readonly makePrivate: (
    command: MakePublicLinksPrivateCommand,
  ) => Effect.Effect<
    readonly MakePublicLinkPrivateResult[],
    PublicLinkAdministrationFailure
  >;
}

/** Installation-administrator inventory and bounded public-link shutdown operations. */
export class PublicLinkAdministrationService extends Context.Service<
  PublicLinkAdministrationService,
  PublicLinkAdministrationOperations
>()("artifact-server/application/PublicLinkAdministrationService") {
  /** Construct public-link administration over the specialized inventory query. */
  static readonly layer = (
    repository: PublicLinkAdministrationRepository,
  ): Layer.Layer<
    PublicLinkAdministrationService,
    never,
    ArtifactManagementService | AuthorizationService
  > =>
    Layer.effect(
      PublicLinkAdministrationService,
      Effect.gen(function*() {
        const artifacts = yield* ArtifactManagementService;
        const authorization = yield* AuthorizationService;
        return makePublicLinkAdministrationService(
          repository,
          artifacts,
          authorization,
        );
      }),
    );
}

function makePublicLinkAdministrationService(
  repository: PublicLinkAdministrationRepository,
  artifacts: ArtifactManagementService["Service"],
  authorization: AuthorizationOperations,
): PublicLinkAdministrationOperations {
  const requireBound = Effect.fn(
    "PublicLinkAdministrationService.requireBound",
  )(function*(value: number, label: "bulk request" | "page", maximum: number) {
    if (Number.isSafeInteger(value) && value >= 1 && value <= maximum) return value;
    return yield* new InvalidPagination({
      message: `A public-link ${label} must contain between 1 and ${maximum} records.`,
    });
  });

  const listPublicLinks = Effect.fn(
    "PublicLinkAdministrationService.listPublicLinks",
  )(function*(command: ListPublicLinksCommand) {
    yield* authorization.requireInstallationAdministration(command.principal);
    const limit = yield* requireBound(command.limit, "page", maximumPageSize);
    return yield* repository.listPublicLinks({
      cursor: command.cursor,
      limit,
    });
  });

  const makePrivate = Effect.fn(
    "PublicLinkAdministrationService.makePrivate",
  )(function*(command: MakePublicLinksPrivateCommand) {
    yield* authorization.requireInstallationAdministration(command.principal);
    yield* requireBound(command.items.length, "bulk request", maximumBulkSize);
    return yield* Effect.forEach(
      command.items,
      (item) =>
        artifacts.changeAccess({
          accessSetting: accessSettings.accountRequired,
          artifactId: item.artifactId,
          expectedCurrentVersionId: item.expectedCurrentVersionId,
          idempotencyKey: item.idempotencyKey,
          principal: command.principal,
          projectId: item.projectId,
        }).pipe(Effect.match({
          onFailure: (failure): MakePublicLinkPrivateResult => ({
            failure,
            item,
            status: "failed",
          }),
          onSuccess: (state): MakePublicLinkPrivateResult => ({
            item,
            replayed: state.replayed,
            state,
            status: "made_private",
          }),
        })),
      {concurrency: 1},
    );
  });

  return PublicLinkAdministrationService.of({
    listPublicLinks,
    makePrivate,
  });
}
