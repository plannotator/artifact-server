import {createHash} from "node:crypto";

import {Context, DateTime, Effect, Layer, type Redacted, Semaphore} from "effect";

import {
  ArtifactRepositoryFailure, CapabilityUnavailable, ContentBootstrapRejected, ContentSessionRequired,
  errorCodes, FolderLinkFailure, IdempotencyConflict, isArtifactServerFailure, SourceMoved,
  type ArtifactServerFailure,
} from "../core/errors.js";
import {
  builtInIgnorePatterns, type CaptureEntryResult, compileIgnoreRules, directoriesOverlap,
  type FolderLinkRecord, type IgnoreMatcher, type InventoryEntryRecord, type InventoryState,
  maximumCaptureBatch, maximumConcurrentScans, maximumIgnoreFileBytes, maximumIgnorePatternCharacters,
  maximumLinkDepth, maximumLinkEntries, maximumLinkedFileBytes, maximumLinkIgnorePatterns,
  mirrorFolderLabel, parseIgnoreFile, type RelinkSuggestion, type ScanActivity, type ScanPage,
  scanPageEntries,
} from "../core/folder-links.js";
import type {Principal} from "../core/identity.js";
import type {SourceBindingRecord} from "../core/model.js";
import type {FolderLinkRepository, IdGenerator, UpdateFolderLink} from "../core/ports.js";
import type {ApplicationClock} from "./application-clock.js";
import {normalizeArtifactSearchText} from "./artifact-tags.js";
import {AuthorizationService} from "./authorization.js";
import type {ContentSecretProvider} from "./content-access.js";
import {FolderService} from "./folders.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {
  type LinkedSourceEngineOperations, LinkedArtifactService, type VerifiedSourceStream,
} from "./linked-artifacts.js";
import {ProjectManagementService} from "./project-management.js";

const entryLiveTokenPrefix = "live-fle-";
const entryIdentityPrefix = "fle_";
const entryIdentityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const liveBootstrapLifetimeMilliseconds = 2 * 60 * 1_000;
const liveSessionLifetimeMilliseconds = 15 * 60 * 1_000;

/** One paged directory walk opened by the directory engine. */
export interface DirectoryScanSession {
  close(): Promise<void>;
  nextPage(budget: number): Promise<ScanPage>;
}

/**
 * Directory mechanics injected by the local deployment (Node-only engine in
 * `src/local/linked-directory-engine.ts`). The application never touches the
 * filesystem directly.
 */
export interface LinkedDirectoryEngineOperations {
  canonicalizeEntryPath(joinedPath: string): Promise<string>;
  canonicalizeLinkDirectory(rawPath: string): Promise<{readonly device: string; readonly path: string}>;
  hashFile(canonicalPath: string): Promise<{readonly sha256: string; readonly size: number}>;
  openScan(linkPath: string, options: {
    readonly device: string;
    readonly ignored: IgnoreMatcher;
    readonly maximumDepth: number;
    readonly maximumFileBytes: number;
  }): Promise<DirectoryScanSession>;
  readIgnoreFile(linkPath: string, maximumBytes: number): Promise<{
    readonly byteLength: number;
    readonly content: string | null;
  }>;
  verifyLinkDirectory(linkPath: string, device: string): Promise<boolean>;
}

/** Dependencies of the enabled linked-folder service. */
export interface LinkedFolderDependencies {
  readonly clock: ApplicationClock;
  readonly directories: LinkedDirectoryEngineOperations;
  readonly ids: Pick<IdGenerator, "folderLinkId">;
  readonly installationId: string;
  readonly linkRoots: readonly string[];
  readonly repository: FolderLinkRepository;
  readonly secrets: ContentSecretProvider;
  readonly sources: Pick<
    LinkedSourceEngineOperations,
    "canonicalizeLinkRoots" | "checkLinkRoots" | "checkSelfProtection" | "mediaTypeForPath" | "openVerifiedSource"
  >;
}

/** One link as readers see it, with its in-process scan activity. */
export interface FolderLinkView extends FolderLinkRecord {
  readonly scanActivity: ScanActivity;
}

export interface LinkScope {
  readonly principal: Principal;
  readonly projectId: string | null;
}

export interface LinkCommand extends LinkScope {
  readonly folderLinkId: string;
}

/** Input for linking one directory to one Artifact Server folder. */
export interface LinkFolderCommand extends LinkScope {
  readonly folderId: string | null;
  readonly idempotencyKey: string;
  readonly ignore: readonly string[];
  readonly newFolderName: string | null;
  readonly path: string;
}

/** Owner changes to a link: pause, resume, or ignore patterns. */
export interface UpdateFolderLinkCommand extends LinkCommand {
  readonly expectedRevision: number;
  readonly ignore?: readonly string[];
  readonly paused?: boolean;
}

/** One inventory page request. */
export interface ListInventoryCommand extends LinkCommand {
  readonly cursor: string | null;
  readonly limit: number;
  readonly pendingOnly: boolean;
  readonly state: InventoryState | null;
}

/** One explicit capture of selected or all pending entries. */
export interface CaptureInventoryCommand extends LinkCommand {
  readonly entryIds: readonly string[] | "all-pending";
  readonly idempotencyKey: string;
}

/** Accepting one relink suggestion. */
export interface AcceptRelinkCommand extends LinkCommand {
  readonly artifactId: string;
  readonly entryId: string;
  readonly expectedSha256: string;
  readonly idempotencyKey: string;
}

/** One issued untracked-entry live bootstrap. */
export interface IssuedEntryLiveBootstrap {
  readonly contentToken: string;
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
}

/** One authorized untracked-entry live read. */
export interface EntryLiveRead {
  readonly mediaType: string;
  readonly source: VerifiedSourceStream;
}

type Operation<Input, Output> = (input: Input) => Effect.Effect<Output, ArtifactServerFailure>;

/** Every linked-folder operation; the disabled layer answers capability-unavailable. */
export interface LinkedFolderOperations {
  readonly acceptRelink: Operation<AcceptRelinkCommand, SourceBindingRecord>;
  readonly authorizeEntryLiveRead: Operation<{
    readonly contentToken: string;
    readonly sessionToken: Redacted.Redacted | null;
  }, EntryLiveRead>;
  readonly captureInventory: Operation<CaptureInventoryCommand, {readonly results: readonly CaptureEntryResult[]}>;
  readonly describeCapability: () => Effect.Effect<{readonly linkedFolders: boolean}>;
  readonly exchangeEntryLiveBootstrap: Operation<{
    readonly contentToken: string;
    readonly token: Redacted.Redacted;
  }, {readonly expiresAt: string; readonly token: Redacted.Redacted}>;
  readonly getFolderLink: Operation<LinkCommand, FolderLinkView>;
  readonly indexerLinks: () => Effect.Effect<readonly FolderLinkRecord[], ArtifactServerFailure>;
  readonly issueEntryLiveBootstrap: Operation<LinkCommand & {readonly entryId: string}, IssuedEntryLiveBootstrap>;
  readonly linkFolder: Operation<LinkFolderCommand, FolderLinkView>;
  readonly listFolderLinks: Operation<LinkScope, readonly FolderLinkView[]>;
  readonly listInventory: Operation<ListInventoryCommand, {
    readonly entries: readonly InventoryEntryRecord[];
    readonly nextCursor: string | null;
  }>;
  readonly reconcile: Operation<string, FolderLinkView>;
  readonly scanNow: Operation<LinkCommand, FolderLinkView>;
  readonly startRuntime: () => Effect.Effect<void, ArtifactServerFailure>;
  readonly suggestRelinks: Operation<LinkCommand, readonly RelinkSuggestion[]>;
  readonly unlinkFolder: Operation<LinkCommand & {readonly expectedRevision: number}, FolderLinkView>;
  readonly updateFolderLink: Operation<UpdateFolderLinkCommand, FolderLinkView>;
}

/**
 * Linked folders (ADR 0031): explicit linking and capture, automatic
 * observation that writes only inventory and binding freshness. Only the local
 * deployment with linked files and folders on provides the enabled layer.
 */
export class LinkedFolderService extends Context.Service<LinkedFolderService, LinkedFolderOperations>()(
  "artifact-server/application/LinkedFolderService",
) {
  static readonly layer = (
    dependencies: LinkedFolderDependencies,
  ): Layer.Layer<
    LinkedFolderService,
    never,
    AuthorizationService | ProjectManagementService | LinkedArtifactService | FolderService
  > =>
    Layer.effect(LinkedFolderService, Effect.gen(function*() {
      return makeLinkedFolderService(
        dependencies,
        yield* AuthorizationService,
        yield* ProjectManagementService,
        yield* LinkedArtifactService,
        yield* FolderService,
      );
    }));
}

const unavailableFailure = () =>
  new CapabilityUnavailable({message: "Linked folders are not available on this deployment."});

/** The stable answer every deployment gives while the capability is off. */
export const disabledLinkedFolderLayer: Layer.Layer<LinkedFolderService> = Layer.succeed(
  LinkedFolderService,
  makeDisabledLinkedFolderService(),
);

function makeDisabledLinkedFolderService(): LinkedFolderOperations {
  const unavailable = () => Effect.fail(unavailableFailure());
  return LinkedFolderService.of({
    acceptRelink: unavailable,
    authorizeEntryLiveRead: unavailable,
    captureInventory: unavailable,
    describeCapability: () => Effect.succeed({linkedFolders: false}),
    exchangeEntryLiveBootstrap: unavailable,
    getFolderLink: unavailable,
    indexerLinks: () => Effect.succeed([]),
    issueEntryLiveBootstrap: unavailable,
    linkFolder: unavailable,
    listFolderLinks: unavailable,
    listInventory: unavailable,
    reconcile: unavailable,
    scanNow: unavailable,
    startRuntime: () => Effect.void,
    suggestRelinks: unavailable,
    unlinkFolder: unavailable,
    updateFolderLink: unavailable,
  });
}

/** Build the untracked-entry live-origin host label for one inventory entry. */
export function entryLiveContentToken(entryId: string): string | null {
  if (!entryId.startsWith(entryIdentityPrefix)) return null;
  const identity = entryId.slice(entryIdentityPrefix.length);
  return entryIdentityPattern.test(identity) ? `${entryLiveTokenPrefix}${identity}` : null;
}

/** Determine whether one content-host label names an untracked-entry live origin. */
export function isEntryLiveContentToken(candidate: string): boolean {
  return candidate.startsWith(entryLiveTokenPrefix)
    && entryIdentityPattern.test(candidate.slice(entryLiveTokenPrefix.length));
}

function makeLinkedFolderService(
  dependencies: LinkedFolderDependencies,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
  linked: LinkedArtifactService["Service"],
  folders: FolderService["Service"],
): LinkedFolderOperations {
  const repository = dependencies.repository;
  const installationScans = Semaphore.makeUnsafe(maximumConcurrentScans);
  const linkScans = new Map<string, Semaphore.Semaphore>();
  const activity = new Map<string, ScanActivity>();

  const now = Effect.map(dependencies.clock.now, DateTime.formatIso);

  const view = (link: FolderLinkRecord): FolderLinkView => ({
    ...link,
    scanActivity: activity.get(link.id) ?? "idle",
  });

  const resolveProject = (principal: Principal, projectId: string | null) =>
    projectId === null
      ? projects.resolveActiveProject({principal, projectId})
      : projects.getProject({principal, projectId});

  /** Find a link the caller may see; foreign or missing links are one answer. */
  const requireLink = Effect.fnUntraced(function*(command: LinkCommand) {
    const link = yield* call(() => repository.findFolderLink(dependencies.installationId, command.folderLinkId));
    if (link === null || (command.projectId !== null && command.projectId !== link.projectId)) {
      return yield* new FolderLinkFailure({reason: "not-found", message: "The folder link does not exist."});
    }
    yield* projects.getProject({principal: command.principal, projectId: link.projectId});
    return link;
  });

  /**
   * Find a link the caller may change, scan, or capture through. A link whose
   * folder is in Trash stays paused until the folder is recovered (section 10.6).
   */
  const requireLiveLink = Effect.fnUntraced(function*(command: LinkCommand) {
    const link = yield* requireLink(command);
    if (link.inTrash) {
      return yield* new FolderLinkFailure({
        reason: "in-trash",
        message: "The linked folder is in Trash. Recover the folder to resume the link.",
      });
    }
    return link;
  });

  /**
   * The path ladder of section 9.2 for one already canonical path. A linked
   * directory may be a configured root itself; files must sit below one.
   */
  const checkPathLadder = Effect.fnUntraced(function*(canonicalPath: string) {
    const roots = yield* call(() => dependencies.sources.canonicalizeLinkRoots(dependencies.linkRoots));
    if (!roots.includes(canonicalPath)) {
      yield* call(() => Promise.resolve(dependencies.sources.checkLinkRoots(canonicalPath, roots)));
    }
    yield* call(() => dependencies.sources.checkSelfProtection(canonicalPath));
  });

  /** Rebuild, re-canonicalize, and re-check one entry's path (rule 5). */
  const verifyEntryPath = Effect.fnUntraced(function*(link: FolderLinkRecord, entry: InventoryEntryRecord) {
    const joined = `${link.path}/${entry.diskPath}`;
    const canonical = yield* call(() => dependencies.directories.canonicalizeEntryPath(joined));
    if (canonical !== joined) {
      return yield* new SourceMoved({message: "The source path changed after it was observed."});
    }
    yield* checkPathLadder(canonical);
    return joined;
  });

  const parseIgnore = Effect.fnUntraced(function*(patterns: readonly string[]) {
    if (
      patterns.length > maximumLinkIgnorePatterns
      || patterns.some((pattern) => pattern.length === 0 || pattern.length > maximumIgnorePatternCharacters
        || /[\p{Cc}]/u.test(pattern))
    ) {
      return yield* new FolderLinkFailure({
        reason: "limit",
        message: `Use at most ${maximumLinkIgnorePatterns} ignore patterns of 1–${maximumIgnorePatternCharacters} characters.`,
      });
    }
    return patterns;
  });

  const scanLink = Effect.fnUntraced(function*(link: FolderLinkRecord) {
    const startedAt = yield* now;
    // Every attempt is recorded, including one that finds the directory unavailable.
    const generation = yield* call(() => repository.beginScan(link.id, startedAt));
    const verified = yield* call(() => dependencies.directories.verifyLinkDirectory(link.path, link.rootDevice));
    const inBounds = verified && (yield* checkPathLadder(link.path).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    ));
    if (!inBounds) {
      return yield* call(() => repository.setFolderLinkStatus(link.id, "unavailable", null));
    }
    const ignoreFile = yield* call(() => dependencies.directories.readIgnoreFile(link.path, maximumIgnoreFileBytes));
    const parsed = parseIgnoreFile(ignoreFile.content, ignoreFile.byteLength);
    if (parsed.kind === "over-limit") {
      return yield* call(() => repository.setFolderLinkStatus(link.id, "over-limit", "ignore-file"));
    }
    const ignored = compileIgnoreRules([
      ...builtInIgnorePatterns,
      ...(parsed.kind === "patterns" ? parsed.patterns : []),
      ...link.ignore,
    ]);
    const session = yield* call(() => dependencies.directories.openScan(link.path, {
      device: link.rootDevice,
      ignored,
      maximumDepth: maximumLinkDepth,
      maximumFileBytes: maximumLinkedFileBytes,
    }));
    const walk = Effect.gen(function*() {
      let ignoredCount = 0;
      let overLimit = false;
      while (true) {
        const page = yield* call(() => session.nextPage(scanPageEntries));
        ignoredCount += page.ignoredCount;
        const observedAt = yield* now;
        const applied = yield* call(() => repository.applyScanPage({
          entryLimit: maximumLinkEntries,
          folderLinkId: link.id,
          generation,
          installationId: link.installationId,
          linkPath: link.path,
          observations: page.observations,
          observedAt,
          projectId: link.projectId,
        }));
        overLimit ||= applied.overLimit;
        if (page.done) break;
        // Let request fibers run between pages.
        yield* Effect.yieldNow;
      }
      const completedAt = yield* now;
      return yield* call(() => repository.finishScan({
        completedAt,
        folderLinkId: link.id,
        generation,
        ignoredCount,
        linkPath: link.path,
        overLimitReason: overLimit ? "entries" : null,
      }));
    });
    return yield* walk.pipe(Effect.ensuring(Effect.promise(() => session.close())));
  });

  /** Run one scan through the per-link and installation queues. */
  const runScan = Effect.fnUntraced(function*(folderLinkId: string, scheduled = false) {
    let linkQueue = linkScans.get(folderLinkId);
    if (linkQueue === undefined) {
      linkQueue = Semaphore.makeUnsafe(1);
      linkScans.set(folderLinkId, linkQueue);
    }
    if (activity.get(folderLinkId) !== "scanning") activity.set(folderLinkId, "queued");
    const scan = Effect.gen(function*() {
      activity.set(folderLinkId, "scanning");
      const link = yield* call(() => repository.findFolderLink(dependencies.installationId, folderLinkId));
      if (link === null) {
        return yield* new FolderLinkFailure({reason: "not-found", message: "The folder link does not exist."});
      }
      // A scheduled scan queued before a pause or a trash never runs after it.
      if (link.inTrash || (scheduled && link.paused)) return link;
      return yield* scanLink(link);
    });
    return yield* linkQueue.withPermits(1)(installationScans.withPermits(1)(scan)).pipe(
      Effect.ensuring(Effect.sync(() => activity.set(folderLinkId, "idle"))),
    );
  });

  const linkFolder = Effect.fn("LinkedFolderService.linkFolder")(function*(command: LinkFolderCommand) {
    yield* authorization.requireArtifactCreation(command.principal);
    const project = yield* resolveProject(command.principal, command.projectId);
    const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
    const ignore = yield* parseIgnore(command.ignore);
    const directory = yield* call(() => dependencies.directories.canonicalizeLinkDirectory(command.path));
    yield* checkPathLadder(directory.path);
    const inputDigest = digest([
      "link-folder", command.principal.id, project.id, directory.path,
      command.folderId, command.newFolderName, ignore,
    ]);
    const replay = yield* call(() => repository.findFolderLinkReplay(project.id, idempotencyKey));
    if (replay !== null) {
      if (replay.inputDigest !== inputDigest) {
        return yield* new IdempotencyConflict({message: "The idempotency key was already used with different input."});
      }
      return view(replay.link);
    }
    const existing = yield* call(() => repository.listFolderLinks(dependencies.installationId, null));
    if (existing.some((link) => link.folderId === command.folderId || directoriesOverlap(link.path, directory.path))) {
      return yield* new FolderLinkFailure({reason: "overlap", message: "The directory overlaps an existing folder link."});
    }
    let folderId = command.folderId;
    if (folderId === null) {
      const folder = yield* folders.write({
        idempotencyKey: `lfd-folder-${digest([idempotencyKey]).slice(0, 48)}`,
        principal: command.principal,
        projectId: project.id,
      }, {kind: "create", name: command.newFolderName ?? baseName(directory.path), parentFolderId: null});
      folderId = folder.id;
    }
    const createdAt = yield* now;
    const created = yield* call(() => repository.createFolderLink({
      createdAt,
      folderId,
      id: dependencies.ids.folderLinkId(),
      idempotencyKey,
      ignore,
      inputDigest,
      installationId: project.installationId,
      path: directory.path,
      principalId: command.principal.id,
      projectId: project.id,
      rootDevice: directory.device,
    }));
    if (created.lastScanCompletedAt !== null) return view(created);
    return view(yield* runScan(created.id));
  });

  const getFolderLink = Effect.fn("LinkedFolderService.getFolderLink")(function*(command: LinkCommand) {
    yield* authorization.requireArtifactRead(command.principal);
    return view(yield* requireLink(command));
  });

  const listFolderLinks = Effect.fn("LinkedFolderService.listFolderLinks")(function*(command: LinkScope) {
    yield* authorization.requireArtifactRead(command.principal);
    const project = yield* resolveProject(command.principal, command.projectId);
    const links = yield* call(() => repository.listFolderLinks(dependencies.installationId, project.id));
    return links.map(view);
  });

  const updateFolderLink = Effect.fn("LinkedFolderService.updateFolderLink")(function*(
    command: UpdateFolderLinkCommand,
  ) {
    yield* authorization.requireArtifactCreation(command.principal);
    const link = yield* requireLiveLink(command);
    const ignore = command.ignore === undefined ? undefined : yield* parseIgnore(command.ignore);
    let change: UpdateFolderLink = {
      expectedRevision: command.expectedRevision,
      folderLinkId: link.id,
      installationId: dependencies.installationId,
    };
    if (command.paused !== undefined) change = {...change, paused: command.paused};
    if (ignore !== undefined) change = {...change, ignore};
    const updated = yield* call(() => repository.updateFolderLink(change));
    const resumed = link.paused && !updated.paused;
    const ignoreChanged = ignore !== undefined && !updated.paused;
    return view(resumed || ignoreChanged ? yield* runScan(updated.id) : updated);
  });

  const unlinkFolder = Effect.fn("LinkedFolderService.unlinkFolder")(function*(
    command: LinkCommand & {readonly expectedRevision: number},
  ) {
    yield* authorization.requireArtifactCreation(command.principal);
    const link = yield* requireLink(command);
    const removed = yield* call(() =>
      repository.removeFolderLink(dependencies.installationId, link.id, command.expectedRevision)
    );
    linkScans.delete(link.id);
    activity.delete(link.id);
    return {...removed, scanActivity: "idle" as const};
  });

  const scanNow = Effect.fn("LinkedFolderService.scanNow")(function*(command: LinkCommand) {
    yield* authorization.requireArtifactCreation(command.principal);
    const link = yield* requireLiveLink(command);
    return view(yield* runScan(link.id));
  });

  const listInventory = Effect.fn("LinkedFolderService.listInventory")(function*(command: ListInventoryCommand) {
    yield* authorization.requireArtifactRead(command.principal);
    const link = yield* requireLink(command);
    const limit = Math.min(Math.max(command.limit, 1), 500);
    const entries = yield* call(() => repository.listInventory({
      afterRelativePath: command.cursor,
      folderLinkId: link.id,
      limit: limit + 1,
      pendingOnly: command.pendingOnly,
      state: command.state,
    }));
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page,
      nextCursor: entries.length > limit && last !== undefined ? last.relativePath : null,
    };
  });

  const captureEntry = Effect.fnUntraced(function*(
    command: CaptureInventoryCommand,
    link: FolderLinkRecord,
    entry: InventoryEntryRecord,
    entryKey: string,
  ): Effect.fn.Return<CaptureEntryResult, ArtifactServerFailure> {
    if (entry.state === "skipped") {
      return refused(entry, errorCodes.entryNotCapturable, "This entry is skipped and cannot be captured.");
    }
    const path = yield* verifyEntryPath(link, entry);
    if (entry.state === "tracked" && entry.artifactId !== null) {
      const captured = yield* linked.captureCurrent({
        artifactId: entry.artifactId,
        idempotencyKey: entryKey,
        principal: command.principal,
        projectId: link.projectId,
      });
      yield* call(() => repository.markEntryTracked(link.id, entry.id, entry.artifactId ?? "", captured.binding.fingerprint));
      return {
        artifactId: entry.artifactId,
        code: null,
        entryId: entry.id,
        message: null,
        relativePath: entry.relativePath,
        status: captured.changed ? "captured" : "unchanged",
        versionId: captured.published.version.id,
      };
    }
    const segments = entry.diskPath.split("/").slice(0, -1)
      .map((segment) => mirrorFolderLabel(segment, normalizeArtifactSearchText));
    const createdAt = yield* now;
    const folderId = segments.length === 0 ? link.folderId : yield* call(() => repository.ensureFolderPath({
      authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
      createdAt,
      idempotencyKey: entryKey,
      inputDigest: digest(["mirror", link.id, entry.diskPath]),
      installationId: link.installationId,
      principalId: command.principal.id,
      projectId: link.projectId,
      rootFolderId: link.folderId,
      segments,
    }));
    const publication = yield* linked.linkArtifact({
      expectedCanonicalPath: path,
      folderId,
      idempotencyKey: entryKey,
      name: baseName(entry.relativePath),
      path,
      principal: command.principal,
      projectId: link.projectId,
    });
    yield* call(() => repository.markEntryTracked(
      link.id, entry.id, publication.published.artifact.id, publication.binding.fingerprint,
    ));
    return {
      artifactId: publication.published.artifact.id,
      code: null,
      entryId: entry.id,
      message: null,
      relativePath: entry.relativePath,
      status: "captured",
      versionId: publication.published.version.id,
    };
  });

  const captureInventory = Effect.fn("LinkedFolderService.captureInventory")(function*(
    command: CaptureInventoryCommand,
  ) {
    yield* authorization.requireArtifactCreation(command.principal);
    if (command.entryIds !== "all-pending") {
      const unique = new Set(command.entryIds);
      if (command.entryIds.length === 0 || command.entryIds.length > maximumCaptureBatch || unique.size !== command.entryIds.length) {
        return yield* new FolderLinkFailure({
          reason: "batch-too-large",
          message: `A capture names 1–${maximumCaptureBatch} distinct entries.`,
        });
      }
    }
    const link = yield* requireLiveLink(command);
    const batchKey = yield* parseIdempotencyKey(command.idempotencyKey);
    const inputDigest = digest(["capture", command.principal.id, link.id, command.entryIds]);
    const stored = yield* call(() => repository.readCaptureResults(link.id, batchKey));
    if (stored !== null && stored.inputDigest !== inputDigest) {
      return yield* new IdempotencyConflict({message: "The idempotency key was already used with different input."});
    }
    if (command.entryIds === "all-pending" && stored !== null) return {results: stored.results};
    const known = new Map((stored?.results ?? []).map((result) => [result.entryId, result]));
    const named = command.entryIds;
    const entries = named === "all-pending"
      ? yield* call(() => repository.listPendingEntries(link.id, maximumCaptureBatch))
      : yield* call(() => repository.findInventoryEntries(link.id, named));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const order = named === "all-pending" ? entries.map((entry) => entry.id) : named;
    const results: CaptureEntryResult[] = [];
    for (const [position, entryId] of order.entries()) {
      const replayed = known.get(entryId);
      if (replayed !== undefined) {
        results.push(replayed);
        continue;
      }
      const entry = byId.get(entryId);
      if (entry === undefined) {
        results.push({
          artifactId: null, code: errorCodes.inventoryEntryNotFound, entryId,
          message: "The inventory entry does not exist.", relativePath: null, status: "refused", versionId: null,
        });
        continue;
      }
      const entryKey = `lfc-${digest([batchKey, entryId]).slice(0, 48)}`;
      const result = yield* captureEntry(command, link, entry, entryKey).pipe(
        Effect.catch((failure) => Effect.succeed(refusedFor(entry, failure))),
      );
      results.push(result);
      if (result.status !== "refused" || !retryable(result.code)) {
        yield* call(() => repository.recordCaptureResult(link.id, batchKey, inputDigest, position, result));
      }
    }
    return {results};
  });

  const suggestRelinks = Effect.fn("LinkedFolderService.suggestRelinks")(function*(command: LinkCommand) {
    yield* authorization.requireArtifactRead(command.principal);
    const link = yield* requireLink(command);
    const bindings = (yield* call(() => repository.listLinkBindings(link.id)))
      .filter((binding) => binding.freshness === "missing");
    if (bindings.length === 0) return [];
    const candidates = yield* call(() => repository.listInventory({
      afterRelativePath: null, folderLinkId: link.id, limit: maximumLinkEntries, pendingOnly: false, state: "untracked",
    }));
    const hashes = new Map<string, string | null>();
    const suggestions: RelinkSuggestion[] = [];
    for (const binding of bindings) {
      for (const entry of candidates) {
        if (entry.size !== binding.capturedSize) continue;
        let sha256 = hashes.get(entry.id);
        if (sha256 === undefined) {
          sha256 = yield* verifyEntryPath(link, entry).pipe(
            Effect.flatMap((path) => call(() => dependencies.directories.hashFile(path))),
            Effect.map((hashed) => hashed.sha256),
            Effect.catch(() => Effect.succeed(null)),
          );
          hashes.set(entry.id, sha256);
        }
        if (sha256 !== binding.capturedSha256) continue;
        suggestions.push({
          artifactId: binding.artifactId,
          artifactName: binding.artifactName,
          expectedSha256: binding.capturedSha256,
          fromRelativePath: binding.path.slice(link.path.length + 1).normalize("NFC"),
          toEntryId: entry.id,
          toRelativePath: entry.relativePath,
        });
        break;
      }
    }
    return suggestions;
  });

  const acceptRelink = Effect.fn("LinkedFolderService.acceptRelink")(function*(command: AcceptRelinkCommand) {
    yield* authorization.requireArtifactCreation(command.principal);
    const link = yield* requireLiveLink(command);
    const [entry] = yield* call(() => repository.findInventoryEntries(link.id, [command.entryId]));
    if (entry === undefined || entry.state !== "untracked") {
      return yield* new FolderLinkFailure({reason: "entry-not-found", message: "The inventory entry does not exist."});
    }
    const path = yield* verifyEntryPath(link, entry);
    const binding = yield* linked.relinkArtifact({
      artifactId: command.artifactId,
      expectedSha256: command.expectedSha256,
      idempotencyKey: command.idempotencyKey,
      path,
      principal: command.principal,
      projectId: link.projectId,
    });
    yield* call(() => repository.markEntryTracked(link.id, entry.id, command.artifactId, binding.fingerprint));
    return binding;
  });

  const requireUntrackedEntry = Effect.fnUntraced(function*(link: FolderLinkRecord, entryId: string) {
    const [entry] = yield* call(() => repository.findInventoryEntries(link.id, [entryId]));
    if (entry === undefined || entry.state !== "untracked") {
      return yield* new FolderLinkFailure({reason: "entry-not-found", message: "The inventory entry does not exist."});
    }
    return entry;
  });

  const issueEntryLiveBootstrap = Effect.fn("LinkedFolderService.issueEntryLiveBootstrap")(function*(
    command: LinkCommand & {readonly entryId: string},
  ) {
    yield* authorization.requireArtifactCreation(command.principal);
    const link = yield* requireLiveLink(command);
    const entry = yield* requireUntrackedEntry(link, command.entryId);
    const contentToken = entryLiveContentToken(entry.id);
    if (contentToken === null) {
      return yield* new FolderLinkFailure({reason: "entry-not-found", message: "The inventory entry does not exist."});
    }
    const issuedAt = yield* dependencies.clock.now;
    const expiresAt = DateTime.formatIso(DateTime.addDuration(issuedAt, liveBootstrapLifetimeMilliseconds));
    const secret = dependencies.secrets.issue();
    yield* call(() => repository.storeEntryLiveGrant({
      contentToken,
      createdAt: DateTime.formatIso(issuedAt),
      entryId: entry.id,
      expiresAt,
      folderLinkId: link.id,
      kind: "bootstrap",
      principalId: command.principal.id,
      projectId: link.projectId,
      tokenDigest: secret.digest,
    }));
    return {contentToken, expiresAt, token: secret.token} satisfies IssuedEntryLiveBootstrap;
  });

  const exchangeEntryLiveBootstrap = Effect.fn("LinkedFolderService.exchangeEntryLiveBootstrap")(function*(
    command: {readonly contentToken: string; readonly token: Redacted.Redacted},
  ) {
    const issuedAt = yield* dependencies.clock.now;
    const grant = yield* call(() => repository.consumeEntryLiveBootstrap(
      dependencies.secrets.digest(command.token), command.contentToken, DateTime.formatIso(issuedAt),
    ));
    if (grant === null) {
      return yield* new ContentBootstrapRejected({
        message: "The private-content bootstrap is invalid or no longer available.",
      });
    }
    const expiresAt = DateTime.formatIso(DateTime.addDuration(issuedAt, liveSessionLifetimeMilliseconds));
    const secret = dependencies.secrets.issue();
    yield* call(() => repository.storeEntryLiveGrant({
      ...grant,
      contentToken: command.contentToken,
      createdAt: DateTime.formatIso(issuedAt),
      expiresAt,
      kind: "session",
      tokenDigest: secret.digest,
    }));
    return {expiresAt, token: secret.token};
  });

  const authorizeEntryLiveRead = Effect.fn("LinkedFolderService.authorizeEntryLiveRead")(function*(
    command: {readonly contentToken: string; readonly sessionToken: Redacted.Redacted | null},
  ) {
    const sessionRequired = new ContentSessionRequired({
      message: "The live view requires an authorized content session.",
    });
    if (command.sessionToken === null) return yield* sessionRequired;
    const sessionToken = command.sessionToken;
    const readAt = yield* now;
    const grant = yield* call(() => repository.findEntryLiveSession(
      dependencies.secrets.digest(sessionToken), command.contentToken, readAt,
    ));
    if (grant === null) return yield* sessionRequired;
    const link = yield* call(() => repository.findFolderLink(dependencies.installationId, grant.folderLinkId));
    if (link === null || link.inTrash || link.projectId !== grant.projectId) return yield* sessionRequired;
    const entry = yield* requireUntrackedEntry(link, grant.entryId);
    const path = yield* verifyEntryPath(link, entry);
    const source = yield* call(() => dependencies.sources.openVerifiedSource(path));
    return {mediaType: dependencies.sources.mediaTypeForPath(path), source} satisfies EntryLiveRead;
  });

  /** The indexer's reconciliation entry point, running as the system. */
  const reconcile = Effect.fn("LinkedFolderService.reconcile")(function*(folderLinkId: string) {
    return view(yield* runScan(folderLinkId, true));
  });

  /**
   * Links the indexer watches and scans. A link whose folder is in Trash is
   * left out, so its watcher stops; once the folder is recovered the indexer
   * meets it as new and runs a fresh scan.
   */
  const indexerLinks = Effect.fn("LinkedFolderService.indexerLinks")(function*() {
    const links = yield* call(() => repository.listFolderLinks(dependencies.installationId, null));
    return links.filter((link) => !link.inTrash);
  });

  /** After a process start, no link is trusted until its own scan passes (section 8). */
  const startRuntime = Effect.fn("LinkedFolderService.startRuntime")(function*() {
    yield* call(() => repository.markAllFolderLinksUnverified(dependencies.installationId));
  });

  return LinkedFolderService.of({
    acceptRelink,
    authorizeEntryLiveRead,
    captureInventory,
    describeCapability,
    exchangeEntryLiveBootstrap,
    getFolderLink,
    indexerLinks,
    issueEntryLiveBootstrap,
    linkFolder,
    listFolderLinks,
    listInventory,
    reconcile,
    scanNow,
    startRuntime,
    suggestRelinks,
    unlinkFolder,
    updateFolderLink,
  });
}

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause): ArtifactServerFailure =>
      cause instanceof Error && isArtifactServerFailure(cause)
        ? cause
        : new ArtifactRepositoryFailure({cause, operation: "folderLinks"}),
  });

const describeCapability = () => Effect.succeed({linkedFolders: true});

function refused(entry: InventoryEntryRecord, code: string, message: string): CaptureEntryResult {
  return {
    artifactId: null, code, entryId: entry.id, message, relativePath: entry.relativePath,
    status: "refused", versionId: null,
  };
}

/** The stable per-entry code for one expected capture failure, if it has one. */
function captureFailureCode(failure: ArtifactServerFailure): string | null {
  switch (failure._tag) {
    case "AuthorizationDenied":
      return errorCodes.authorizationDenied;
    case "FolderFailure":
      return errorCodes.folderLimit;
    case "IdempotencyConflict":
      return errorCodes.idempotencyConflict;
    case "InvalidLinkPath":
      return errorCodes.invalidLinkPath;
    case "LinkPathOutsideRoots":
      return errorCodes.linkPathOutsideRoots;
    case "LinkPathProtected":
      return errorCodes.linkPathProtected;
    case "ProjectArchived":
      return errorCodes.projectArchived;
    case "PublishConflict":
      return errorCodes.publishConflict;
    case "SourceDrifted":
      return errorCodes.sourceDrifted;
    case "SourceMissing":
      return errorCodes.sourceMissing;
    case "SourceMoved":
      return errorCodes.sourceMoved;
    case "SourceUnreadable":
      return errorCodes.sourceUnreadable;
    default:
      return null;
  }
}

function refusedFor(entry: InventoryEntryRecord, failure: ArtifactServerFailure): CaptureEntryResult {
  const known = captureFailureCode(failure);
  return known === null
    ? refused(entry, "INTERNAL_ERROR", "The server could not capture this entry.")
    : refused(entry, known, failure.message);
}

/** Failures that a later identical capture may resolve are never replayed. */
function retryable(code: string | null): boolean {
  return code === errorCodes.sourceDrifted || code === "INTERNAL_ERROR";
}

type DigestPart = string | number | null | readonly string[];

function digest(parts: readonly DigestPart[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function baseName(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? relativePath : relativePath.slice(index + 1);
}
