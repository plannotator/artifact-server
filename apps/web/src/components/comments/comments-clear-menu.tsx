import { useState } from "react";

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { api, type CommentClearResult } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorMessage } from "@/lib/presentation";

type ClearScope = "all" | "resolved";

function clearedSentence(result: CommentClearResult): string {
  const deleted = result.deleted === 1
    ? "1 comment thread was deleted"
    : `${result.deleted} comment threads were deleted`;
  if (result.skippedDispatched === 0) return `${deleted}.`;
  const kept = result.skippedDispatched === 1
    ? "1 thread is with an agent and was kept"
    : `${result.skippedDispatched} threads are with an agent and were kept`;
  return `${deleted}. ${kept} — cancel its send first to clear it.`;
}

/**
 * The comments panel's overflow menu: bulk clearing, behind one confirm.
 *
 * Single sends lost their dialog; bulk destruction keeps its confirm. The
 * asymmetry is deliberate — irreversible times many. Threads an active send
 * carries are never deleted; the result says how many were kept that way.
 */
export function CommentsClearMenu({
  artifactId,
  canClearAll,
  onCleared,
  projectId,
  scopeLabel,
  versionId,
}: {
  readonly artifactId: string;
  /** Clearing every thread regardless of state is for managers only. */
  readonly canClearAll: boolean;
  readonly onCleared: () => Promise<void>;
  readonly projectId: string;
  /** Where the clear reaches, in words: the artifact or one version of it. */
  readonly scopeLabel: string;
  /** Bound the clear to one version, or null for the whole artifact. */
  readonly versionId: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scope, setScope] = useState<ClearScope | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<CommentClearResult | null>(null);

  const openConfirm = (nextScope: ClearScope) => {
    setMenuOpen(false);
    setScope(nextScope);
    setError(null);
    setResult(null);
  };

  const closeConfirm = (nextOpen: boolean) => {
    if (nextOpen) return;
    setScope(null);
    setError(null);
    setResult(null);
  };

  const clear = async () => {
    if (scope === null) return;
    setPending(true);
    setError(null);
    try {
      const cleared = await api.clearComments(
        projectId,
        artifactId,
        scope,
        versionId,
      );
      setResult(cleared);
      await onCleared();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Clearing failed."),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Popover onOpenChange={setMenuOpen} open={menuOpen}>
        <PopoverTrigger
          render={(
            <Button
              aria-label="More comment actions"
              size="icon-xs"
              type="button"
              variant="outline"
            />
          )}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.8} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 gap-1 p-1">
          <Button
            className="justify-start"
            onClick={() => openConfirm("resolved")}
            size="xs"
            type="button"
            variant="ghost"
          >
            Clear resolved…
          </Button>
          {canClearAll
            ? (
              <Button
                className="justify-start text-destructive"
                onClick={() => openConfirm("all")}
                size="xs"
                type="button"
                variant="ghost"
              >
                Clear all…
              </Button>
            )
            : null}
        </PopoverContent>
      </Popover>

      <Dialog onOpenChange={closeConfirm} open={scope !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {scope === "all" ? "Clear all comments" : "Clear resolved comments"}
            </DialogTitle>
            <DialogDescription>
              {result === null
                ? `${
                  scope === "all"
                    ? "Every comment thread"
                    : "Every resolved comment thread"
                } on ${scopeLabel} is deleted for everybody, with its replies. Threads that are with an agent right now are kept. This cannot be undone.`
                : clearedSentence(result)}
            </DialogDescription>
          </DialogHeader>
          {error === null
            ? null
            : (
              <p className="text-sm leading-6 text-destructive">
                {errorMessage(error)}
              </p>
            )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              {result === null ? "Cancel" : "Close"}
            </DialogClose>
            {result === null
              ? (
                <Button
                  disabled={pending}
                  onClick={() => void clear()}
                  type="button"
                  variant="destructive"
                >
                  {pending
                    ? "Clearing…"
                    : scope === "all"
                      ? "Clear all comments"
                      : "Clear resolved comments"}
                </Button>
              )
              : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
