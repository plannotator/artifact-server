/**
 * A one-shot gate the scripted model awaits inside a turn. Holding a turn open
 * is how a live test owns Pi's work boundary: everything the suite does while
 * the gate is closed provably happens while Pi is still busy.
 */

/** One work boundary under a test's control. */
export interface WorkGate {
  /** Let the held turn finish. */
  open(): void;
  /** Resolves when the gate opens. */
  readonly opened: Promise<void>;
}

/** Create a closed gate. */
export function createWorkGate(): WorkGate {
  let release: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    open: () => {
      release?.();
    },
    opened,
  };
}
