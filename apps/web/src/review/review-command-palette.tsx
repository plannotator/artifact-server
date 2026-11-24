import {useEffect, useState} from "react";

import {api, type ArtifactPage} from "@/api/client";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {refinementText} from "@/i18n/messages/review-refinements";

interface Command {
  readonly label: string;
  readonly run: () => void;
}

const text = refinementText.palette;

/** Project search is independent of the catalog's filters and current page. */
export function ReviewCommandPalette({
  commands,
  onClose,
  onSelect,
  projectId,
}: {
  readonly commands: readonly Command[];
  readonly onClose: () => void;
  readonly onSelect: (artifactId: string, versionId: string) => void;
  readonly projectId: string;
}) {
  const [query, setQuery] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);
  const search = query.trim().toLowerCase();
  const [result, setResult] = useState<{
    readonly items: ArtifactPage["artifacts"];
    readonly query: string;
  } | null>(null);

  useEffect(() => {
    if (search === "" || projectId === "") return undefined;
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const {artifacts} = await api.artifacts(projectId, null, [], search);
        if (current) setResult({items: artifacts, query: search});
      } catch {
        if (current) setResult({items: [], query: search});
      }
    };
    void load();
    return () => { current = false; };
  }, [projectId, search]);

  const matches = commands.filter((command) => command.label.toLowerCase().includes(search));
  const artifacts = result?.query === search ? result.items : [];
  const entries: readonly Command[] = [...artifacts.map(({artifact}) => ({
    label: artifact.name,
    run: () => onSelect(artifact.id, artifact.currentVersionId),
  })), ...matches];

  const run = (command: Command): void => {
    onClose();
    command.run();
  };

  const first = entries[0];
  const pending = search !== "" && projectId !== "" && result?.query !== search;
  useEffect(() => {
    if (submittedSearch !== search || pending) return;
    setSubmittedSearch(null);
    if (first !== undefined) {
      onClose();
      first.run();
    }
  }, [first, onClose, pending, search, submittedSearch]);

  return (
    <form className="grid min-h-0 gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (pending && matches.length === 0) setSubmittedSearch(search);
      else if (first !== undefined) run(first);
    }}>
      <input aria-label={text.search} className="as-input w-full" onChange={(event) => {
        setSubmittedSearch(null);
        setQuery(event.target.value);
      }}
        placeholder={text.search} type="search" value={query} />
      <div className="grid max-h-[50vh] gap-1 overflow-auto">
        {entries.map((command, index) => (
          <button className="as-button justify-start text-left" key={`${command.label}-${index}`}
            onClick={() => run(command)} type="button">
            {command.label}
          </button>
        ))}
        {entries.length === 0 && (result?.query === search || projectId === "") ? (
          <p className="text-sm text-muted-foreground" role="status">{text.noResults}</p>
        ) : null}
      </div>
    </form>
  );
}

/** A modal surface shared by the palette and shortcut sheet. */
export function ReviewKeyboardDialog({
  children,
  close,
  restoreFocus,
  title,
}: {
  readonly children: React.ReactNode;
  readonly close: () => void;
  readonly restoreFocus: HTMLElement | null;
  readonly title: string;
}) {
  return (
    <Dialog onOpenChange={(open) => { if (!open) close(); }} open>
      <DialogContent
        className="as-review-keyboard-dialog"
        finalFocus={() => restoreFocus}
        initialFocus={(interaction) => interaction === "touch"
          ? true
          : document.querySelector<HTMLInputElement>(".as-review-keyboard-dialog input[type='search']") ?? true}
      >
        <DialogTitle>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
