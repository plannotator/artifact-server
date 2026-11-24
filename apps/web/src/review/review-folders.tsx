import {Dialog} from "@base-ui/react/dialog";
import {useEffect, useState} from "react";
import type {FormEvent, ReactNode} from "react";

import {
  api, ApiError, type Artifact, type ArtifactLocation, type Folder, type FolderPage, type Project,
} from "@/api/client";
import {folderText} from "@/i18n/messages/folders";
import {displayError} from "@/lib/presentation";

type Subject = {readonly kind: "folder"; readonly record: Folder}
  | {readonly kind: "artifact"; readonly record: Artifact};

export type FolderDialogAction =
  | {readonly kind: "create"; readonly parent: string | null}
  | {readonly kind: "rename" | "move"; readonly subject: Subject}
  | {readonly kind: "delete"; readonly folder: Folder};

export function FolderBreadcrumbs({
  root, folders, onNavigate,
}: {
  readonly root: string;
  readonly folders: readonly Folder[];
  readonly onNavigate?: (id: string | null) => void;
}) {
  const crumbs = [{id: null, name: root}, ...folders];
  return (
    <nav aria-label={folderText.location} className="as-folder-breadcrumbs">
      <ol>
        {crumbs.map(({id, name}, index) => (
          <li key={id ?? "root"}>
            {index === crumbs.length - 1 ? <span aria-current="location">{name}</span>
              : onNavigate === undefined ? <span>{name}</span>
              : <button type="button" className="as-button as-button--ghost" onClick={() => onNavigate(id)}>{name}</button>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ArtifactFolderLocation({
  artifact, projectName, children,
}: {
  readonly artifact: Artifact;
  readonly projectName: string;
  readonly children?: ReactNode;
}) {
  const [path, setPath] = useState<FolderPage["breadcrumbs"]>([]);
  const [error, setError] = useState<string | null>(null);
  const folderId = artifact.folderId ?? null;
  useEffect(() => {
    if (folderId === null) return undefined;
    let current = true;
    void (async () => {
      try {
        const page = await api.folders(artifact.projectId, folderId);
        if (current) setPath(page.breadcrumbs);
      } catch (cause) {
        if (current) setError(errorText(cause));
      }
    })();
    return () => { current = false; };
  }, [artifact.projectId, folderId]);
  return (
    <section className="as-inspector-section">
      <h3>{folderText.location}</h3>
      {error === null ? <FolderBreadcrumbs root={projectName} folders={path} />
        : <p role="alert">{error}</p>}
      <div className="as-inspector-actions">{children}</div>
    </section>
  );
}

type PlacementResult = Awaited<ReturnType<typeof api.moveArtifact>>["artifact"];

/** The record a dialog changed, when the caller may need to follow it to a new place. */
export type FolderDialogResult =
  | {readonly kind: "artifact"; readonly artifact: PlacementResult}
  | {readonly kind: "folder"; readonly folder: Folder};

/**
 * Find where an artifact went when an old project-scoped Review link no longer
 * resolves. Readers without installation-wide read receive not-found, so the
 * link simply stays unavailable for them.
 */
export async function locateMovedArtifact(artifactId: string, projectId: string): Promise<ArtifactLocation | null> {
  try {
    const {location} = await api.locateArtifact(artifactId);
    return location.projectId === projectId ? null : location;
  } catch {
    return null;
  }
}

export function FolderDialog({
  action, projectId, projectName, projects = [], onClose, onChanged,
}: {
  readonly action: FolderDialogAction;
  readonly projectId: string;
  readonly projectName: string;
  /** Active projects a move may target; empty when cross-project moves are unavailable. */
  readonly projects?: readonly Project[];
  readonly onClose: () => void;
  readonly onChanged: (result?: FolderDialogResult) => void;
}) {
  const [name, setName] = useState(action.kind === "rename" ? action.subject.record.name : "");
  const [destination, setDestination] = useState<string | null>(null);
  const [destinationProjectId, setDestinationProjectId] = useState(projectId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const title = dialogTitle(action);
  const destinationProject = projects.find(({id}) => id === destinationProjectId);
  const crossProject = destinationProjectId !== projectId;

  const confirm = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await saveFolderChange(action, projectId, name, destination, key, destinationProjectId);
      onChanged(result);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="as-confirm-dialog__backdrop" />
        <Dialog.Popup className="as-confirm-dialog as-folder-dialog">
          <Dialog.Title>{title}</Dialog.Title>
          {action.kind === "move" && projects.length > 1 ? (
            <div className="as-folder-picker__project">
              <label>
                {folderText.project}
                <select disabled={pending} value={destinationProjectId} onChange={(event) => {
                  setDestinationProjectId(event.currentTarget.value);
                  setDestination(null);
                  setError(null);
                  setKey(crypto.randomUUID());
                }}>
                  {projects.map(({id, name: label}) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              {crossProject ? <p>{folderText.crossProjectNote}</p> : null}
            </div>
          ) : null}
          {action.kind === "move" ? (
            <FolderDestinationPicker
              key={destinationProjectId}
              projectId={destinationProjectId}
              projectName={crossProject ? destinationProject?.name ?? folderText.root : projectName}
              excludedId={action.subject.kind === "folder" && !crossProject ? action.subject.record.id : null}
              destination={destination}
              onNavigate={(id) => {setDestination(id); setKey(crypto.randomUUID());}}
              disabled={pending}
            />
          ) : null}
          <form onSubmit={(event) => void confirm(event)}>
            {action.kind === "create" || action.kind === "rename" ? (
              <label>
                {folderText.name}
                <input disabled={pending} required value={name}
                  onChange={(event) => {setName(event.currentTarget.value); setKey(crypto.randomUUID());}} />
              </label>
            ) : null}
            {action.kind === "delete" ? <Dialog.Description>{folderText.deleteDescription}</Dialog.Description> : null}
            {error === null ? null : <p role="alert" className="as-inspector-error">{error}</p>}
            <div className="as-confirm-dialog__actions">
              <Dialog.Close className="as-button" disabled={pending}>{folderText.cancel}</Dialog.Close>
              <button className={action.kind === "delete" ? "as-button as-button--danger" : "as-button as-button--primary"}
                disabled={pending} type="submit">
                {pending ? folderText.saving : submitLabel(action)}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function FolderDestinationPicker({
  projectId, projectName, excludedId, destination, onNavigate, disabled,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly excludedId: string | null;
  readonly destination: string | null;
  readonly onNavigate: (id: string | null) => void;
  readonly disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<FolderPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const loaded = await api.folders(projectId, destination, query);
        if (current) setPage(loaded);
      } catch (cause) {
        if (current) setError(errorText(cause));
      }
    })();
    return () => {current = false;};
  }, [destination, query, projectId]);

  const navigate = (id: string | null): void => {
    setPage(null);
    setError(null);
    setQuery("");
    onNavigate(id);
  };
  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const {folder} = await api.createFolder(projectId, destination, newName, crypto.randomUUID());
      setNewName("");
      navigate(folder.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  };

  const more = async (): Promise<void> => {
    if (page === null || page.nextCursor === null) return;
    try {
      const loaded = await api.folders(projectId, destination, query, page.nextCursor);
      setPage((current) => current !== page ? current : {...loaded, folders: [...current.folders, ...loaded.folders]});
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const folders = page?.folders.filter(({id}) => id !== excludedId) ?? [];
  return (
    <fieldset disabled={disabled || creating} className="as-folder-picker">
      <FolderBreadcrumbs root={projectName} folders={page?.breadcrumbs ?? []} onNavigate={navigate} />
      <label>
        {folderText.search}
        <input maxLength={200} value={query} onChange={(event) => {
          setPage(null);
          setError(null);
          setQuery(event.currentTarget.value);
        }} />
      </label>
      <div className="as-folder-picker__list" aria-busy={page === null && error === null}>
        {page === null && error === null ? <p>{folderText.loading}</p> : null}
        {page !== null && folders.length === 0 ? <p>{folderText.noDestinations}</p> : null}
        {folders.map(({id, name}) => (
          <button key={id} type="button" className="as-button as-button--ghost" onClick={() => navigate(id)}>
            {name} <span aria-hidden="true">›</span>
          </button>
        ))}
        {page === null || page.nextCursor === null ? null : (
          <button type="button" className="as-button" onClick={() => void more()}>{folderText.loadMore}</button>
        )}
      </div>
      <form className="as-folder-picker__new" onSubmit={(event) => void create(event)}>
        <label>
          {folderText.newFolder}
          <input required value={newName} onChange={(event) => setNewName(event.currentTarget.value)} />
        </label>
        <button className="as-button" type="submit" disabled={!newName.trim()}>{folderText.newFolder}</button>
      </form>
      {error === null ? null : <p role="alert" className="as-inspector-error">{error}</p>}
    </fieldset>
  );
}

function dialogTitle(action: FolderDialogAction): string {
  switch (action.kind) {
    case "create": return folderText.newFolder;
    case "delete": return folderText.deleteTitle(action.folder.name);
    case "rename": return folderText.renameTitle(visibleArtifactName(action.subject.record.name));
    case "move": return folderText.moveTitle(visibleArtifactName(action.subject.record.name));
    default: return action satisfies never;
  }
}

function submitLabel(action: FolderDialogAction): string {
  switch (action.kind) {
    case "create": return folderText.newFolder;
    case "delete": return folderText.delete;
    case "rename": return folderText.save;
    case "move": return folderText.moveHere;
    default: return action satisfies never;
  }
}

async function saveFolderChange(
  action: FolderDialogAction, projectId: string, name: string, destination: string | null, key: string,
  destinationProjectId: string,
): Promise<FolderDialogResult | undefined> {
  switch (action.kind) {
    case "create":
      await api.createFolder(projectId, action.parent, name, key);
      return undefined;
    case "delete":
      await api.deleteFolder(action.folder, key);
      return undefined;
    case "rename":
      if (action.subject.kind === "artifact") {
        return {kind: "artifact", artifact: (await api.renameArtifact(action.subject.record, name, key)).artifact};
      }
      await api.updateFolder(action.subject.record, {name}, key);
      return undefined;
    case "move": {
      const {subject} = action;
      if (subject.kind === "artifact") {
        return {kind: "artifact", artifact: (await api.moveArtifact(subject.record, destination, key, destinationProjectId)).artifact};
      }
      const {folder} = destinationProjectId === subject.record.projectId
        ? await api.updateFolder(subject.record, {parentFolderId: destination}, key)
        : await api.moveFolderToProject(subject.record, destinationProjectId, destination, key);
      return {kind: "folder", folder};
    }
    default: return action satisfies never;
  }
}

export function visibleArtifactName(name: string): string {
  return name.replace(/\p{Bidi_Control}/gu, (character) =>
    `[U+${character.codePointAt(0)?.toString(16).toUpperCase()}]`);
}

function errorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.code === "INVALID_INPUT" ? folderText.invalidName : displayError(cause);
  }
  return folderText.failed;
}
