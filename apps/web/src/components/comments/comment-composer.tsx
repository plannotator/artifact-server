import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Bounded comment body editor.
 *
 * One mounted composer is one compose attempt: its idempotency key is minted
 * on the first submission and reused for every retry until the server accepts
 * the text, so a retried create can never duplicate a comment.
 */
export function CommentComposer({
  cancelLabel,
  draftRestored = false,
  initialBody,
  inputId,
  label,
  maximumCharacters,
  onBodyChange,
  onCancel,
  onDiscardDraft,
  onSubmit,
  submitLabel,
}: {
  readonly cancelLabel: string | null;
  /** True when `initialBody` came out of the draft store, not the caller. */
  readonly draftRestored?: boolean;
  readonly initialBody: string;
  readonly inputId: string;
  readonly label: string;
  readonly maximumCharacters: number;
  /** Draft wiring: hears every edit, including the clearing submit/discard. */
  readonly onBodyChange?: (body: string) => void;
  readonly onCancel: (() => void) | null;
  readonly onDiscardDraft?: () => void;
  readonly onSubmit: (body: string, idempotencyKey: string) => Promise<boolean>;
  readonly submitLabel: string;
}) {
  const [body, setBody] = useState(initialBody);
  const [pending, setPending] = useState(false);
  const attemptKey = useRef<string | null>(null);
  const trimmed = body.trim();
  const tooLong = trimmed.length > maximumCharacters;

  const submit = async () => {
    if (trimmed === "" || tooLong) return;
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    const accepted = await onSubmit(trimmed, attemptKey.current);
    setPending(false);
    if (!accepted) return;
    attemptKey.current = null;
    setBody("");
    onBodyChange?.("");
  };

  const discardDraft = () => {
    setBody("");
    onDiscardDraft?.();
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        {draftRestored && trimmed !== "" ? (
          <span className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground" data-draft-marker>
              Draft
            </span>
            {onDiscardDraft === undefined ? null : (
              <button
                className="text-xs text-muted-foreground underline"
                onClick={discardDraft}
                type="button"
              >
                Discard
              </button>
            )}
          </span>
        ) : null}
      </div>
      <Textarea
        aria-describedby={tooLong ? `${inputId}-limit` : undefined}
        aria-invalid={tooLong}
        disabled={pending}
        id={inputId}
        onChange={(event) => {
          setBody(event.currentTarget.value);
          onBodyChange?.(event.currentTarget.value);
        }}
        placeholder="Describe what should change and why."
        value={body}
      />
      {tooLong
        ? (
          <p className="text-xs text-destructive" id={`${inputId}-limit`}>
            {`A comment holds at most ${maximumCharacters} characters. Remove ${
              trimmed.length - maximumCharacters
            }.`}
          </p>
        )
        : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || trimmed === "" || tooLong}
          onClick={() => void submit()}
          size="xs"
          type="button"
        >
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel === null || cancelLabel === null
          ? null
          : (
            <Button
              disabled={pending}
              onClick={onCancel}
              size="xs"
              type="button"
              variant="ghost"
            >
              {cancelLabel}
            </Button>
          )}
      </div>
    </div>
  );
}
