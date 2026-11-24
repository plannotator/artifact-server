import { useEffect, useMemo, useState } from "react";

import {reviewPartsText} from "@/i18n/messages/review-parts";
import {displayError, formatBytes} from "@/lib/presentation";

import {
  PreviewState,
  TerminalPreviewState,
  type PreviewActions,
  type PreviewEntry,
} from "./preview-states.tsx";

const text = reviewPartsText.preview;

/** Text and source previews read at most this many leading bytes. */
export const textPreviewByteLimit = 1024 * 1024;

/**
 * Decode leading file bytes as UTF-8. Invalid sequences become U+FFFD, a
 * leading byte-order mark is dropped, and when the bytes are a cut prefix a
 * multi-byte character split by the cut is held back instead of becoming a
 * replacement character.
 */
export function decodePreviewText(bytes: Uint8Array, complete: boolean): string {
  return new TextDecoder("utf-8").decode(bytes, {stream: !complete});
}

/** Split on CRLF, CR, or LF; a final line terminator adds no empty line. */
export function previewLines(value: string): readonly string[] {
  const lines = value.split(/\r\n|\r|\n/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

type TextLoad =
  | {readonly state: "loading"}
  | {readonly error: Error; readonly state: "failed"}
  | {readonly complete: boolean; readonly state: "ready"; readonly value: string};

/**
 * Render an exact-version file as text nodes with line numbers. Nothing from
 * the file is ever interpreted as markup: React writes it as one text node.
 */
export function TextPreview({
  actions,
  entry,
  readBytes,
}: {
  readonly actions: PreviewActions;
  readonly entry: PreviewEntry;
  readonly readBytes: (byteLimit: number | null) => Promise<Uint8Array>;
}) {
  const [load, setLoad] = useState<TextLoad>({state: "loading"});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const complete = entry.size <= textPreviewByteLimit;
    setLoad({state: "loading"});
    void (async () => {
      try {
        const bytes = await readBytes(complete ? null : textPreviewByteLimit);
        if (current) {
          setLoad({complete, state: "ready", value: decodePreviewText(bytes, complete)});
        }
      } catch (cause) {
        if (current) {
          setLoad({
            error: cause instanceof Error ? cause : new Error(text.failed),
            state: "failed",
          });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, entry.size, readBytes]);

  const lines = useMemo(
    () => load.state === "ready" ? previewLines(load.value) : [],
    [load],
  );

  if (load.state === "loading") {
    return <PreviewState description={text.loadingPath(entry.path)} title={text.loadingTitle} />;
  }
  if (load.state === "failed") {
    return (
      <TerminalPreviewState
        actions={actions}
        description={displayError(load.error)}
        mediaType={entry.mediaType}
        onRetry={() => setAttempt((value) => value + 1)}
        path={entry.path}
        size={entry.size}
        title={text.textUnavailableTitle}
      />
    );
  }
  return (
    <div className="as-text-preview" data-complete={load.complete}>
      {load.complete ? null : (
        <p className="as-preview-notice" role="note">
          <span>{text.textTruncated(formatBytes(textPreviewByteLimit), formatBytes(entry.size))}</span>
          {actions.downloadUrl === null ? null : (
            <a className="as-button" download href={actions.downloadUrl}>{text.download}</a>
          )}
        </p>
      )}
      {/* A focusable region so keyboard users can scroll long lines and files. */}
      <div
        aria-label={text.textRegionLabel(entry.path)}
        className="as-text-preview__scroll"
        role="region"
        tabIndex={0}
      >
        <pre aria-hidden="true" className="as-text-preview__gutter">
          {lines.map((_, index) => index + 1).join("\n")}
        </pre>
        <pre className="as-text-preview__code"><code>{lines.join("\n")}</code></pre>
      </div>
    </div>
  );
}
