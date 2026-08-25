import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  api,
  type ArtifactVersion,
} from "@/api/client";
import {formatBytes} from "@/lib/presentation";
import {
  frameMessageSchema,
  reviewProtocolVersion,
  type HostMessage,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

interface PreviewDocument {
  readonly entryPath: string;
  readonly html: string;
}

interface PreviewEntry {
  readonly mediaType: string;
  readonly path: string;
  readonly size: number;
}

interface PreviewActions {
  readonly downloadUrl: string | null;
  readonly onOpenRawArtifact: () => void;
  readonly opening: boolean;
}

/** Render one exact immutable manifest entry in the Artifact Server preview surface. */
export function ReviewPreview({
  annotateModeActive,
  annotations,
  artifactId,
  artifactName,
  baseHref,
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
  readonly baseHref: string | null;
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
        description="Reading the selected immutable version."
        title="Loading preview"
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
        description="This path is not part of the selected immutable version."
        mediaType="unknown"
        path={path}
        size={null}
        title="File not found"
      />
    );
  }
  const mediaType = mediaTypeEssence(entry.mediaType);
  const identity = `${version.version.id}:${entry.path}`;
  if (mediaType === "text/html") {
    return (
      <HtmlPreview
        actions={commonActions}
        annotateModeActive={annotateModeActive}
        annotations={annotations}
        artifactId={artifactId}
        baseHref={baseHref}
        entry={entry}
        isLight={isLight}
        key={identity}
        onAnnotateModeChange={onAnnotateModeChange}
        onSelectAnnotation={onSelectAnnotation}
        onSubmitAnnotation={onSubmitAnnotation}
        onUnanchoredChange={onUnanchoredChange}
        projectId={projectId}
        readOnly={readOnly}
        selectedThreadId={selectedThreadId}
        version={version}
      />
    );
  }
  if (mediaType.startsWith("image/")) {
    return (
      <NativeMediaPreview
        actions={commonActions}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        kind="image"
        onProbe={() => api.probeVersionMedia(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
        source={api.versionMediaUrl(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
      />
    );
  }
  if (mediaType.startsWith("video/")) {
    return (
      <NativeMediaPreview
        actions={commonActions}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        kind="video"
        onProbe={() => api.probeVersionMedia(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
        source={api.versionMediaUrl(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
      />
    );
  }
  return (
    <TerminalPreviewState
      actions={commonActions}
      description="Artifact Server does not preview this declared media type."
      mediaType={entry.mediaType}
      path={entry.path}
      size={entry.size}
      title="Preview not supported"
    />
  );
}

function HtmlPreview({
  actions,
  annotateModeActive,
  annotations,
  artifactId,
  baseHref,
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
}: {
  readonly actions: PreviewActions;
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly baseHref: string | null;
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
        const html = await api.versionFile(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        );
        if (current) setPreviewDocument({entryPath: entry.path, html});
      } catch (cause) {
        if (!current) return;
        setError(
          cause instanceof Error ? cause : new Error("Artifact preview failed."),
        );
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, entry.path, projectId, version.version.id]);

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
      baseHref,
      entryPath: previewDocument.entryPath,
      html: previewDocument.html,
      isLight,
      readOnly,
      themeTokens: reviewThemeTokens(),
      type: "as-review-init",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, annotations, baseHref, frameReady, isLight, postToFrame, previewDocument, readOnly]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      active: annotateModeActive,
      type: "as-review-annotate-mode",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, postToFrame]);

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
        description={`Reading ${entry.path} from the selected version.`}
        title="Loading preview"
      />
    );
  }
  if (error !== null) {
    return (
      <TerminalPreviewState
        actions={actions}
        description={error.message}
        mediaType={entry.mediaType}
        path={entry.path}
        size={entry.size}
        title="Preview unavailable"
      />
    );
  }
  return (
    <iframe
      className="as-artifact-frame"
      ref={frameRef}
      src="/review-frame"
      title={`${version.version.artifactId} version ${version.version.number}`}
    />
  );
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
  readonly kind: "image" | "video";
  readonly onProbe: () => Promise<void>;
  readonly source: string;
}) {
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const mountedRef = useRef(true);
  const probeInFlightRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const accessibleName = `${artifactName} — ${entry.path}`;

  useEffect(() => () => {
    mountedRef.current = false;
    const video = videoRef.current;
    if (video !== null) {
      video.removeAttribute("src");
      video.load();
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
        description={`This browser could not decode or deliver the declared ${entry.mediaType} file.`}
        mediaType={entry.mediaType}
        onRetry={() => {
          setRetry((current) => current + 1);
          setStatus("loading");
        }}
        path={entry.path}
        size={entry.size}
        title={`${kind === "image" ? "Image" : "Video"} preview unavailable`}
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
      ) : (
        <video
          aria-label={accessibleName}
          controls
          key={retry}
          onError={handleMediaError}
          onLoadedMetadata={() => setStatus("ready")}
          playsInline
          preload="metadata"
          ref={videoRef}
          src={mediaSource}
        />
      )}
      {status === "loading" ? (
        <div className="as-media-preview__loading" role="status">
          <span aria-hidden="true" className="as-preview-state__mark" />
          <strong>Loading preview</strong>
          <small>{entry.path}</small>
        </div>
      ) : null}
    </div>
  );
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
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
    "--font-mono": '"Atkinson Hyperlegible Mono", ui-monospace, monospace',
    "--font-sans": '"Atkinson Hyperlegible Next", ui-sans-serif, sans-serif',
    "--foreground": value("--as-text"),
    "--input": value("--as-border"),
    "--muted": value("--as-surface-raised"),
    "--muted-foreground": value("--as-subtle"),
    "--primary": value("--as-action"),
    "--primary-foreground": value("--as-on-action"),
    "--radius": "0.75rem",
    "--ring": value("--as-iris"),
    "--secondary": value("--as-foam"),
    "--secondary-foreground": value("--as-canvas"),
    "--success": value("--as-pine"),
    "--success-foreground": value("--as-canvas"),
    "--warning": value("--as-gold"),
    "--warning-foreground": value("--as-canvas"),
  };
}

function TerminalPreviewState({
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
  readonly onRetry?: () => void;
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
        <div><dt>Path</dt><dd><code>{path}</code></dd></div>
        <div><dt>Type</dt><dd><code>{mediaType}</code></dd></div>
        {size === null ? null : (
          <div><dt>Size</dt><dd>{formatBytes(size)}</dd></div>
        )}
      </dl>
      <div className="as-preview-state__actions">
        {onRetry === undefined ? null : (
          <button className="as-button" onClick={onRetry} type="button">Retry preview</button>
        )}
        <button
          className="as-button as-button--primary"
          disabled={actions.opening}
          onClick={actions.onOpenRawArtifact}
          type="button"
        >
          <HugeiconsIcon aria-hidden="true" icon={ExternalLinkIcon} strokeWidth={1.8} />
          {actions.opening ? "Opening…" : "Open raw artifact"}
        </button>
        {actions.downloadUrl === null ? null : (
          <a className="as-button" download href={actions.downloadUrl}>Download file</a>
        )}
      </div>
    </div>
  );
}

function PreviewState({
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
