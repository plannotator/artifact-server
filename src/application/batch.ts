import {createHash} from "node:crypto";
import {Context, Effect, Layer, Result} from "effect";

import {
  type BatchItem, batchItemIdentity, type BatchItemStatus, type BatchOperation, type BatchParameters,
  maximumBatchItems, purgeBatchConfirmation,
} from "../core/batch.js";
import {type ArtifactServerFailure, InvalidBatch, TrashFailure} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import {ArtifactManagementService} from "./artifact-management.js";
import {parseArtifactTags} from "./artifact-tags.js";
import {ArtifactPlacementService, FolderService} from "./folders.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {LinkedArtifactService} from "./linked-artifacts.js";
import {TrashService} from "./trash.js";

export interface RunBatchCommand {
  readonly principal: Principal;
  readonly operation: BatchOperation;
  readonly items: readonly BatchItem[];
  readonly parameters: BatchParameters;
  readonly idempotencyKey: string;
  /** Required for `purge`: exactly `purge <n> items`. */
  readonly confirm: string | null;
}

/** Runs one operation over 1..100 items, each in its own transaction (FLD-005). */
export class BatchService extends Context.Service<BatchService, ReturnType<typeof batchOperations>>()(
  "artifact-server/BatchService",
) {}

export const batchLayer = Layer.effect(BatchService, Effect.gen(function*() {
  return BatchService.of(batchOperations(
    yield* ArtifactPlacementService,
    yield* FolderService,
    yield* ArtifactManagementService,
    yield* TrashService,
    yield* LinkedArtifactService,
  ));
}));

function batchOperations(
  placement: ArtifactPlacementService["Service"],
  folders: FolderService["Service"],
  management: ArtifactManagementService["Service"],
  trash: TrashService["Service"],
  linked: LinkedArtifactService["Service"],
) {
  /** Run one item exactly as a single request with its derived idempotency key would. */
  const runItem = Effect.fn("BatchService.runItem")(function*(
    command: RunBatchCommand,
    item: BatchItem,
    idempotencyKey: string,
  ) {
    const principal = command.principal;
    const scope = {principal, projectId: item.projectId, idempotencyKey};
    const {toFolderId = null, toProjectId = item.projectId} = command.parameters;
    switch (command.operation) {
      case "move":
        return item.kind === "artifact"
          ? yield* placement.moveAcrossProjects({...scope, ...artifactGuard(item), toProjectId}, toFolderId)
          : yield* folders.moveToProject({
            ...scope, folderId: item.folderId, expectedRevision: item.expectedRevision,
            toProjectId, toParentFolderId: toFolderId,
          });
      case "trash":
        return item.kind === "artifact"
          ? yield* management.deleteArtifact({...scope, ...artifactGuard(item)})
          : yield* folders.write(scope, {kind: "delete", id: item.folderId, expectedRevision: item.expectedRevision});
      case "recover":
        return yield* trash.recover(scope, item.kind === "artifact"
          ? {kind: "artifact", artifactId: item.artifactId}
          : {kind: "folder", folderId: item.folderId});
      case "purge":
        return yield* trash.purgeBatchItem(scope, item.kind === "artifact"
          ? {kind: "artifact", artifactId: item.artifactId}
          : {kind: "folder", folderId: item.folderId});
      case "tag-add":
      case "tag-remove": {
        if (item.kind === "folder") return yield* artifactsOnly();
        const {artifact} = yield* management.getArtifact({principal, projectId: item.projectId, artifactId: item.artifactId});
        const changed = new Set(command.parameters.tags ?? []);
        const tags = command.operation === "tag-add"
          ? [...new Set([...artifact.tags, ...changed])]
          : artifact.tags.filter((tag) => !changed.has(tag));
        return yield* management.changeTags({...scope, ...artifactGuard(item), tags});
      }
      case "capture":
        break;
    }
    if (item.kind === "folder") return yield* artifactsOnly();
    return yield* linked.captureArtifact({...scope, ...artifactGuard(item)});
  });

  const run = Effect.fn("BatchService.run")(function*(command: RunBatchCommand) {
    const batchKey = yield* parseIdempotencyKey(command.idempotencyKey);
    yield* validate(command);
    const parameters = command.operation === "tag-add" || command.operation === "tag-remove"
      ? {...command.parameters, tags: yield* parseArtifactTags(command.parameters.tags ?? [])}
      : command.parameters;
    const results = [];
    for (const [index, item] of command.items.entries()) {
      const key = createHash("sha256").update(JSON.stringify([batchKey, index, batchItemIdentity(item)])).digest("hex");
      const outcome = yield* Effect.result(runItem({...command, parameters}, item, key));
      results.push(Result.isSuccess(outcome)
        ? {index, item, status: "ok" as const, result: outcome.success}
        : {index, item, status: itemStatus(outcome.failure), failure: outcome.failure});
    }
    return {operation: command.operation, results};
  });

  return {run};
}

/** Refuse the whole batch before any item runs. */
const validate = Effect.fnUntraced(function*(command: RunBatchCommand): Effect.fn.Return<void, InvalidBatch | TrashFailure> {
  if (command.items.length === 0 || command.items.length > maximumBatchItems) {
    return yield* new InvalidBatch({message: `A batch must name between 1 and ${maximumBatchItems} items.`});
  }
  if (new Set(command.items.map(batchItemIdentity)).size !== command.items.length) {
    return yield* new InvalidBatch({message: "A batch may name each item only once."});
  }
  if (command.operation === "move" && command.parameters.toFolderId === undefined) {
    return yield* new InvalidBatch({message: "A move batch needs a destination folder or null for the project root."});
  }
  if ((command.operation === "tag-add" || command.operation === "tag-remove") &&
    (command.parameters.tags ?? []).length === 0) {
    return yield* new InvalidBatch({message: "A tag batch needs at least one tag."});
  }
  if (command.operation === "purge" && command.confirm !== purgeBatchConfirmation(command.items.length)) {
    return yield* new TrashFailure({
      reason: "confirmation-mismatch",
      message: `Type "${purgeBatchConfirmation(command.items.length)}" to purge these items.`,
    });
  }
  return yield* Effect.void;
});

function artifactGuard(item: Extract<BatchItem, {kind: "artifact"}>) {
  return {artifactId: item.artifactId, expectedCurrentVersionId: item.expectedCurrentVersionId};
}

function artifactsOnly(): InvalidBatch {
  return new InvalidBatch({message: "This operation applies to artifacts only."});
}

function itemStatus(failure: ArtifactServerFailure): Exclude<BatchItemStatus, "ok"> {
  switch (failure._tag) {
    case "PublishConflict":
    case "ArtifactMutationConflict":
      return "conflict";
    case "ArtifactNotFound":
    case "ProjectNotFound":
    case "VersionNotFound":
      return "not-found";
    case "FolderFailure":
      return failure.reason === "revision" ? "conflict" : failure.reason === "not-found" ? "not-found" : "refused";
    default:
      return "refused";
  }
}
