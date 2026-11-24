import {ArrowLeft01Icon, Moon02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {FormEvent, ReactNode} from "react";

import {api, ApiError, type Project, type Recovery, type TrashedItem} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {LanguageSwitch} from "@/i18n/language-switch";
import {folderText} from "@/i18n/messages/folders";
import {reviewAppText} from "@/i18n/messages/review-app";
import {trashText} from "@/i18n/messages/trash";
import {errorMessage, formatTimestamp} from "@/lib/presentation";
import {ArtifactMark} from "./artifact-mark.tsx";

type Dialogs =
  | {readonly kind: "purge"; readonly item: TrashedItem}
  | {readonly kind: "rename"; readonly item: TrashedItem};

type Loaded =
  | {readonly status: "loading"}
  | {readonly status: "failed"; readonly error: Error}
  | {readonly status: "ready"; readonly items: readonly TrashedItem[]; readonly nextCursor: string | null};

/** Trashed artifacts and folder groups across projects, with Recover and Purge. */
export function TrashPage({
  onThemeChange, projects, theme,
}: {
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly theme: "dawn" | "moon";
}) {
  const [loaded, setLoaded] = useState<Loaded>({status: "loading"});
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const projectNames = useMemo(() => new Map(projects.map(({id, name}) => [id, name])), [projects]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const page = await api.trash(null);
        if (current) setLoaded({status: "ready", items: page.items, nextCursor: page.nextCursor});
      } catch (caught) {
        if (current) setLoaded({status: "failed", error: (caught instanceof Error ? caught : new Error(trashText.unavailable))});
      }
    })();
    return () => { current = false; };
  }, [attempt]);

  const loadMore = async (cursor: string) => {
    if (loaded.status !== "ready") return;
    const page = await api.trash(cursor);
    setLoaded({status: "ready", items: [...loaded.items, ...page.items], nextCursor: page.nextCursor});
  };

  const forget = (item: TrashedItem) => {
    setLoaded((current) => current.status !== "ready" ? current : {
      ...current,
      items: current.items.filter(({id, trashGroupId}) =>
        id !== item.id && (item.kind !== "folder" || trashGroupId !== item.trashGroupId)),
    });
  };

  const recover = async (item: TrashedItem, name?: string) => {
    setPending(item.id);
    setNotice(null);
    try {
      const recovery = await api.recoverTrashed(item, crypto.randomUUID(), name);
      forget(item);
      setDialog(null);
      setNotice(recoveryNotice(name ?? item.name, recovery));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "NAME_CONFLICT" && item.kind === "folder") {
        setDialog({kind: "rename", item});
      } else {
        setNotice(errorMessage((caught instanceof Error ? caught : new Error(trashText.unavailable))));
      }
    } finally {
      setPending(null);
    }
  };

  const purge = async (item: TrashedItem, confirm: string) => {
    setPending(item.id);
    setNotice(null);
    try {
      await api.purgeTrashed(item, confirm, crypto.randomUUID());
      forget(item);
      setDialog(null);
      setNotice(trashText.purged(item.name));
    } catch (caught) {
      setNotice(errorMessage((caught instanceof Error ? caught : new Error(trashText.unavailable))));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="as-settings">
      <header className="as-settings__header">
        <div className="as-settings__header-inner">
          <a aria-label="Artifact Server" className="as-settings__brand" href="/review">
            <span className="as-settings__brand-mark">
              <ArtifactMark className="as-settings__mark" />
            </span>
            <span className="as-settings__brand-label">{trashText.title}</span>
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
            <ButtonLink href="/review" size="sm" variant="outline">
              <HugeiconsIcon data-icon="inline-start" icon={ArrowLeft01Icon} strokeWidth={1.8} />
              {trashText.back}
            </ButtonLink>
          </div>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[72rem] min-w-0 grid-cols-1 gap-6 px-4 pt-6 pb-24 sm:px-6" id="main-content">
        <PageHeader description={trashText.description} title={trashText.title} />
        <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground" role="status">{notice}</p>
        {loaded.status === "loading" ? <StatePanel description={trashText.loading} title={trashText.title} />
          : loaded.status === "failed" ? <ErrorPanel error={loaded.error} onRetry={() => setAttempt((value) => value + 1)} />
          : loaded.items.length === 0 ? <StatePanel description={trashText.emptyDescription} title={trashText.empty} />
          : (
            <TrashTable
              items={loaded.items}
              nextCursor={loaded.nextCursor}
              onLoadMore={loadMore}
              onPurge={(item) => setDialog({kind: "purge", item})}
              onRecover={(item) => void recover(item)}
              pending={pending}
              projectNames={projectNames}
            />
          )}
      </main>
      {dialog?.kind === "purge" ? (
        <PurgeDialog item={dialog.item} onClose={() => setDialog(null)} onConfirm={purge} pending={pending === dialog.item.id} />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RecoverAsDialog item={dialog.item} onClose={() => setDialog(null)} onConfirm={recover} pending={pending === dialog.item.id} />
      ) : null}
    </div>
  );
}

function TrashTable({
  items, nextCursor, onLoadMore, onPurge, onRecover, pending, projectNames,
}: {
  readonly items: readonly TrashedItem[];
  readonly nextCursor: string | null;
  readonly onLoadMore: (cursor: string) => Promise<void>;
  readonly onPurge: (item: TrashedItem) => void;
  readonly onRecover: (item: TrashedItem) => void;
  readonly pending: string | null;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  return (
    <section className="grid gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{trashText.columns.name}</TableHead>
            <TableHead>{trashText.columns.kind}</TableHead>
            <TableHead>{trashText.columns.location}</TableHead>
            <TableHead>{trashText.columns.trashedAt}</TableHead>
            <TableHead>{trashText.columns.trashedBy}</TableHead>
            <TableHead><span className="sr-only">{trashText.columns.actions}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-medium">
                {item.name}
                {item.kind === "artifact" && item.trashGroupId !== null ? (
                  <span className="block text-xs text-muted-foreground">{trashText.group}</span>
                ) : null}
              </TableCell>
              <TableCell>{item.kind === "folder" ? trashText.folderContents(item.artifactCount) : kindLabel(item.fileKind)}</TableCell>
              <TableCell>{[projectNames.get(item.projectId) ?? item.projectId, ...item.location.path.map(({name}) => name)].join(" › ")}</TableCell>
              <TableCell>{formatTimestamp(item.trashedAt)}</TableCell>
              <TableCell>{item.trashedBy ?? ""}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    aria-label={`${trashText.recover} ${item.name}`}
                    disabled={pending !== null}
                    onClick={() => onRecover(item)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {pending === item.id ? trashText.recovering : trashText.recover}
                  </Button>
                  <Button
                    aria-label={`${trashText.purge} ${item.name}`}
                    disabled={pending !== null}
                    onClick={() => onPurge(item)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {trashText.purge}
                  </Button>
                </div>
              </TableCell>
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
            {trashText.loadMore}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Purge keeps the typed confirmation that Move to Trash no longer needs. */
function PurgeDialog({
  item, onClose, onConfirm, pending,
}: {
  readonly item: TrashedItem;
  readonly onClose: () => void;
  readonly onConfirm: (item: TrashedItem, confirm: string) => Promise<void>;
  readonly pending: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value === item.name) void onConfirm(item, value);
  };
  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{trashText.purgeTitle(item.name)}</DialogTitle>
            <DialogDescription>
              {trashText.purgeDescription}
              {item.kind === "folder" ? ` ${trashText.purgeFolderDescription}` : ""}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            <span>{trashText.purgeLabel}</span>
            <Input autoComplete="off" autoFocus onChange={(event) => setValue(event.currentTarget.value)} value={value} />
          </label>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">{folderText.cancel}</Button>
            <Button disabled={pending || value !== item.name} type="submit">
              {pending ? trashText.purging : trashText.purge}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecoverAsDialog({
  item, onClose, onConfirm, pending,
}: {
  readonly item: TrashedItem;
  readonly onClose: () => void;
  readonly onConfirm: (item: TrashedItem, name: string) => Promise<void>;
  readonly pending: boolean;
}) {
  const [value, setValue] = useState(item.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== "") void onConfirm(item, value);
  };
  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{trashText.recover} {item.name}</DialogTitle>
            <DialogDescription>{trashText.nameTaken}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            <span>{trashText.newName}</span>
            <Input autoComplete="off" autoFocus onChange={(event) => setValue(event.currentTarget.value)} value={value} />
          </label>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">{folderText.cancel}</Button>
            <Button disabled={pending || value.trim() === ""} type="submit">
              {pending ? trashText.recovering : trashText.recoverAs}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One-click Move to Trash for the Details inspector; Undo replaces confirmation. */
export function MoveToTrashButton({onTrash}: {readonly onTrash: () => Promise<boolean>}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      className="as-button as-button--danger"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void onTrash().finally(() => setPending(false));
      }}
      type="button"
    >
      {pending ? trashText.moving : trashText.moveToTrash}
    </button>
  );
}

/** What the Undo toast needs to call recover for the item just trashed. */
export interface TrashedArtifact {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
}

const undoToastMilliseconds = 8_000;

/** The Undo toast shown after Move to Trash; Undo recovers the artifact. */
export interface TrashUndo {
  readonly element: ReactNode;
  readonly trashed: (artifact: TrashedArtifact) => void;
}

export function useTrashUndo(onRecovered: (artifact: TrashedArtifact) => Promise<void>): TrashUndo {
  const [toast, setToast] = useState<{readonly artifact?: TrashedArtifact; readonly text: string} | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<number | null>(null);
  const show = useCallback((next: {readonly artifact?: TrashedArtifact; readonly text: string}) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast(next);
    timer.current = window.setTimeout(() => setToast(null), undoToastMilliseconds);
  }, []);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const undo = async (artifact: TrashedArtifact) => {
    setPending(true);
    try {
      const recovery = await api.recoverTrashed({kind: "artifact", ...artifact}, crypto.randomUUID());
      show({text: recoveryNotice(artifact.name, recovery)});
      await onRecovered(artifact);
    } catch (caught) {
      show({text: errorMessage((caught instanceof Error ? caught : new Error(trashText.unavailable)))});
    } finally {
      setPending(false);
    }
  };
  const element = toast === null ? null : (
    <section
      className="fixed bottom-4 left-1/2 z-50 flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--color-rule-2)] bg-popover p-3 text-sm text-popover-foreground"
      role="status"
    >
      <p className="min-w-0 leading-5">{toast.text}</p>
      {toast.artifact === undefined ? null : (
        <Button
          className="shrink-0"
          disabled={pending}
          onClick={() => { if (toast.artifact !== undefined) void undo(toast.artifact); }}
          size="xs"
          type="button"
          variant="outline"
        >
          {trashText.undo}
        </Button>
      )}
    </section>
  );
  return {element, trashed: (artifact) => show({artifact, text: trashText.movedToTrash(artifact.name)})};
}

function recoveryNotice(name: string, recovery: Recovery): string {
  const base = recovery.placement === "root" ? trashText.recoveredToRoot(name) : trashText.recovered(name);
  const wasPublic = recovery.previousAccessSetting === "public_link"
    || (recovery.previouslyPublicArtifactIds?.length ?? 0) > 0;
  return wasPublic ? `${base} ${trashText.recoveredPrivate}` : base;
}

function kindLabel(kind: string | null): string {
  const labels: Readonly<Record<string, string>> = folderText.kinds;
  return kind === null ? folderText.kinds.other : labels[kind] ?? folderText.kinds.other;
}

