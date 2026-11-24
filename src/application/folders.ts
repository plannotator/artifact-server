import {createHash} from "node:crypto";
import {Context, DateTime, Effect, Layer} from "effect";

import {
  ArtifactRepositoryFailure, CapabilityUnavailable, FolderFailure, InvalidArtifactName,
  InvalidPagination, isArtifactServerFailure,
} from "../core/errors.js";
import type {ArtifactPlacementChange, FolderChange, ListFolderContents} from "../core/folders.js";
import type {Principal} from "../core/identity.js";
import type {ArtifactPlacementRepository, Clock, FolderRepository, IdGenerator} from "../core/ports.js";
import {normalizeArtifactSearchText, parseArtifactTags} from "./artifact-tags.js";
import {AuthorizationService} from "./authorization.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {ProjectManagementService} from "./project-management.js";

interface ProjectCommand {
  readonly principal: Principal;
  readonly projectId: string | null;
}

interface WriteCommand extends ProjectCommand {
  readonly idempotencyKey: string;
}

type FolderInput =
  | {readonly kind: "create"; readonly id?: string | undefined; readonly parentFolderId: string | null; readonly name: string}
  | {readonly kind: "update"; readonly id: string; readonly expectedRevision: number; readonly parentFolderId?: string | null | undefined; readonly name?: string | undefined}
  | {readonly kind: "delete"; readonly id: string; readonly expectedRevision: number};

type ArtifactInput = {readonly kind: "move"; readonly toFolderId: string | null}
  | {readonly kind: "rename"; readonly name: string};

interface ArtifactWrite extends WriteCommand {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
}

type FolderRead = ProjectCommand & Omit<ListFolderContents, "installationId" | "projectId">;

export const folderIdPattern = /^fld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const graphemes = new Intl.Segmenter("en", {granularity: "grapheme"});
const hostileLabel = /[\p{Cc}\p{Bidi_Control}/\\]/u;

function validLabel(label: string): boolean {
  const normalized = label.normalize("NFKC");
  return !hostileLabel.test(normalized) && !normalized.startsWith(".") &&
    !normalized.endsWith(".") && normalized.trim() === normalized;
}

const folderLabel = Effect.fnUntraced(function*(input: string) {
  const name = input.normalize("NFC");
  if (!validLabel(name) || name === "" || Array.from(graphemes.segment(name)).length > 120) {
    return yield* new FolderFailure({reason: "invalid-name", message: "Enter a folder name of 1–120 characters without separators, control characters, or leading or trailing dots or whitespace."});
  }
  return {name, nameKey: normalizeArtifactSearchText(name)};
});

export class FolderService extends Context.Service<FolderService, ReturnType<typeof folderOperations>>()(
  "artifact-server/FolderService",
) {}

export class ArtifactPlacementService extends Context.Service<ArtifactPlacementService, ReturnType<typeof placementOperations>>()(
  "artifact-server/ArtifactPlacementService",
) {}

export function folderPlacementLayer(
  repository: (FolderRepository & ArtifactPlacementRepository) | undefined,
  clock: Clock,
  ids: Pick<IdGenerator, "folderId">,
) {
  return Layer.effect(FolderService, Effect.gen(function*() {
    const authorization = yield* AuthorizationService;
    const projects = yield* ProjectManagementService;
    return FolderService.of(folderOperations(repository, clock, ids, authorization, projects));
  })).pipe(Layer.merge(Layer.effect(ArtifactPlacementService, Effect.gen(function*() {
    const authorization = yield* AuthorizationService;
    const projects = yield* ProjectManagementService;
    return ArtifactPlacementService.of(placementOperations(repository, clock, authorization, projects));
  }))));
}

function folderOperations(
  repository: FolderRepository | undefined,
  clock: Clock,
  ids: Pick<IdGenerator, "folderId">,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
) {
  const list = Effect.fn("FolderService.list")(function*(command: FolderRead) {
    if (repository === undefined) return yield* unavailable();
    yield* authorization.requireArtifactListing(command.principal);
    const project = yield* (command.projectId === null
      ? projects.resolveActiveProject(command)
      : projects.getProject({...command, projectId: command.projectId}));
    if (command.sort === "comments" && command.cursor?.kind === "artifact" &&
      command.cursor.position.rank === undefined) {
      return yield* new InvalidPagination({message: "The cursor does not match the selected sort."});
    }
    const tags = yield* parseArtifactTags(command.tags);
    return yield* repositoryCall("listFolder", () => repository.listFolder({
      ...command,
      installationId: project.installationId,
      projectId: project.id,
      search: normalizeArtifactSearchText(command.search ?? "") || null,
      tags,
    }));
  });

  const write = Effect.fn("FolderService.write")(function*(command: WriteCommand, input: FolderInput) {
    if (repository === undefined) return yield* unavailable();
    yield* authorization.requireArtifactManagement(command.principal);
    const project = yield* projects.resolveActiveProject(command);
    const key = yield* parseIdempotencyKey(command.idempotencyKey);
    const change = yield* parseFolderChange(input, ids);
    const identity = input.kind === "create" && input.id === undefined ? {...change, id: null} : change;
    const digest = placementDigest(command.principal, [identity]);
    return yield* repositoryCall("writeFolder", () =>
      repository.writeFolder(writeContext(command, project, clock, key, digest), change));
  });
  return {list, write};
}

const parseFolderChange = Effect.fnUntraced(function*(
  input: FolderInput,
  ids: Pick<IdGenerator, "folderId">,
): Effect.fn.Return<FolderChange, FolderFailure> {
  if (input.kind === "create") {
    return {
      kind: input.kind,
      id: input.id ?? ids.folderId(),
      parentFolderId: input.parentFolderId,
      label: yield* folderLabel(input.name),
    };
  }
  if (input.kind === "delete") return {kind: input.kind, id: input.id, expectedRevision: input.expectedRevision};
  const {name, parentFolderId, id, expectedRevision} = input;
  const change = {kind: input.kind, id, expectedRevision};
  if (name === undefined) {
    if (parentFolderId === undefined) {
      return yield* new FolderFailure({reason: "invalid-name", message: "Provide a folder name or a destination."});
    }
    return {...change, parentFolderId};
  }
  const label = yield* folderLabel(name);
  return parentFolderId === undefined ? {...change, label} : {...change, label, parentFolderId};
});

function placementOperations(
  repository: ArtifactPlacementRepository | undefined,
  clock: Clock,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
) {
  const write = Effect.fn("ArtifactPlacementService.write")(function*(command: ArtifactWrite, input: ArtifactInput) {
    if (repository === undefined) return yield* unavailable();
    yield* authorization.requireArtifactManagement(command.principal);
    const project = yield* projects.resolveActiveProject(command);
    const key = yield* parseIdempotencyKey(command.idempotencyKey);
    const change = yield* parsePlacement(input);
    const digest = placementDigest(command.principal, [
      command.artifactId, command.expectedCurrentVersionId, change,
    ]);
    return yield* repositoryCall("writeArtifactPlacement", () =>
      repository.writeArtifactPlacement({
        ...writeContext(command, project, clock, key, digest),
        artifactId: command.artifactId,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
      }, change));
  });
  return {write};
}

const parsePlacement = Effect.fnUntraced(function*(input: ArtifactInput): Effect.fn.Return<
  ArtifactPlacementChange,
  InvalidArtifactName
> {
  if (input.kind === "move") return input;
  const name = input.name.normalize("NFC");
  if (!validLabel(name) || name.length < 1 || name.length > 200) {
    return yield* new InvalidArtifactName({message: "Enter an artifact name of 1–200 characters without separators, control characters, or leading or trailing dots or whitespace."});
  }
  return {kind: "rename", name, searchName: normalizeArtifactSearchText(name)};
});

function placementDigest(
  principal: Principal, input: readonly (FolderChange | ArtifactPlacementChange | string | {readonly id: null})[],
): string {
  return createHash("sha256").update(JSON.stringify([
    principal.id, principal.authorizedByPrincipalId, input,
  ])).digest("hex");
}

function writeContext(
  command: WriteCommand,
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
  return new CapabilityUnavailable({message: "Folders and in-project placement are unavailable on this deployment."});
}

function repositoryCall<A>(
  operation: "listFolder" | "writeFolder" | "writeArtifactPlacement",
  run: () => Promise<A>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof Error && isArtifactServerFailure(cause)
      ? cause
      : new ArtifactRepositoryFailure({cause, operation}),
  });
}
