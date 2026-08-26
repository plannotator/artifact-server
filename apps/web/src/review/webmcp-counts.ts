/**
 * Counts echoed by a WebMCP mutation, derived purely: the view's threads
 * with the freshly mutated thread substituted in. Correct by construction —
 * no dependence on when React commits the reloaded list.
 */

export interface CountedThread {
  readonly id: string;
  readonly state: "open" | "resolved";
}

export type EchoCounts = {
  readonly open: number;
  readonly resolved: number;
};

export function echoCounts(
  threads: readonly CountedThread[],
  updated: CountedThread,
): EchoCounts {
  let open = 0;
  let total = 0;
  let substituted = false;
  for (const thread of threads) {
    const state = thread.id === updated.id ? updated.state : thread.state;
    if (thread.id === updated.id) substituted = true;
    total += 1;
    if (state === "open") open += 1;
  }
  if (!substituted) {
    // A thread created by this mutation is not in the view yet.
    total += 1;
    if (updated.state === "open") open += 1;
  }
  return {open, resolved: total - open};
}
