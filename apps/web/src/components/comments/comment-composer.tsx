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
  initialBody,
  inputId,
  label,
  maximumCharacters,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  readonly cancelLabel: string | null;
  readonly initialBody: string;
  readonly inputId: string;
  readonly label: string;
  readonly maximumCharacters: number;
  readonly onCancel: (() => void) | null;
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
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <Textarea
        aria-describedby={tooLong ? `${inputId}-limit` : undefined}
        aria-invalid={tooLong}
        disabled={pending}
        id={inputId}
        onChange={(event) => setBody(event.currentTarget.value)}
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
