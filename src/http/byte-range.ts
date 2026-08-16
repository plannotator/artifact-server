/** One satisfiable inclusive range within a representation. */
export interface SatisfiableByteRange {
  readonly endInclusive: number;
  readonly length: number;
  readonly start: number;
}

/** Result of parsing an optional HTTP Range header for one representation. */
export type ByteRangeDecision =
  | {readonly kind: "full"}
  | {readonly kind: "partial"; readonly range: SatisfiableByteRange}
  | {readonly kind: "unsatisfiable"};

/**
 * Parse the supported single-range subset of RFC 9110 byte ranges.
 *
 * Multiple ranges intentionally resolve to `unsatisfiable`; Artifact Server
 * never constructs multipart range responses.
 */
export function decideByteRange(
  rangeHeader: string | undefined,
  representationSize: number,
): ByteRangeDecision {
  if (rangeHeader === undefined) return {kind: "full"};
  if (!Number.isSafeInteger(representationSize) || representationSize <= 0) {
    return {kind: "unsatisfiable"};
  }

  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return {kind: "unsatisfiable"};
  }
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return {kind: "unsatisfiable"};

  if (startText === "") {
    const suffixLength = parseSafeInteger(endText);
    if (suffixLength === null || suffixLength === 0) {
      return {kind: "unsatisfiable"};
    }
    const length = Math.min(suffixLength, representationSize);
    return {
      kind: "partial",
      range: {
        endInclusive: representationSize - 1,
        length,
        start: representationSize - length,
      },
    };
  }

  const start = parseSafeInteger(startText);
  if (start === null || start >= representationSize) {
    return {kind: "unsatisfiable"};
  }
  const requestedEnd = endText === ""
    ? representationSize - 1
    : parseSafeInteger(endText);
  if (requestedEnd === null || requestedEnd < start) {
    return {kind: "unsatisfiable"};
  }
  const endInclusive = Math.min(requestedEnd, representationSize - 1);
  return {
    kind: "partial",
    range: {
      endInclusive,
      length: endInclusive - start + 1,
      start,
    },
  };
}

/** Decide whether an If-Range value permits the requested byte range. */
export function ifRangeAllowsPartialResponse(
  ifRange: string | undefined,
  strongEtag: string,
): boolean {
  return ifRange === undefined || ifRange.trim() === strongEtag;
}

function parseSafeInteger(input: string): number | null {
  if (input === "") return null;
  const value = Number(input);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
