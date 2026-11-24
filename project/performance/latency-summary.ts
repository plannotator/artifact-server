/** p50, p95, and maximum of one operation's measured samples. */
export interface LatencySummary {
  readonly samples: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly maximumMilliseconds: number;
}

/** Summarize measured samples with nearest-rank percentiles, rounded to microseconds. */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Milliseconds: round(percentile(sorted, 0.5)),
    p95Milliseconds: round(percentile(sorted, 0.95)),
    maximumMilliseconds: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: readonly number[], requested: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(requested * sorted.length) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
