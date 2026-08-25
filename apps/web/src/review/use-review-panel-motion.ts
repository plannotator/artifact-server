import {animate, type MotionValue, useMotionValue, useTransform} from "motion/react";
import {useEffect, useState} from "react";

/** Animated allocation and accepted width for one Review side panel. */
export interface ReviewPanelMotion {
  readonly mounted: boolean;
  readonly outerWidth: MotionValue<number>;
  readonly width: MotionValue<number>;
}

const shellSpring = {
  bounce: 0.1,
  duration: 0.5,
  type: "spring",
} as const;

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reducedMotion;
}

/**
 * Animate a panel allocation from its current progress so rapid reversals stay continuous.
 * Direct resize writes target `width`; only open and close use the shared shell spring.
 */
export function useReviewPanelMotion(
  open: boolean,
  committedWidth: number,
  gap = 0,
): ReviewPanelMotion {
  const reducedMotion = usePrefersReducedMotion();
  const progress = useMotionValue(open ? 1 : 0);
  const width = useMotionValue(committedWidth);
  const outerWidth = useTransform(
    () => (width.get() + gap) * Math.min(1, Math.max(0, progress.get())),
  );
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    progress.stop();
    const target = open ? 1 : 0;
    if (open) setMounted(true);
    if (reducedMotion) {
      progress.set(target);
      if (!open) setMounted(false);
      return undefined;
    }
    if (progress.get() === target) {
      if (!open) setMounted(false);
      return undefined;
    }
    const controls = animate(progress, target, {
      ...shellSpring,
      onComplete: () => {
        if (!open) setMounted(false);
      },
    });
    return () => controls.stop();
  }, [open, progress, reducedMotion]);

  useEffect(() => {
    width.set(committedWidth);
  }, [committedWidth, width]);

  return {mounted, outerWidth, width};
}
