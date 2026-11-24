import {Context, DateTime, Effect, Layer, Option} from "effect";

import {
  ArtifactRepositoryFailure, CapabilityUnavailable, InvalidFileFilter, InvalidPagination,
  isArtifactServerFailure,
} from "../core/errors.js";
import {
  type FileCursor, type FileFilters, type FileKind, type FileLinkFilter, type FileSort,
  type FileSortDirection, maximumFilePageSize, maximumFilterValues,
} from "../core/file-catalog.js";
import type {Principal} from "../core/identity.js";
import type {FileCatalogRepository} from "../core/ports.js";
import {normalizeArtifactSearchText, parseArtifactTags} from "./artifact-tags.js";
import {AuthorizationService} from "./authorization.js";
import {folderIdPattern} from "./folders.js";
import {ProjectManagementService} from "./project-management.js";

/** Overview filters as a protocol adapter decoded them, before product validation. */
export interface FileFilterInput {
  readonly principal: Principal;
  readonly projectIds: readonly string[];
  readonly folderId: string | null;
  readonly recursive: boolean;
  readonly kinds: readonly FileKind[];
  readonly tags: readonly string[];
  readonly linked: FileLinkFilter;
  readonly createdAfter: string | null;
  readonly createdBefore: string | null;
  readonly updatedAfter: string | null;
  readonly updatedBefore: string | null;
  readonly search: string | null;
}

export interface ListFilesInput extends FileFilterInput {
  readonly sort: FileSort;
  readonly direction: FileSortDirection;
  readonly cursor: FileCursor | null;
  readonly limit: number;
}

/** Lists non-trashed artifacts across readable projects with filters and facets (FOV-001). */
export class FileCatalogService extends Context.Service<FileCatalogService, ReturnType<typeof fileCatalogOperations>>()(
  "artifact-server/FileCatalogService",
) {}

export function fileCatalogLayer(repository: FileCatalogRepository | undefined) {
  return Layer.effect(FileCatalogService, Effect.gen(function*() {
    const authorization = yield* AuthorizationService;
    const projects = yield* ProjectManagementService;
    return FileCatalogService.of(fileCatalogOperations(repository, authorization, projects));
  }));
}

function fileCatalogOperations(
  repository: FileCatalogRepository | undefined,
  authorization: AuthorizationService["Service"],
  projects: ProjectManagementService["Service"],
) {
  /** Validate every filter and resolve every named project before any query runs. */
  const filters = Effect.fn("FileCatalogService.filters")(function*(input: FileFilterInput) {
    yield* authorization.requireArtifactListing(input.principal);
    if (input.projectIds.length > maximumFilterValues || input.tags.length > maximumFilterValues ||
      input.kinds.length > maximumFilterValues) {
      return yield* new InvalidFileFilter({message: `A filter may name at most ${maximumFilterValues} values.`});
    }
    for (const projectId of new Set(input.projectIds)) {
      yield* projects.getProject({principal: input.principal, projectId});
    }
    if (input.folderId !== null && !folderIdPattern.test(input.folderId)) {
      return yield* new InvalidFileFilter({message: "The folder filter must be a folder ID."});
    }
    const tags = yield* parseArtifactTags(input.tags);
    const createdAfter = yield* instant(input.createdAfter);
    const createdBefore = yield* instant(input.createdBefore);
    const updatedAfter = yield* instant(input.updatedAfter);
    const updatedBefore = yield* instant(input.updatedBefore);
    const resolved: FileFilters = {
      installationId: input.principal.installationId,
      projectIds: [...new Set(input.projectIds)],
      folder: input.folderId === null ? null : {folderId: input.folderId, recursive: input.recursive},
      kinds: [...new Set(input.kinds)],
      tags,
      linked: input.linked,
      createdAfter,
      createdBefore,
      updatedAfter,
      updatedBefore,
      search: normalizeArtifactSearchText(input.search ?? "") || null,
    };
    return resolved;
  });

  const list = Effect.fn("FileCatalogService.list")(function*(input: ListFilesInput) {
    if (repository === undefined) return yield* unavailable();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maximumFilePageSize) {
      return yield* new InvalidPagination({
        message: `A file page must contain between 1 and ${maximumFilePageSize} items.`,
      });
    }
    if (input.cursor !== null && (input.cursor.sort !== input.sort || input.cursor.direction !== input.direction)) {
      return yield* new InvalidPagination({message: "The cursor does not match the selected sort."});
    }
    const resolved = yield* filters(input);
    return yield* repositoryCall("listFiles", () => repository.listFiles({
      ...resolved,
      sort: input.sort,
      direction: input.direction,
      cursor: input.cursor,
      limit: input.limit,
    }));
  });

  const facets = Effect.fn("FileCatalogService.facets")(function*(input: FileFilterInput) {
    if (repository === undefined) return yield* unavailable();
    const resolved = yield* filters(input);
    return yield* repositoryCall("fileFacets", () => repository.fileFacets(resolved));
  });

  return {list, facets};
}

/** Normalize an ISO 8601 instant to the stored UTC form so comparisons are lexical. */
const instant = Effect.fnUntraced(function*(value: string | null): Effect.fn.Return<string | null, InvalidFileFilter> {
  if (value === null) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed) || !/^\d{4}-\d{2}-\d{2}/u.test(value)) {
    return yield* new InvalidFileFilter({message: "Time filters must be ISO 8601 instants."});
  }
  return DateTime.formatIso(parsed.value);
});

function unavailable(): CapabilityUnavailable {
  return new CapabilityUnavailable({message: "The file overview is unavailable on this deployment."});
}

function repositoryCall<A>(operation: "listFiles" | "fileFacets", run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause instanceof Error && isArtifactServerFailure(cause)
      ? cause
      : new ArtifactRepositoryFailure({cause, operation}),
  });
}
