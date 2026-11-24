import {createHash} from "node:crypto";
import {Context, DateTime, Effect, Layer} from "effect";

import {
  ArtifactRepositoryFailure, AuthorizationDenied, CapabilityUnavailable, InvalidPagination,
  isArtifactServerFailure,
} from "../core/errors.js";
import {hasCapability, isDirectHumanPrincipal, type Principal, principalCapabilities} from "../core/identity.js";
import type {Clock, TrashRepository} from "../core/ports.js";
import {
  type ArtifactPurge, type ArtifactRecovery, type FolderPurge, type FolderRecovery,
  maximumTrashPageSize, type PurgeTrash, type RecoverTrash, type TrashCursor,
} from "../core/trash.js";
import {AuthorizationService} from "./authorization.js";
import {folderLabel} from "./folders.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {ProjectManagementService} from "./project-management.js";

interface ListTrashCommand {
  readonly principal: Principal;
  readonly projectIds: readonly string[];
  readonly cursor: TrashCursor | null;
  readonly limit: number;
}

interface TrashWriteCommand {
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly idempotencyKey: string;
}

export type RecoverInput =
  | {readonly kind: "artifact"; readonly artifactId: string}
  | {readonly kind: "folder"; readonly folderId: string; readonly name?: string | undefined};

export type PurgeInput = PurgeTrash;

/** Lists, recovers, and purges trashed artifacts and folder trash groups (ADR 0030). */
export class TrashService extends Context.Service<TrashService, ReturnType<typeof trashOperations>>()(
  "artifact-server/TrashService",
) {}

export function trashLayer(repository: TrashRepository | undefined, clock: Clock) {
  return Layer.effect(TrashService, Effect.gen(function*() {
    const authorization = yield* AuthorizationService;
    const projects = yield* ProjectManagementService;
    return TrashService.of(trashOperations(repository, clock, authorization, projects));
  }));
}

function trashOperations(
  repository: TrashRepository | undefined,
  clock: Clock,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
) {
  const list = Effect.fn("TrashService.list")(function*(command: ListTrashCommand) {
    if (repository === undefined) return yield* unavailable();
    yield* authorization.requireArtifactListing(command.principal);
    if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > maximumTrashPageSize) {
      return yield* new InvalidPagination({
        message: `A trash page must contain between 1 and ${maximumTrashPageSize} items.`,
      });
    }
    for (const projectId of command.projectIds) {
      yield* projects.getProject({principal: command.principal, projectId});
    }
    return yield* repositoryCall("listTrash", () => repository.listTrash({
      installationId: command.principal.installationId,
      projectIds: command.projectIds.length === 0 ? null : command.projectIds,
      cursor: command.cursor,
      limit: command.limit,
    }));
  });

  const recover = Effect.fn("TrashService.recover")(function*(command: TrashWriteCommand, input: RecoverInput) {
    if (repository === undefined) return yield* unavailable();
    yield* authorization.requireArtifactManagement(command.principal);
    const project = yield* projects.resolveActiveProject(command);
    const key = yield* parseIdempotencyKey(command.idempotencyKey);
    const target: RecoverTrash = input.kind === "artifact"
      ? input
      : {
        kind: "folder",
        folderId: input.folderId,
        label: input.name === undefined ? null : yield* folderLabel(input.name),
      };
    return yield* repositoryCall("recoverTrash", (): Promise<ArtifactRecovery | FolderRecovery> =>
      repository.recover(writeContext(command, project, clock, key, digest(command.principal, ["recover", target])), target));
  });

  const purge = Effect.fn("TrashService.purge")(function*(command: TrashWriteCommand, target: PurgeInput) {
    if (repository === undefined) return yield* unavailable();
    yield* requirePurge(command.principal);
    const project = yield* projects.resolveActiveProject(command);
    const key = yield* parseIdempotencyKey(command.idempotencyKey);
    return yield* repositoryCall("purgeTrash", (): Promise<ArtifactPurge | FolderPurge> =>
      repository.purge(writeContext(command, project, clock, key, digest(command.principal, ["purge", target])), target));
  });

  return {list, recover, purge};
}

/**
 * Purge is the one irreversible step, so it is never part of artifact
 * management: a direct human member, or a key explicitly granted
 * `artifact:purge`, which no credential holds by default.
 */
function requirePurge(principal: Principal): Effect.Effect<void, AuthorizationDenied> {
  return isDirectHumanPrincipal(principal) || hasCapability(principal, principalCapabilities.purgeArtifacts)
    ? Effect.void
    : Effect.fail(new AuthorizationDenied({
      message: "Purge requires a person signed in to Artifact Server or a key granted artifact:purge.",
    }));
}

function digest(principal: Principal, input: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([
    principal.id, principal.authorizedByPrincipalId, input,
  ])).digest("hex");
}

function writeContext(
  command: TrashWriteCommand,
  project: {readonly id: string; readonly installationId: string},
  clock: Clock,
  idempotencyKey: string,
  inputDigest: string,
) {
  return {
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(clock.now())),
    installationId: project.installationId,
    projectId: project.id,
    principalId: command.principal.id,
    authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
    idempotencyKey,
    inputDigest,
  };
}

function unavailable(): CapabilityUnavailable {
  return new CapabilityUnavailable({message: "Trash, recover, and purge are unavailable on this deployment."});
}

function repositoryCall<A>(operation: "listTrash" | "recoverTrash" | "purgeTrash", run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof Error && isArtifactServerFailure(cause)
      ? cause
      : new ArtifactRepositoryFailure({cause, operation}),
  });
}
