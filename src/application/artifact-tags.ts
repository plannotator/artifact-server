import { caseFold } from "unicode-case-folding";
import { Effect } from "effect";

import {InvalidArtifactTags} from "../core/errors.js";

const maximumArtifactTagCount = 20;
const maximumArtifactTagLength = 40;

const controlCharacter = /\p{Cc}/u;
const tagSegmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
const whitespace = /\s+/gu;

/** Normalize and validate the complete artifact tag set. */
export function parseArtifactTags(
  candidates: readonly string[],
): Effect.Effect<readonly string[], InvalidArtifactTags> {
  if (candidates.length > maximumArtifactTagCount) {
    return new InvalidArtifactTags({
      message: `An artifact can have at most ${maximumArtifactTagCount} tags.`,
    });
  }

  const normalized = new Set<string>();
  for (const candidate of candidates) {
    if (controlCharacter.test(candidate)) {
      return new InvalidArtifactTags({
        message: "Tags cannot contain control characters.",
      });
    }
    const tag = normalizeArtifactTag(candidate);
    if (
      tag.length === 0 ||
      Array.from(tagSegmenter.segment(tag)).length > maximumArtifactTagLength ||
      controlCharacter.test(tag)
    ) {
      return new InvalidArtifactTags({
        message:
          `Tags must contain between 1 and ${maximumArtifactTagLength} characters and cannot contain control characters.`,
      });
    }
    normalized.add(tag);
  }

  return Effect.succeed([...normalized].toSorted());
}

/** Normalize one exact tag filter with the same rules as stored metadata. */
export function parseArtifactTag(
  candidate: string,
): Effect.Effect<string, InvalidArtifactTags> {
  return parseArtifactTags([candidate]).pipe(
    Effect.flatMap((tags) => {
      const tag = tags.at(0);
      return tag === undefined
        ? new InvalidArtifactTags({message: "A tag filter cannot be empty."})
        : Effect.succeed(tag);
    }),
  );
}

/** Normalize one tag-shaped search value without enforcing tag limits. */
export function normalizeArtifactTag(candidate: string): string {
  return normalizeArtifactSearchText(candidate);
}

/** Normalize user-visible text for storage-independent artifact search. */
export function normalizeArtifactSearchText(candidate: string): string {
  const collapsed = candidate.normalize("NFKC").trim().replace(whitespace, " ");
  return caseFold(collapsed).normalize("NFC");
}
