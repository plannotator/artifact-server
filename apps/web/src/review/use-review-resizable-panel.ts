import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface ReviewResizablePanelOptions {
  readonly apply: (width: number) => void;
  readonly defaultWidth: number;
  readonly maxWidth: number;
  readonly minWidth: number;
  readonly onClick: () => void;
  readonly onSnapClose: () => void;
  readonly onSnapOpen: () => void;
  readonly side: "left" | "right";
  readonly snapCloseRatio?: number;
  readonly storageKey: string;
}

/** Pointer bindings consumed by an Artifact Server review panel edge. */
export interface ReviewResizeHandleBindings {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly style: {readonly touchAction: "none"};
}

/** State and operations for one resizable Review side panel. */
export interface ReviewPanelResize {
  readonly handleBindings: ReviewResizeHandleBindings;
  readonly isDragging: boolean;
  readonly maxWidth: number;
  readonly minWidth: number;
  readonly resizeTo: (width: number) => void;
  readonly width: number;
}

const clickThreshold = 4;

function clamp(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

function readStoredWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  const storedValue = window.localStorage.getItem(storageKey);
  if (storedValue === null) return clamp(defaultWidth, minWidth, maxWidth);
  const stored = Number(storedValue);
  return Number.isFinite(stored)
    ? clamp(stored, minWidth, maxWidth)
    : clamp(defaultWidth, minWidth, maxWidth);
}

/**
 * Drive a Review panel from a 16px edge without rendering on every drag frame.
 *
 * Widths persist only after a completed drag or keyboard resize. Dragging below
 * half the minimum closes immediately, and crossing back while still held reopens.
 */
export function useReviewResizablePanel({
  apply,
  defaultWidth,
  maxWidth,
  minWidth,
  onClick,
  onSnapClose,
  onSnapOpen,
  side,
  snapCloseRatio = 0.5,
  storageKey,
}: ReviewResizablePanelOptions): ReviewPanelResize {
  const [width, setWidth] = useState(() => readStoredWidth(
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
  ));
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  const startPositionRef = useRef(0);
  const latestPositionRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);
  const snappedClosedRef = useRef(false);
  const movedRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const activeCleanupRef = useRef<(() => void) | null>(null);

  const applyRef = useRef(apply);
  const onClickRef = useRef(onClick);
  const onSnapCloseRef = useRef(onSnapClose);
  const onSnapOpenRef = useRef(onSnapOpen);
  useEffect(() => {
    applyRef.current = apply;
    onClickRef.current = onClick;
    onSnapCloseRef.current = onSnapClose;
    onSnapOpenRef.current = onSnapOpen;
  });

  const applyLatestPosition = useCallback((): void => {
    animationFrameRef.current = null;
    if (!draggingRef.current) return;
    const delta = side === "right"
      ? startPositionRef.current - latestPositionRef.current
      : latestPositionRef.current - startPositionRef.current;
    const rawWidth = startWidthRef.current + delta;
    const closeThreshold = minWidth * snapCloseRatio;

    if (!snappedClosedRef.current && rawWidth < closeThreshold) {
      snappedClosedRef.current = true;
      widthRef.current = startWidthRef.current;
      applyRef.current(startWidthRef.current);
      setWidth(startWidthRef.current);
      onSnapCloseRef.current();
      return;
    }
    if (snappedClosedRef.current) {
      if (rawWidth < closeThreshold) return;
      snappedClosedRef.current = false;
      onSnapOpenRef.current();
    }

    const nextWidth = clamp(rawWidth, minWidth, maxWidth);
    widthRef.current = nextWidth;
    applyRef.current(nextWidth);
  }, [maxWidth, minWidth, side, snapCloseRatio]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    startPositionRef.current = event.clientX;
    latestPositionRef.current = event.clientX;
    startWidthRef.current = widthRef.current;
    snappedClosedRef.current = false;
    movedRef.current = false;
    draggingRef.current = true;
    setIsDragging(true);

    const onMove = (moveEvent: PointerEvent): void => {
      if (!draggingRef.current) return;
      latestPositionRef.current = moveEvent.clientX;
      if (Math.abs(latestPositionRef.current - startPositionRef.current) > clickThreshold) {
        movedRef.current = true;
      }
      if (animationFrameRef.current === null) {
        animationFrameRef.current = window.requestAnimationFrame(applyLatestPosition);
      }
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      activeCleanupRef.current = null;
    };
    function onUp(upEvent: PointerEvent): void {
      const cancelled = upEvent.type === "pointercancel";
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
        applyLatestPosition();
      }
      const endedClosed = snappedClosedRef.current;
      draggingRef.current = false;
      snappedClosedRef.current = false;
      setIsDragging(false);

      if (!endedClosed) {
        if (!movedRef.current && !cancelled) {
          onClickRef.current();
        } else {
          setWidth(widthRef.current);
          window.localStorage.setItem(storageKey, String(widthRef.current));
        }
      }
      cleanup();
    }

    activeCleanupRef.current?.();
    activeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [applyLatestPosition, storageKey]);

  useEffect(() => () => {
    activeCleanupRef.current?.();
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
  }, []);

  const resizeTo = useCallback((requestedWidth: number): void => {
    const nextWidth = clamp(requestedWidth, minWidth, maxWidth);
    widthRef.current = nextWidth;
    applyRef.current(nextWidth);
    setWidth(nextWidth);
    window.localStorage.setItem(storageKey, String(nextWidth));
  }, [maxWidth, minWidth, storageKey]);

  return {
    handleBindings: {
      onPointerDown,
      style: {touchAction: "none"},
    },
    isDragging,
    maxWidth,
    minWidth,
    resizeTo,
    width,
  };
}
