import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type ArtifactVersion,
} from "@/api/client";
import {reviewPartsText} from "@/i18n/messages/review-parts";
import {displayError} from "@/lib/presentation";
import {
  frameMessageSchema,
  reviewProtocolVersion,
  type HostMessage,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

import {DataPreview} from "./data-preview.tsx";
import {markdownPreviewDocument} from "./markdown-document.ts";
import {previewPresenter} from "./preview-kind.ts";
import {
  PreviewState,
  TerminalPreviewState,
  type PreviewActions,
  type PreviewEntry,
} from "./preview-states.tsx";
import {TextPreview} from "./text-preview.tsx";
import "./review-preview.css";

const text = reviewPartsText.preview;

interface PreviewDocument {
  readonly baseHref: string | null;
  readonly entryPath: string;
  readonly html: string;
}

/**
 * How one fetched source becomes the document the review frame renders, given
 * the exact version's content-host directory for that entry.
 */
type FrameDocumentRenderer = (
  source: string,
  documentBaseHref: string,
) => {readonly baseHref: string | null; readonly html: string};

const htmlFrameDocument: FrameDocumentRenderer = (source, documentBaseHref) => ({
  baseHref: documentBaseHref,
  html: source,
});

/**
 * Markdown becomes a complete document with every URL already resolved, so the
 * review frame passes it through untouched instead of re-parsing it to add a
 * base URL.
 */
const markdownFrameDocument: FrameDocumentRenderer = (source, documentBaseHref) => ({
  baseHref: null,
  html: markdownPreviewDocument(source, documentBaseHref),
});

/** Render one exact immutable manifest entry in the Artifact Server preview surface. */
export function ReviewPreview({
  annotateModeActive,
  annotations,
  artifactId,
  artifactName,
  isLight,
  onOpenRawArtifact,
  onAnnotateModeChange,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  opening,
  projectId,
  readOnly,
  selectedThreadId,
  selectedPath,
  version,
}: {
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly artifactName: string;
  readonly isLight: boolean;
  readonly onOpenRawArtifact: () => void;
  readonly onAnnotateModeChange: (active: boolean) => void;
  readonly onSelectAnnotation: (threadId: string | null) => void;
  readonly onSubmitAnnotation: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ) => Promise<boolean>;
  readonly onUnanchoredChange: (threadIds: readonly string[]) => void;
  readonly opening: boolean;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly selectedThreadId: string | null;
  readonly selectedPath: string | null;
  readonly version: ArtifactVersion | null;
}) {
  if (version === null) {
    return (
      <PreviewState
        description={text.loadingVersion}
        title={text.loadingTitle}
      />
    );
  }
  const path = selectedPath ?? version.manifest.entryPath;
  const entry = version.manifest.entries.find(
    (candidate) => candidate.path === path,
  );
  const commonActions: PreviewActions = {
    downloadUrl: entry === undefined
      ? null
      : api.versionFileUrl(projectId, artifactId, version.version.id, entry.path),
    onOpenRawArtifact,
    opening,
  };
  if (entry === undefined) {
    return (
      <TerminalPreviewState
        actions={commonActions}
        description={text.notFoundDescription}
        mediaType="unknown"
        path={path}
        size={null}
        title={text.notFoundTitle}
      />
    );
  }
  const presenter = previewPresenter(entry.mediaType);
  const identity = `${version.version.id}:${entry.path}`;
  const versionId = version.version.id;
  const frameProps = {
    actions: commonActions,
    annotateModeActive,
    annotations,
    artifactId,
    entry,
    isLight,
    onAnnotateModeChange,
    onSelectAnnotation,
    onSubmitAnnotation,
    onUnanchoredChange,
    projectId,
    readOnly,
    selectedThreadId,
    version,
  };
  if (presenter.kind === "html") {
    return <HtmlPreview {...frameProps} key={identity} renderDocument={htmlFrameDocument} />;
  }
  if (presenter.kind === "markdown") {
    return (
      <MarkdownPreview
        artifactId={artifactId}
        frameProps={frameProps}
        key={identity}
        projectId={projectId}
      />
    );
  }
  if (
    presenter.kind === "image"
    || presenter.kind === "video"
    || presenter.kind === "audio"
  ) {
    return (
      <NativeMediaPreview
        actions={commonActions}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        kind={presenter.kind}
        onProbe={() => api.probeVersionMedia(projectId, artifactId, versionId, entry.path)}
        source={api.versionMediaUrl(projectId, artifactId, versionId, entry.path)}
      />
    );
  }
  if (presenter.kind === "pdf") {
    return (
      <PdfPreview
        actions={commonActions}
        artifactId={artifactId}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        projectId={projectId}
        versionId={versionId}
      />
    );
  }
  if (presenter.kind === "text") {
    return (
      <EntryTextPreview
        actions={commonActions}
        artifactId={artifactId}
        entry={entry}
        key={identity}
        projectId={projectId}
        versionId={versionId}
      />
    );
  }
  if (presenter.kind === "data") {
    return (
      <EntryDataPreview
        actions={commonActions}
        artifactId={artifactId}
        entry={entry}
        format={presenter.format}
        key={identity}
        projectId={projectId}
        versionId={versionId}
      />
    );
  }
  return (
    <TerminalPreviewState
      actions={commonActions}
      description={text.unsupportedDescription}
      mediaType={entry.mediaType}
      path={entry.path}
      size={entry.size}
      title={text.unsupportedTitle}
    />
  );
}

/**
 * One bounded reader of an entry's leading bytes, stable for the selection so
 * a presenter's load effect runs once per entry and retry.
 */
function useEntryBytes(
  projectId: string,
  artifactId: string,
  versionId: string,
  path: string,
): (byteLimit: number | null) => Promise<Uint8Array> {
  return useCallback(
    (byteLimit: number | null) =>
      api.versionFileBytes(projectId, artifactId, versionId, path, byteLimit),
    [artifactId, path, projectId, versionId],
  );
}

function EntryTextPreview({
  actions,
  artifactId,
  entry,
  projectId,
  versionId,
}: {
  readonly actions: PreviewActions;
  readonly artifactId: string;
  readonly entry: PreviewEntry;
  readonly projectId: string;
  readonly versionId: string;
}) {
  const readBytes = useEntryBytes(projectId, artifactId, versionId, entry.path);
  return <TextPreview actions={actions} entry={entry} readBytes={readBytes} />;
}

function EntryDataPreview({
  actions,
  artifactId,
  entry,
  format,
  projectId,
  versionId,
}: {
  readonly actions: PreviewActions;
  readonly artifactId: string;
  readonly entry: PreviewEntry;
  readonly format: Parameters<typeof DataPreview>[0]["format"];
  readonly projectId: string;
  readonly versionId: string;
}) {
  const readBytes = useEntryBytes(projectId, artifactId, versionId, entry.path);
  return (
    <DataPreview actions={actions} entry={entry} format={format} readBytes={readBytes} />
  );
}

type FrameProps = Omit<Parameters<typeof HtmlPreview>[0], "renderDocument">;

/**
 * Markdown renders inside the same opaque-origin review sandbox as HTML, with
 * a toggle to the file's raw source as plain text.
 */
function MarkdownPreview({
  artifactId,
  frameProps,
  projectId,
}: {
  readonly artifactId: string;
  readonly frameProps: FrameProps;
  readonly projectId: string;
}) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  const readBytes = useEntryBytes(
    projectId,
    artifactId,
    frameProps.version.version.id,
    frameProps.entry.path,
  );
  return (
    <div className="as-markdown-preview" data-view={view}>
      <div
        aria-label={text.markdownViewLabel}
        className="as-markdown-preview__bar"
        role="group"
      >
        <button
          aria-pressed={view === "rendered"}
          className="as-button"
          onClick={() => setView("rendered")}
          type="button"
        >
          {text.markdownRendered}
        </button>
        <button
          aria-pressed={view === "source"}
          className="as-button"
          onClick={() => setView("source")}
          type="button"
        >
          {text.markdownSource}
        </button>
      </div>
      <div className="as-markdown-preview__body">
        {view === "rendered" ? (
          <HtmlPreview {...frameProps} renderDocument={markdownFrameDocument} />
        ) : (
          <TextPreview actions={frameProps.actions} entry={frameProps.entry} readBytes={readBytes} />
        )}
      </div>
    </div>
  );
}

/** PDF files begin with `%PDF-` within their first 1,024 bytes. */
const pdfHeaderWindow = 1024;
const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d];

function startsLikePdf(bytes: Uint8Array): boolean {
  for (let offset = 0; offset + pdfSignature.length <= bytes.length; offset += 1) {
    if (pdfSignature.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

type PdfLoad =
  | {readonly state: "loading"}
  | {readonly description: string; readonly retryable: boolean; readonly state: "failed"}
  | {readonly source: string; readonly state: "ready"};

/**
 * The browser's own PDF viewer, framed from the exact version's preview-lease
 * host on the content domain. The application origin never receives the PDF
 * typed as a document; it reads only the leading bytes as data to refuse a
 * file that is not a PDF before framing anything.
 */
function PdfPreview({
  actions,
  artifactId,
  artifactName,
  entry,
  projectId,
  versionId,
}: {
  readonly actions: PreviewActions;
  readonly artifactId: string;
  readonly artifactName: string;
  readonly entry: PreviewEntry;
  readonly projectId: string;
  readonly versionId: string;
}) {
  const [load, setLoad] = useState<PdfLoad>({state: "loading"});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoad({state: "loading"});
    void (async () => {
      try {
        const [head, lease] = await Promise.all([
          api.versionFileBytes(
            projectId,
            artifactId,
            versionId,
            entry.path,
            entry.size > pdfHeaderWindow ? pdfHeaderWindow : null,
          ),
          api.previewLease(projectId, artifactId, versionId),
        ]);
        if (!current) return;
        if (lease.versionId !== versionId) {
          setLoad({description: text.leaseMismatch, retryable: true, state: "failed"});
          return;
        }
        if (!startsLikePdf(head)) {
          setLoad({description: text.pdfUnavailableDescription, retryable: false, state: "failed"});
          return;
        }
        setLoad({source: entryContentUrl(lease.baseUrl, entry.path), state: "ready"});
      } catch (cause) {
        if (!current) return;
        setLoad({
          description: displayError(cause instanceof Error ? cause : new Error(text.failed)),
          retryable: true,
          state: "failed",
        });
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, attempt, entry.path, entry.size, projectId, versionId]);

  if (load.state === "loading") {
    return <PreviewState description={text.loadingPath(entry.path)} title={text.loadingTitle} />;
  }
  if (load.state === "failed") {
    return (
      <TerminalPreviewState
        actions={actions}
        description={load.description}
        mediaType={entry.mediaType}
        onRetry={load.retryable ? () => setAttempt((value) => value + 1) : undefined}
        path={entry.path}
        size={entry.size}
        title={text.pdfUnavailableTitle}
      />
    );
  }
  return (
    <iframe
      className="as-artifact-frame as-pdf-frame"
      referrerPolicy="no-referrer"
      src={load.source}
      title={text.mediaName(artifactName, entry.path)}
    />
  );
}

/** The content-host URL of one manifest path under a version base URL. */
function entryContentUrl(versionBaseUrl: string, entryPath: string): string {
  return new URL(
    entryPath.split("/").map(encodeURIComponent).join("/"),
    versionBaseUrl,
  ).toString();
}

function HtmlPreview({
  actions,
  annotateModeActive,
  annotations,
  artifactId,
  entry,
  isLight,
  onAnnotateModeChange,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  projectId,
  readOnly,
  renderDocument,
  selectedThreadId,
  version,
}: {
  readonly actions: PreviewActions;
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly entry: PreviewEntry;
  readonly isLight: boolean;
  readonly onAnnotateModeChange: (active: boolean) => void;
  readonly onSelectAnnotation: (threadId: string | null) => void;
  readonly onSubmitAnnotation: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ) => Promise<boolean>;
  readonly onUnanchoredChange: (threadIds: readonly string[]) => void;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly renderDocument: FrameDocumentRenderer;
  readonly selectedThreadId: string | null;
  readonly version: ArtifactVersion;
}) {
  const [previewDocument, setPreviewDocument] = useState<PreviewDocument | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialisedRef = useRef(false);

  const postToFrame = useCallback((message: HostMessage): void => {
    const frame = frameRef.current?.contentWindow;
    if (frame === null || frame === undefined) return;
    frame.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [source, resolvedBase] = await Promise.all([
          api.versionFile(
            projectId,
            artifactId,
            version.version.id,
            entry.path,
          ),
          api.previewLease(projectId, artifactId, version.version.id).then(
            (lease) => {
              if (lease.versionId !== version.version.id) {
                throw new Error(text.leaseMismatch);
              }
              return lease.baseUrl;
            },
          ),
        ]);
        if (current) {
          const rendered = renderDocument(
            source,
            documentBaseUrl(resolvedBase, entry.path),
          );
          setPreviewDocument({
            baseHref: rendered.baseHref,
            entryPath: entry.path,
            html: rendered.html,
          });
        }
      } catch (cause) {
        if (!current) return;
        setError(
          cause instanceof Error ? cause : new Error(text.failed),
        );
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, entry.path, projectId, renderDocument, version.version.id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const parsed = frameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-ready") {
        setFrameReady(true);
        return;
      }
      if (message.type === "as-review-select") {
        onSelectAnnotation(message.threadId);
        return;
      }
      if (message.type === "as-review-unanchored") {
        onUnanchoredChange(message.threadIds);
        return;
      }
      if (message.type === "as-review-annotate-mode-request") {
        onAnnotateModeChange(message.active);
        return;
      }
      void (async () => {
        const saved = await onSubmitAnnotation(message.body, message.anchor, entry.path);
        if (!saved) {
          postToFrame({
            annotations: [...annotations],
            type: "as-review-annotations",
            v: reviewProtocolVersion,
          });
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    annotations,
    entry.path,
    onAnnotateModeChange,
    onSelectAnnotation,
    onSubmitAnnotation,
    onUnanchoredChange,
    postToFrame,
  ]);

  useEffect(() => {
    if (!frameReady || previewDocument === null || initialisedRef.current) return;
    initialisedRef.current = true;
    postToFrame({
      annotateModeActive,
      annotations: [...annotations],
      baseHref: previewDocument.baseHref,
      entryPath: previewDocument.entryPath,
      html: previewDocument.html,
      isLight,
      readOnly,
      themeTokens: reviewThemeTokens(),
      type: "as-review-init",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, annotations, frameReady, isLight, postToFrame, previewDocument, readOnly]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      active: annotateModeActive,
      type: "as-review-annotate-mode",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, postToFrame]);

  useEffect(() => {
    if (!initialisedRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      postToFrame({
        isLight,
        themeTokens: reviewThemeTokens(),
        type: "as-review-theme",
        v: reviewProtocolVersion,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isLight, postToFrame]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      annotations: [...annotations],
      type: "as-review-annotations",
      v: reviewProtocolVersion,
    });
  }, [annotations, postToFrame]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      threadId: selectedThreadId,
      type: "as-review-focus",
      v: reviewProtocolVersion,
    });
  }, [postToFrame, selectedThreadId]);

  if (loading) {
    return (
      <PreviewState
        description={text.loadingPath(entry.path)}
        title={text.loadingTitle}
      />
    );
  }
  if (error !== null) {
    return (
      <TerminalPreviewState
        actions={actions}
        description={displayError(error)}
        mediaType={entry.mediaType}
        path={entry.path}
        size={entry.size}
        title={text.unavailableTitle}
      />
    );
  }
  return (
    <iframe
      className="as-artifact-frame"
      ref={frameRef}
      src="/review-frame"
      title={text.frameTitle(version.version.artifactId, version.version.number)}
    />
  );
}

function documentBaseUrl(versionBaseUrl: string, entryPath: string): string {
  const entryUrl = new URL(
    entryPath.split("/").map(encodeURIComponent).join("/"),
    versionBaseUrl,
  );
  return new URL(".", entryUrl).toString();
}

function NativeMediaPreview({
  actions,
  artifactName,
  entry,
  kind,
  onProbe,
  source,
}: {
  readonly actions: PreviewActions;
  readonly artifactName: string;
  readonly entry: PreviewEntry;
  readonly kind: "audio" | "image" | "video";
  readonly onProbe: () => Promise<void>;
  readonly source: string;
}) {
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const mountedRef = useRef(true);
  const probeInFlightRef = useRef(false);
  const playerRef = useRef<HTMLMediaElement | null>(null);
  const attachPlayer = useCallback((element: HTMLMediaElement | null): void => {
    playerRef.current = element;
  }, []);
  const accessibleName = text.mediaName(artifactName, entry.path);

  useEffect(() => () => {
    mountedRef.current = false;
    const player = playerRef.current;
    if (player !== null) {
      player.removeAttribute("src");
      player.load();
    }
  }, []);

  const handleMediaError = (): void => {
    if (probeInFlightRef.current) return;
    probeInFlightRef.current = true;
    void (async () => {
      try {
        await onProbe();
      } catch {
        // The API boundary separately broadcasts an expired session. Every
        // other probe failure uses the same honest terminal media fallback.
      } finally {
        if (mountedRef.current) setStatus("error");
        probeInFlightRef.current = false;
      }
    })();
  };

  if (status === "error") {
    return (
      <TerminalPreviewState
        actions={actions}
        description={text.mediaUnavailableDescription(entry.mediaType)}
        mediaType={entry.mediaType}
        onRetry={() => {
          setRetry((current) => current + 1);
          setStatus("loading");
        }}
        path={entry.path}
        size={entry.size}
        title={text.mediaUnavailableTitle(kind)}
      />
    );
  }
  const mediaSource = `${source}#preview-${retry}`;
  return (
    <div className="as-media-preview" data-kind={kind} data-status={status}>
      {kind === "image" ? (
        <img
          alt={accessibleName}
          key={retry}
          onError={handleMediaError}
          onLoad={() => setStatus("ready")}
          src={mediaSource}
        />
      ) : kind === "video" ? (
        <video
          aria-label={accessibleName}
          controls
          key={retry}
          onError={handleMediaError}
          onLoadedMetadata={() => setStatus("ready")}
          playsInline
          preload="metadata"
          ref={attachPlayer}
          src={mediaSource}
        />
      ) : (
        <audio
          aria-label={accessibleName}
          controls
          key={retry}
          onError={handleMediaError}
          onLoadedMetadata={() => setStatus("ready")}
          preload="metadata"
          ref={attachPlayer}
          src={mediaSource}
        />
      )}
      {status === "loading" ? (
        <div className="as-media-preview__loading" role="status">
          <span aria-hidden="true" className="as-preview-state__mark" />
          <strong>{text.loadingTitle}</strong>
          <small>{entry.path}</small>
        </div>
      ) : null}
    </div>
  );
}

function reviewThemeTokens() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string): string => style.getPropertyValue(name).trim();
  return {
    "--accent": value("--as-surface-raised"),
    "--accent-foreground": value("--as-text"),
    "--background": value("--as-surface"),
    "--border": value("--as-border"),
    "--card": value("--as-surface"),
    "--card-foreground": value("--as-text"),
    "--code-bg": value("--as-canvas"),
    "--destructive": value("--as-love"),
    "--destructive-foreground": value("--as-canvas"),
    "--focus-highlight": value("--as-iris-soft"),
    "--font-mono": '"Geist Mono Variable", ui-monospace, monospace',
    "--font-sans": '"Geist Variable", "PingFang TC", "Noto Sans TC", ui-sans-serif, sans-serif',
    "--foreground": value("--as-text"),
    "--input": value("--as-border"),
    "--muted": value("--as-surface-raised"),
    "--muted-foreground": value("--as-subtle"),
    "--popover": value("--as-surface-raised"),
    "--popover-foreground": value("--as-text"),
    "--primary": value("--as-action"),
    "--primary-foreground": value("--as-on-action"),
    "--radius": "0.5rem",
    "--ring": value("--as-iris"),
    "--secondary": value("--as-foam"),
    "--secondary-foreground": value("--as-canvas"),
    "--success": value("--as-pine"),
    "--success-foreground": value("--as-canvas"),
    "--warning": value("--as-gold"),
    "--warning-foreground": value("--as-canvas"),
  };
}
