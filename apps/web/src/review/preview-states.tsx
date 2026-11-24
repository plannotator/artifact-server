import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {reviewPartsText} from "@/i18n/messages/review-parts";
import {formatBytes} from "@/lib/presentation";

const text = reviewPartsText.preview;

/** The recovery actions every settled preview offers. */
export interface PreviewActions {
  readonly downloadUrl: string | null;
  readonly onOpenRawArtifact: () => void;
  readonly opening: boolean;
}

/** One manifest entry as a presenter sees it. */
export interface PreviewEntry {
  readonly mediaType: string;
  readonly path: string;
  readonly size: number;
}

/** An honest terminal state: what the file is and how to reach it anyway. */
export function TerminalPreviewState({
  actions,
  description,
  mediaType,
  onRetry,
  path,
  size,
  title,
}: {
  readonly actions: PreviewActions;
  readonly description: string;
  readonly mediaType: string;
  readonly onRetry?: (() => void) | undefined;
  readonly path: string;
  readonly size: number | null;
  readonly title: string;
}) {
  return (
    <div className="as-preview-state as-preview-state--terminal" data-tone="error" role="alert">
      <span aria-hidden="true" className="as-preview-state__mark" />
      <h3>{title}</h3>
      <p>{description}</p>
      <dl className="as-preview-state__details">
        <div><dt>{text.pathLabel}</dt><dd><code>{path}</code></dd></div>
        <div><dt>{text.typeLabel}</dt><dd><code>{mediaType}</code></dd></div>
        {size === null ? null : (
          <div><dt>{text.sizeLabel}</dt><dd>{formatBytes(size)}</dd></div>
        )}
      </dl>
      <div className="as-preview-state__actions">
        {onRetry === undefined ? null : (
          <button className="as-button" onClick={onRetry} type="button">{text.retry}</button>
        )}
        <button
          className="as-button as-button--primary"
          disabled={actions.opening}
          onClick={actions.onOpenRawArtifact}
          type="button"
        >
          <HugeiconsIcon aria-hidden="true" icon={ExternalLinkIcon} strokeWidth={1.8} />
          {actions.opening ? text.opening : text.openRaw}
        </button>
        {actions.downloadUrl === null ? null : (
          <a className="as-button" download href={actions.downloadUrl}>{text.download}</a>
        )}
      </div>
    </div>
  );
}

export function PreviewState({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <div className="as-preview-state" role="status">
      <span aria-hidden="true" className="as-preview-state__mark" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
