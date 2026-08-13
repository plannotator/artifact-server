import type { DateTime, Effect } from "effect";

/** Testable current-time capability shared by application operations. */
export interface ApplicationClock {
  readonly now: Effect.Effect<DateTime.Utc>;
}
