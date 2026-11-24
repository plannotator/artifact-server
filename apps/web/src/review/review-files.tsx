import {
  ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, Delete02Icon, Moon02Icon, Sun03Icon,
} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {FormEvent, KeyboardEvent, MouseEvent} from "react";

import {
  api, type BatchItem, type BatchOperation, type FileFacets, type FileItem, fileKinds, type Folder,
  type Project, type Session,
} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {NativeSelect, NativeSelectOption} from "@/components/ui/native-select";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {LanguageSwitch} from "@/i18n/language-switch";
import {locale} from "@/i18n/locale";
import {serverErrorMessage} from "@/i18n/messages/common";
import {filesText} from "@/i18n/messages/files";
import {folderText} from "@/i18n/messages/folders";
import {reviewAppText} from "@/i18n/messages/review-app";
import {errorMessage, formatBytes, formatTimestamp, sourceFreshnessLabel} from "@/lib/presentation";
import {ArtifactMark} from "./artifact-mark.tsx";
import {FolderDestinationPicker, visibleArtifactName} from "./review-folders.tsx";
import {filesPath, trashPath} from "./review-routes.ts";

const sorts = ["updated", "created", "name", "size", "comments"] as const;
type Sort = (typeof sorts)[number];
const linkedStates = ["any", "linked", "drifted", "missing", "not-linked"] as const;
type LinkedState = (typeof linkedStates)[number];
const maximumBatch = 100;

/** Every filter lives in the URL so the page is refresh-safe and shareable. */
interface FileFilters {
  readonly project: string;
  readonly folder: string;
  readonly kind: string;
  readonly tag: string;
  readonly linked: LinkedState;
  readonly updatedAfter: string;
  readonly updatedBefore: string;
  readonly search: string;
  readonly sort: Sort;
  readonly direction: "asc" | "desc";
}

const emptyFilters: FileFilters = {
  project: "", folder: "", kind: "", tag: "", linked: "any", updatedAfter: "", updatedBefore: "",
  search: "", sort: "updated", direction: "desc",
};

function readFilters(search: string): FileFilters {
  const query = new URLSearchParams(search);
  const text = (name: string) => query.get(name) ?? "";
  const sort = sorts.find((value) => value === query.get("sort")) ?? "updated";
  return {
    project: text("project"),
    folder: text("folder"),
    kind: fileKinds.find((value) => value === query.get("kind")) ?? "",
    tag: text("tag"),
    linked: linkedStates.find((value) => value === query.get("linked")) ?? "any",
    updatedAfter: dateOnly(text("updatedAfter")),
    updatedBefore: dateOnly(text("updatedBefore")),
    search: text("search"),
    sort,
    direction: query.get("direction") === "asc" || (query.get("direction") === null && sort === "name") ? "asc" : "desc",
  };
}

function dateOnly(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : "";
}

/** The page URL keeps only filters that differ from the defaults. */
function pageQuery(filters: FileFilters): URLSearchParams {
  const query = new URLSearchParams();
  const values = [
    ["project", filters.project], ["folder", filters.folder], ["kind", filters.kind], ["tag", filters.tag],
    ["linked", filters.linked === "any" ? "" : filters.linked], ["updatedAfter", filters.updatedAfter],
    ["updatedBefore", filters.updatedBefore], ["search", filters.search],
    ["sort", filters.sort === "updated" ? "" : filters.sort],
    ["direction", filters.direction === (filters.sort === "name" ? "asc" : "desc") ? "" : filters.direction],
  ] as const;
  for (const [name, value] of values) if (value !== "") query.set(name, value);
  return query;
}

/** The API query for the same filters; dates are whole UTC days. */
function apiQuery(filters: FileFilters): URLSearchParams {
  const query = new URLSearchParams({sort: filters.sort, direction: filters.direction});
  if (filters.project !== "") query.set("projectId", filters.project);
  if (filters.folder !== "") query.set("folderId", filters.folder);
  if (filters.kind !== "") query.set("kind", filters.kind);
  if (filters.tag.trim() !== "") query.set("tag", filters.tag.trim());
  if (filters.linked !== "any") query.set("linked", filters.linked);
  if (filters.updatedAfter !== "") query.set("updatedAfter", `${filters.updatedAfter}T00:00:00.000Z`);
  if (filters.updatedBefore !== "") query.set("updatedBefore", `${filters.updatedBefore}T00:00:00.000Z`);
  if (filters.search.trim() !== "") query.set("search", filters.search.trim());
  return query;
}

type Loaded =
  | {readonly status: "loading"}
  | {readonly status: "failed"; readonly error: Error}
  | {readonly status: "ready"; readonly items: readonly FileItem[]; readonly nextCursor: string | null};

interface Failure {
  readonly file: FileItem;
  readonly status: "conflict" | "not-found" | "refused";
  readonly code: string;
  readonly message: string;
  readonly currentVersionId: string | null;
}

interface BatchOutcome {
  readonly succeeded: readonly FileItem[];
  readonly failures: readonly Failure[];
}

type Dialogs =
  | {readonly kind: "move"}
  | {readonly kind: "tag"; readonly adding: boolean}
  | {readonly kind: "result"; readonly operation: BatchOperation; readonly parameters: BatchParameters; readonly failures: readonly Failure[]};

interface BatchParameters {
  readonly toFolderId?: string | null;
  readonly toProjectId?: string;
  readonly tags?: readonly string[];
}

/** The cross-project Files page with page-local folder navigation and batch actions (FOV-004). */
export function FilesPage({
  onThemeChange, projects, session, theme,
}: {
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}) {
  const [filters, setFilters] = useState(() => readFilters(window.location.search));
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [loaded, setLoaded] = useState<Loaded>({status: "loading"});
  const [facets, setFacets] = useState<FileFacets | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{readonly text: string; readonly undo?: readonly FileItem[]} | null>(null);
  const canBatch = session.capabilities.batch;
  const projectNames = useMemo(() => new Map(projects.map(({id, name}) => [id, name])), [projects]);

  useEffect(() => {
    const next = pageQuery(filters).toString();
    window.history.replaceState(null, "", next === "" ? filesPath : `${filesPath}?${next}`);
    let current = true;
    setLoaded({status: "loading"});
    void (async () => {
      try {
        const query = apiQuery(filters);
        const [page, counts] = await Promise.all([
          api.files(new URLSearchParams([...query, ["limit", "50"]])),
          api.fileFacets(query),
        ]);
        if (!current) return;
        setLoaded({status: "ready", items: page.items, nextCursor: page.nextCursor});
        setFacets(counts);
        setSelected(new Set());
        anchor.current = null;
      } catch (caught) {
        if (current) setLoaded({status: "failed", error: caught instanceof Error ? caught : new Error(filesText.loading)});
      }
    })();
    return () => { current = false; };
  }, [filters, attempt]);

  useEffect(() => {
    if (searchDraft === filters.search) return undefined;
    const timer = window.setTimeout(() => setFilters((current) => ({...current, search: searchDraft})), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft, filters.search]);

  const change = (next: Partial<FileFilters>) => setFilters((current) => ({...current, ...next}));
  const items = loaded.status === "ready" ? loaded.items : [];
  const selectedItems = items.filter(({id}) => selected.has(id));

  const loadMore = async (cursor: string) => {
    const page = await api.files(new URLSearchParams([...apiQuery(filters), ["limit", "50"], ["cursor", cursor]]));
    setLoaded((current) => current.status !== "ready" ? current
      : {status: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor});
  };

  const toggle = (index: number, event: MouseEvent<HTMLInputElement>) => {
    const item = items[index];
    if (item === undefined) return;
    const checked = event.currentTarget.checked;
    const from = event.shiftKey && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = event.shiftKey && anchor.current !== null ? Math.max(anchor.current, index) : index;
    setSelected((current) => {
      const next = new Set(current);
      for (const {id} of items.slice(from, to + 1)) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    anchor.current = index;
  };

  const selectAllShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && canBatch) {
      event.preventDefault();
      setSelected(new Set(items.map(({id}) => id)));
    }
  };

  const run = async (operation: BatchOperation, files: readonly FileItem[], parameters: BatchParameters) => {
    setPending(true);
    setNotice(null);
    try {
      const outcome = await runBatches(operation, files, parameters);
      setDialog(outcome.failures.length > 0 ? {kind: "result", operation, parameters, failures: outcome.failures} : null);
      const succeeded = outcome.succeeded.length;
      if (operation === "trash") setNotice({text: filesText.trashed(succeeded), undo: outcome.succeeded});
      else if (operation === "recover") setNotice({text: filesText.recovered(succeeded)});
      else setNotice({text: filesText.done(succeeded)});
      setAttempt((value) => value + 1);
      return outcome;
    } catch (caught) {
      setNotice({text: errorMessage(caught instanceof Error ? caught : new Error(filesText.loading))});
      return null;
    } finally {
      setPending(false);
    }
  };

  const total = facets?.total ?? items.length;
  const facetCount = (kind: string) => facets?.kinds.find((facet) => facet.kind === kind)?.count ?? 0;
  const filtered = pageQuery({...filters, sort: emptyFilters.sort, direction: emptyFilters.direction}).toString() !== "";
  const selectedProject = projects.find(({id}) => id === filters.project) ?? null;

  return (
    <div className="as-settings">
      <header className="as-settings__header">
        <div className="as-settings__header-inner">
          <a aria-label="Artifact Server" className="as-settings__brand" href="/review">
            <span className="as-settings__brand-mark">
              <ArtifactMark className="as-settings__mark" />
            </span>
            <span className="as-settings__brand-label">{filesText.title}</span>
          </a>
          <div className="as-settings__header-actions">
            <LanguageSwitch />
            <button
              aria-label={theme === "moon" ? reviewAppText.catalog.useLightTheme : reviewAppText.catalog.useDarkTheme}
              className="as-icon-button"
              onClick={onThemeChange}
              title={theme === "moon" ? reviewAppText.catalog.useLightTheme : reviewAppText.catalog.useDarkTheme}
              type="button"
            >
              <HugeiconsIcon icon={theme === "moon" ? Sun03Icon : Moon02Icon} strokeWidth={1.8} />
            </button>
            {session.capabilities.trash ? (
              <ButtonLink href={trashPath} size="sm" variant="ghost">
                <HugeiconsIcon data-icon="inline-start" icon={Delete02Icon} strokeWidth={1.8} />
                {filesText.openTrash}
              </ButtonLink>
            ) : null}
            <ButtonLink href="/review" size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              {filesText.back}
            </ButtonLink>
          </div>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[90rem] min-w-0 grid-cols-1 gap-6 px-4 pt-6 pb-24 sm:px-6" id="main-content">
        <PageHeader description={filesText.description} title={filesText.title} />
        <section aria-label={filesText.filters} className="flex min-w-0 flex-wrap items-end gap-3">
          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            {filesText.search}
            <Input className="w-56 max-w-full" onChange={(event) => setSearchDraft(event.currentTarget.value)} type="search" value={searchDraft} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.project}
            <NativeSelect onChange={(event) => change({project: event.currentTarget.value, folder: ""})} value={filters.project}>
              <NativeSelectOption value="">{filesText.allProjects}</NativeSelectOption>
              {projects.map(({id, name}) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.kind}
            <NativeSelect onChange={(event) => change({kind: event.currentTarget.value})} value={filters.kind}>
              <NativeSelectOption value="">{filesText.allKinds}</NativeSelectOption>
              {fileKinds.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {`${folderText.kinds[kind]} (${facetCount(kind)})`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.tag}
            <Input className="w-36" list="files-tag-facets" maxLength={40} onChange={(event) => change({tag: event.currentTarget.value})} value={filters.tag} />
            <datalist id="files-tag-facets">
              {facets?.tags.map(({tag}) => <option key={tag} value={tag} />)}
            </datalist>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.linked}
            <NativeSelect onChange={(event) => change({linked: linkedStates.find((value) => value === event.currentTarget.value) ?? "any"})} value={filters.linked}>
              {linkedStates.map((state) => <NativeSelectOption key={state} value={state}>{filesText.linkedStates[state]}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.updatedAfter}
            <Input className="w-40" onChange={(event) => change({updatedAfter: event.currentTarget.value})} type="date" value={filters.updatedAfter} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.updatedBefore}
            <Input className="w-40" onChange={(event) => change({updatedBefore: event.currentTarget.value})} type="date" value={filters.updatedBefore} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {filesText.sort}
            <NativeSelect
              onChange={(event) => {
                const sort = sorts.find((value) => value === event.currentTarget.value) ?? "updated";
                change({sort, direction: sort === "name" ? "asc" : "desc"});
              }}
              value={filters.sort}
            >
              {sorts.map((sort) => <NativeSelectOption key={sort} value={sort}>{filesText.sorts[sort]}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <Button
            aria-pressed={filters.direction === "asc"}
            onClick={() => change({direction: filters.direction === "asc" ? "desc" : "asc"})}
            size="sm"
            type="button"
            variant="outline"
          >
            {filters.direction === "asc" ? filesText.ascending : filesText.descending}
          </Button>
          {filtered ? (
            <Button onClick={() => { setSearchDraft(""); setFilters({...emptyFilters, sort: filters.sort, direction: filters.direction}); }} size="sm" type="button" variant="ghost">
              {filesText.clear}
            </Button>
          ) : null}
        </section>
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <FolderColumn
            onSelectFolder={(folder) => change({folder})}
            onSelectProject={(project) => change({project, folder: ""})}
            projects={projects}
            selectedFolder={filters.folder}
            selectedProject={selectedProject}
          />
          <section className="grid min-w-0 content-start gap-4">
            <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground" role="status">
              {notice?.text}
              {notice?.undo !== undefined && notice.undo.length > 0 ? (
                <Button
                  className="ml-3"
                  disabled={pending}
                  onClick={() => { const undo = notice.undo ?? []; void run("recover", undo, {}); }}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {filesText.undo}
                </Button>
              ) : null}
            </p>
            {canBatch && selectedItems.length > 0 ? (
              <div aria-label={filesText.selection} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-rule-2)] bg-popover p-2 text-sm" role="toolbar">
                <span className="px-1 font-medium">{filesText.selected(selectedItems.length)}</span>
                {selectedItems.length > maximumBatch ? (
                  <span className="text-xs text-muted-foreground">{filesText.batches(Math.ceil(selectedItems.length / maximumBatch))}</span>
                ) : null}
                {session.capabilities.folders ? (
                  <Button disabled={pending} onClick={() => setDialog({kind: "move"})} size="sm" type="button" variant="ghost">{filesText.move}</Button>
                ) : null}
                <Button disabled={pending} onClick={() => setDialog({kind: "tag", adding: true})} size="sm" type="button" variant="ghost">{filesText.addTag}</Button>
                <Button disabled={pending} onClick={() => setDialog({kind: "tag", adding: false})} size="sm" type="button" variant="ghost">{filesText.removeTag}</Button>
                {session.capabilities.trash ? (
                  <Button disabled={pending} onClick={() => void run("trash", selectedItems, {})} size="sm" type="button" variant="destructive">
                    {filesText.moveToTrash}
                  </Button>
                ) : null}
                <Button disabled={pending} onClick={() => setSelected(new Set())} size="sm" type="button" variant="ghost">{filesText.clearSelection}</Button>
              </div>
            ) : null}
            {loaded.status === "loading" ? <StatePanel description={filesText.loading} title={filesText.title} />
              : loaded.status === "failed" ? <ErrorPanel error={loaded.error} onRetry={() => setAttempt((value) => value + 1)} />
              : loaded.items.length === 0 ? (
                <StatePanel
                  description={filtered ? filesText.emptyDescription : filesText.emptyInstallationDescription}
                  title={filtered ? filesText.empty : filesText.emptyInstallation}
                />
              ) : (
                <FileTable
                  canSelect={canBatch}
                  items={loaded.items}
                  nextCursor={loaded.nextCursor}
                  onKeyDown={selectAllShortcut}
                  onLoadMore={loadMore}
                  onSelectAll={(checked) => setSelected(checked ? new Set(items.map(({id}) => id)) : new Set())}
                  onToggle={toggle}
                  projectNames={projectNames}
                  selected={selected}
                  total={total}
                />
              )}
          </section>
        </div>
      </main>
      {dialog?.kind === "move" ? (
        <MoveDialog
          count={selectedItems.length}
          crossProject={session.capabilities.crossProjectMove}
          initialProjectId={selectedItems[0]?.projectId ?? projects[0]?.id ?? ""}
          onClose={() => setDialog(null)}
          onConfirm={(toProjectId, toFolderId) => void run("move", selectedItems, {toProjectId, toFolderId})}
          pending={pending}
          projects={projects.filter(({archivedAt}) => archivedAt === null)}
          sourceProjectIds={new Set(selectedItems.map(({projectId}) => projectId))}
        />
      ) : null}
      {dialog?.kind === "tag" ? (
        <TagDialog
          adding={dialog.adding}
          count={selectedItems.length}
          onClose={() => setDialog(null)}
          onConfirm={(tag) => void run(dialog.adding ? "tag-add" : "tag-remove", selectedItems, {tags: [tag]})}
          pending={pending}
        />
      ) : null}
      {dialog?.kind === "result" ? (
        <ResultDialog
          failures={dialog.failures}
          onClose={() => setDialog(null)}
          onRetry={async (failure) => {
            const retried = failure.currentVersionId === null ? failure.file
              : {...failure.file, currentVersionId: failure.currentVersionId};
            const outcome = await runBatches(dialog.operation, [retried], dialog.parameters);
            setAttempt((value) => value + 1);
            return outcome.failures[0] ?? null;
          }}
        />
      ) : null}
    </div>
  );
}

/** Run consecutive batches of up to 100 and collect one combined outcome. */
async function runBatches(
  operation: BatchOperation, files: readonly FileItem[], parameters: BatchParameters,
): Promise<BatchOutcome> {
  const chunks = Array.from({length: Math.ceil(files.length / maximumBatch)}, (_, index) =>
    files.slice(index * maximumBatch, (index + 1) * maximumBatch));
  return chunks.reduce<Promise<BatchOutcome>>(async (previous, chunk) => {
    const sofar = await previous;
    const result = await api.batch({
      operation, items: chunk.map(batchItem), params: parameters, idempotencyKey: crypto.randomUUID(),
    });
    const succeeded = [...sofar.succeeded];
    const failures = [...sofar.failures];
    for (const entry of result.results) {
      const file = chunk[entry.index];
      if (file === undefined) continue;
      if (entry.status === "ok") succeeded.push(file);
      else failures.push({
        file,
        status: entry.status,
        code: entry.error?.code ?? "",
        message: entry.error?.message ?? "",
        currentVersionId: entry.error?.currentVersionId ?? null,
      });
    }
    return {succeeded, failures};
  }, Promise.resolve({succeeded: [], failures: []}));
}

function batchItem(file: FileItem): BatchItem {
  return {kind: "artifact", projectId: file.projectId, artifactId: file.id, expectedCurrentVersionId: file.currentVersionId};
}

function reviewHref(file: FileItem): string {
  return `/review?${new URLSearchParams({project: file.projectId, artifact: file.id})}`;
}

function FileTable({
  canSelect, items, nextCursor, onKeyDown, onLoadMore, onSelectAll, onToggle, projectNames, selected, total,
}: {
  readonly canSelect: boolean;
  readonly items: readonly FileItem[];
  readonly nextCursor: string | null;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onLoadMore: (cursor: string) => Promise<void>;
  readonly onSelectAll: (checked: boolean) => void;
  readonly onToggle: (index: number, event: MouseEvent<HTMLInputElement>) => void;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly selected: ReadonlySet<string>;
  readonly total: number;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const allSelected = items.length > 0 && items.every(({id}) => selected.has(id));
  return (
    <section className="grid min-w-0 gap-3" onKeyDown={onKeyDown}>
      <p className="font-mono text-xs text-muted-foreground tabular-nums">{filesText.count(items.length, total)}</p>
      <Table>
        <TableHeader>
          <TableRow>
            {canSelect ? (
              <TableHead className="w-8">
                <input
                  aria-label={filesText.selectAll}
                  checked={allSelected}
                  className="size-4 accent-[var(--color-accent)]"
                  onChange={(event) => onSelectAll(event.currentTarget.checked)}
                  type="checkbox"
                />
              </TableHead>
            ) : null}
            <TableHead>{filesText.columns.name}</TableHead>
            <TableHead>{filesText.columns.kind}</TableHead>
            <TableHead>{filesText.columns.location}</TableHead>
            <TableHead className="text-right">{filesText.columns.size}</TableHead>
            <TableHead>{filesText.columns.updated}</TableHead>
            <TableHead>{filesText.columns.tags}</TableHead>
            <TableHead className="text-right">{filesText.columns.comments}</TableHead>
            <TableHead>{filesText.columns.linked}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, index) => (
            <TableRow data-state={selected.has(item.id) ? "selected" : undefined} key={item.id}>
              {canSelect ? (
                <TableCell>
                  <input
                    aria-label={filesText.selectRow(item.name)}
                    checked={selected.has(item.id)}
                    className="size-4 accent-[var(--color-accent)]"
                    onChange={() => undefined}
                    onClick={(event) => onToggle(index, event)}
                    type="checkbox"
                  />
                </TableCell>
              ) : null}
              <TableCell className="max-w-[18rem] font-medium">
                <a className="block truncate hover:underline" href={reviewHref(item)} title={filesText.openInReview}>
                  {visibleArtifactName(item.name)}
                </a>
              </TableCell>
              <TableCell>{folderText.kinds[item.fileKind]}</TableCell>
              <TableCell className="max-w-[16rem] truncate">
                {[projectNames.get(item.projectId) ?? item.projectName, ...item.folderPath.map(({name}) => name)].join(" › ")}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(item.size)}</TableCell>
              <TableCell className="font-mono text-xs tabular-nums">{formatTimestamp(item.updatedAt)}</TableCell>
              <TableCell className="max-w-[12rem] truncate text-xs">{item.tags.join(", ")}</TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{item.commentCount}</TableCell>
              <TableCell className="text-xs">{item.linked === null ? "" : sourceFreshnessLabel(item.linked)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nextCursor === null ? null : (
        <div>
          <Button
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void onLoadMore(nextCursor).finally(() => setLoadingMore(false));
            }}
            type="button"
            variant="outline"
          >
            {filesText.loadMore}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Page-local folder navigation: projects, then that project's folders loaded
 * on demand. It belongs to the Files page, not to application navigation, and
 * folds into a Folder disclosure on narrow viewports.
 */
function FolderColumn({
  onSelectFolder, onSelectProject, projects, selectedFolder, selectedProject,
}: {
  readonly onSelectFolder: (folderId: string) => void;
  readonly onSelectProject: (projectId: string) => void;
  readonly projects: readonly Project[];
  readonly selectedFolder: string;
  readonly selectedProject: Project | null;
}) {
  const wide = useWideViewport();
  return (
    <details className="min-w-0 self-start rounded-[var(--radius-card)] border border-[var(--color-rule)] p-3 text-sm" open={wide}>
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground lg:pointer-events-none lg:list-none">
        {filesText.folderPicker}
      </summary>
      <nav aria-label={filesText.folders} className="mt-2 grid gap-1">
        {selectedProject === null ? (
          <>
            <p className="text-xs text-muted-foreground">{filesText.chooseProject}</p>
            <ul className="grid gap-0.5">
              {projects.map(({id, name}) => (
                <li key={id}>
                  <button className="w-full truncate rounded-[var(--radius-pill)] px-2 py-1 text-left hover:bg-[var(--color-hover)]" onClick={() => onSelectProject(id)} type="button">
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <ul className="grid gap-0.5">
            <li>
              <button
                aria-current={selectedFolder === "" ? "location" : undefined}
                className="w-full truncate rounded-[var(--radius-pill)] px-2 py-1 text-left font-medium hover:bg-[var(--color-hover)] aria-[current=location]:bg-[var(--color-hover)]"
                onClick={() => onSelectFolder("")}
                type="button"
              >
                {selectedProject.name} · {filesText.allFolders}
              </button>
              <FolderBranch onSelect={onSelectFolder} parentId={null} projectId={selectedProject.id} selected={selectedFolder} />
            </li>
          </ul>
        )}
      </nav>
    </details>
  );
}

function FolderBranch({
  onSelect, parentId, projectId, selected,
}: {
  readonly onSelect: (folderId: string) => void;
  readonly parentId: string | null;
  readonly projectId: string;
  readonly selected: string;
}) {
  const [folders, setFolders] = useState<readonly Folder[] | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const page = await api.folders(projectId, parentId);
        if (current) setFolders(page.folders);
      } catch {
        if (current) setFolders([]);
      }
    })();
    return () => { current = false; };
  }, [projectId, parentId]);
  if (folders === null || folders.length === 0) return null;
  return (
    <ul className="grid gap-0.5 pl-3">
      {folders.map((folder) => {
        const expanded = open.has(folder.id);
        return (
          <li key={folder.id}>
            <div className="flex min-w-0 items-center">
              <button
                aria-expanded={expanded}
                aria-label={expanded ? filesText.collapse(folder.name) : filesText.expand(folder.name)}
                className="as-icon-button size-6 shrink-0"
                onClick={() => setOpen((current) => {
                  const next = new Set(current);
                  if (expanded) next.delete(folder.id);
                  else next.add(folder.id);
                  return next;
                })}
                type="button"
              >
                <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={1.8} />
              </button>
              <button
                aria-current={selected === folder.id ? "location" : undefined}
                className="min-w-0 flex-1 truncate rounded-[var(--radius-pill)] px-2 py-1 text-left hover:bg-[var(--color-hover)] aria-[current=location]:bg-[var(--color-hover)]"
                onClick={() => onSelect(folder.id)}
                type="button"
              >
                {folder.name}
              </button>
            </div>
            {expanded ? <FolderBranch onSelect={onSelect} parentId={folder.id} projectId={projectId} selected={selected} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function useWideViewport(): boolean {
  const query = "(min-width: 64rem)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

function MoveDialog({
  count, crossProject, initialProjectId, onClose, onConfirm, pending, projects, sourceProjectIds,
}: {
  readonly count: number;
  readonly crossProject: boolean;
  readonly initialProjectId: string;
  readonly onClose: () => void;
  readonly onConfirm: (toProjectId: string, toFolderId: string | null) => void;
  readonly pending: boolean;
  readonly projects: readonly Project[];
  readonly sourceProjectIds: ReadonlySet<string>;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [destination, setDestination] = useState<string | null>(null);
  const choices = crossProject ? projects : projects.filter(({id}) => sourceProjectIds.has(id));
  const project = choices.find(({id}) => id === projectId);
  return (
    <Dialog onOpenChange={(next) => { if (!next && !pending) onClose(); }} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{filesText.moveTitle(count)}</DialogTitle>
          {projectId !== initialProjectId || sourceProjectIds.size > 1 ? (
            <DialogDescription>{folderText.crossProjectNote}</DialogDescription>
          ) : null}
        </DialogHeader>
        {choices.length > 1 ? (
          <label className="grid gap-1.5 text-sm">
            {folderText.project}
            <NativeSelect disabled={pending} onChange={(event) => { setProjectId(event.currentTarget.value); setDestination(null); }} value={projectId}>
              {choices.map(({id, name}) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
        ) : null}
        {project === undefined ? null : (
          <FolderDestinationPicker
            destination={destination}
            disabled={pending}
            excludedId={null}
            key={project.id}
            onNavigate={setDestination}
            projectId={project.id}
            projectName={project.name}
          />
        )}
        <DialogFooter>
          <Button disabled={pending} onClick={onClose} type="button" variant="outline">{folderText.cancel}</Button>
          <Button disabled={pending || project === undefined} onClick={() => onConfirm(projectId, destination)} type="button">
            {pending ? filesText.working : folderText.moveHere}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TagDialog({
  adding, count, onClose, onConfirm, pending,
}: {
  readonly adding: boolean;
  readonly count: number;
  readonly onClose: () => void;
  readonly onConfirm: (tag: string) => void;
  readonly pending: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== "") onConfirm(value.trim());
  };
  return (
    <Dialog onOpenChange={(next) => { if (!next && !pending) onClose(); }} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{filesText.tagTitle(adding, count)}</DialogTitle>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            <span>{filesText.tagLabel}</span>
            <Input autoComplete="off" autoFocus maxLength={40} onChange={(event) => setValue(event.currentTarget.value)} value={value} />
          </label>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">{folderText.cancel}</Button>
            <Button disabled={pending || value.trim() === ""} type="submit">{pending ? filesText.working : filesText.apply}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Per-item failures, each with a plain reason and a retry. */
function ResultDialog({
  failures, onClose, onRetry,
}: {
  readonly failures: readonly Failure[];
  readonly onClose: () => void;
  readonly onRetry: (failure: Failure) => Promise<Failure | null>;
}) {
  const [remaining, setRemaining] = useState(failures);
  const [retrying, setRetrying] = useState<string | null>(null);
  const retry = useCallback(async (failure: Failure) => {
    setRetrying(failure.file.id);
    try {
      const again = await onRetry(failure);
      setRemaining((current) => current.flatMap((entry) => entry.file.id !== failure.file.id ? [entry] : again === null ? [] : [again]));
    } finally {
      setRetrying(null);
    }
  }, [onRetry]);
  return (
    <Dialog onOpenChange={(next) => { if (!next) onClose(); }} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{filesText.resultTitle(failures.length)}</DialogTitle>
          <DialogDescription>{filesText.resultDescription}</DialogDescription>
        </DialogHeader>
        <ul className="grid max-h-80 gap-2 overflow-y-auto">
          {remaining.map((failure) => (
            <li className="flex items-start justify-between gap-3 border-b border-[var(--color-rule)] pb-2 text-sm" key={failure.file.id}>
              <div className="min-w-0">
                <p className="truncate font-medium">{visibleArtifactName(failure.file.name)}</p>
                <p className="text-xs text-muted-foreground">
                  {filesText.statuses[failure.status]}: {reason(failure)}
                </p>
              </div>
              <Button
                aria-label={`${filesText.retry} ${failure.file.name}`}
                disabled={retrying !== null}
                onClick={() => void retry(failure)}
                size="xs"
                type="button"
                variant="outline"
              >
                {retrying === failure.file.id ? filesText.retrying : filesText.retry}
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">{filesText.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function reason(failure: Failure): string {
  return locale === "en" ? failure.message : serverErrorMessage(failure.code) ?? failure.message;
}
