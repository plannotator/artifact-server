import {createPortal} from "react-dom";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type {ReviewPanelResize} from "./use-review-resizable-panel.ts";

const keyboardStep = 10;
const tooltipDelayMilliseconds = 300;

interface CursorPosition {
  readonly x: number;
  readonly y: number;
}

/** Quiet, sibling-compatible resize and collapse edge for a Review side panel. */
export function ReviewPanelEdge({
  label,
  onCollapse,
  resize,
  side,
}: {
  readonly label: string;
  readonly onCollapse: () => void;
  readonly resize: ReviewPanelResize;
  readonly side: "left" | "right";
}) {
  const tooltipId = useId();
  const tooltipTimerRef = useRef<number | null>(null);
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const clearTooltip = (): void => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setTooltipOpen(false);
    setCursor(null);
  };

  useEffect(() => () => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
    }
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onCollapse();
      return;
    }
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    let target: number | null = null;
    if (event.key === grow) target = resize.width + keyboardStep;
    else if (event.key === shrink) target = resize.width - keyboardStep;
    else if (event.key === "Home") target = resize.minWidth;
    else if (event.key === "End") target = resize.maxWidth;
    if (target === null) return;
    event.preventDefault();
    resize.resizeTo(target);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "mouse" || resize.isDragging) return;
    setCursor({x: event.clientX, y: event.clientY});
    if (tooltipOpen || tooltipTimerRef.current !== null) return;
    tooltipTimerRef.current = window.setTimeout(() => {
      tooltipTimerRef.current = null;
      setTooltipOpen(true);
    }, tooltipDelayMilliseconds);
  };

  return (
    <div
      aria-describedby={tooltipOpen ? tooltipId : undefined}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={resize.maxWidth}
      aria-valuemin={resize.minWidth}
      aria-valuenow={Math.round(resize.width)}
      className="as-panel-edge"
      data-dragging={resize.isDragging}
      data-side={side}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" className="as-panel-edge__track" data-resize-track={side} />
      <div
        className="as-panel-edge__hit"
        onPointerDown={(event) => {
          clearTooltip();
          resize.handleBindings.onPointerDown(event);
        }}
        onPointerLeave={clearTooltip}
        onPointerMove={onPointerMove}
        style={resize.handleBindings.style}
      />
      {tooltipOpen && cursor !== null
        ? createPortal(
          <div
            className="as-panel-edge__tooltip"
            id={tooltipId}
            role="tooltip"
            style={{left: cursor.x + 14, top: cursor.y + 16}}
          >
            Click to close · Drag to resize
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
