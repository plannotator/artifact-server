import {z} from "zod";

const key = "artifact-review-visits";
const visitsSchema = z.record(z.string(), z.number().finite());

/** A missing entry means this browser has no prior visit for that artifact. */
export function readReviewVisits(): Readonly<Record<string, number>> | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? {} : visitsSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function recordReviewVisit(principalId: string, artifactId: string): void {
  try {
    const visits = readReviewVisits() ?? {};
    window.localStorage.setItem(key, JSON.stringify({
      ...visits,
      [`${principalId}:${artifactId}`]: Date.now(),
    }));
  } catch {
    // Visits stay unknown when this browser blocks storage.
  }
}
