/** Lifecycle states that affect whether a running process may receive work. */
export type RuntimeLifecycleState =
  | "starting"
  | "ready"
  | "draining";

/** Mutable process-local lifecycle gate shared by readiness and shutdown. */
export interface RuntimeLifecycle {
  /** Return the process's current lifecycle state. */
  readonly current: () => RuntimeLifecycleState;
  /** Move a started process into the ready state. */
  readonly markReady: () => void;
  /** Permanently withdraw readiness before connection draining starts. */
  readonly startDraining: () => void;
}

/** Create the explicit starting → ready → draining state machine. */
export function createRuntimeLifecycle(): RuntimeLifecycle {
  let state: RuntimeLifecycleState = "starting";
  return {
    current: () => state,
    markReady: () => {
      if (state === "starting") state = "ready";
    },
    startDraining: () => {
      state = "draining";
    },
  };
}
