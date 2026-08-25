/**
 * Boundary declaration for `@plannotator/ui/components/html-viewer`.
 *
 * The package ships raw `.tsx` source, so `tsc --noEmit` would otherwise
 * type-check ~5,400 lines of third-party code under this repository's much
 * stricter options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
 * `noPropertyAccessFromIndexSignature`) and report 886 errors we may not fix.
 * `apps/web/tsconfig.json` maps `@plannotator/ui/*` here so the compiler sees
 * this declared contract instead; Vite still bundles the real source.
 *
 * Mirrors @plannotator/ui@0.31.0:
 *   components/html-viewer/HtmlViewer.tsx:137-181 (HtmlViewerProps)
 *   components/Viewer.tsx:141-145 (ViewerHandle)
 *   types.ts:1-5, 60-125 (AnnotationType, Annotation, anchors)
 * Only the props this application drives are declared; unused Vim, diff,
 * attachment, and Ask-AI inputs are deliberately omitted so they cannot be
 * passed by accident.
 */
import type { ReactNode, RefAttributes } from "react";

/** Verified-unique CSS selector plus fingerprint for one annotated element. */
export interface HtmlElementAnchor {
  selector: string;
  tagName: string;
  text?: string | undefined;
  point?: {x: number; y: number} | undefined;
}

/** One additional element covered by a multi-target pinpoint comment. */
export interface HtmlAnnotationTarget {
  label?: string | undefined;
  text: string;
  anchor?: HtmlElementAnchor | undefined;
}

/** The annotation kinds the viewer distinguishes (string enum in the package). */
export type AnnotationKind = "COMMENT" | "DELETION" | "GLOBAL_COMMENT";

/** The annotation record the viewer renders and emits. */
export interface Annotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: AnnotationKind;
  text?: string | undefined;
  originalText: string;
  createdA: number;
  author?: string | undefined;
  htmlAnchor?: HtmlElementAnchor | undefined;
  htmlAdditionalTargets?: HtmlAnnotationTarget[] | undefined;
}

/** Imperative repaint handle for a prop-driven mount. */
export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

/** Inputs for the sandboxed raw-HTML viewer and its parent-side annotation UI. */
export interface HtmlViewerProps {
  rawHtml: string;
  annotations: Annotation[];
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: "selection" | "comment" | "redline" | "quickLabel";
  inputMethod: "drag" | "pinpoint";
  annotateModeActive?: boolean | undefined;
  onAnnotateModeExit?: (() => void) | undefined;
  onAnnotateModeToggle?: (() => void) | undefined;
  fullViewport?: boolean | undefined;
  hideControls?: boolean | undefined;
  readOnly?: boolean | undefined;
  onUnanchoredChange?: ((ids: string[]) => void) | undefined;
  title?: string | undefined;
}

export declare const HtmlViewer: (
  props: HtmlViewerProps & RefAttributes<ViewerHandle>,
) => ReactNode;
