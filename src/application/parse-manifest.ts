import { Effect } from "effect";

import {
  EmptyManifest,
  InvalidManifestFile,
  InvalidManifestPath,
  MissingManifestEntry,
} from "../core/errors.js";
import type { CanonicalManifest } from "../core/model.js";
import {
  createManifest,
  createSingleFileManifest,
  type ManifestInput,
  type SingleFileManifestInput,
} from "../manifest/create-manifest.js";

/** Expected failures produced while parsing a canonical manifest. */
export type ManifestFailure =
  | EmptyManifest
  | MissingManifestEntry
  | InvalidManifestFile
  | InvalidManifestPath;

/** Parse declared files into a canonical manifest effect. */
export function parseManifest(
  input: ManifestInput,
): Effect.Effect<CanonicalManifest, ManifestFailure> {
  return catchManifestFailure(() => createManifest(input));
}

/** Parse one inline file into a canonical manifest effect. */
export function parseSingleFileManifest(
  input: SingleFileManifestInput,
): Effect.Effect<CanonicalManifest, ManifestFailure> {
  return catchManifestFailure(() => createSingleFileManifest(input));
}

function catchManifestFailure(
  operation: () => CanonicalManifest,
): Effect.Effect<CanonicalManifest, ManifestFailure> {
  return Effect.try({
    try: operation,
    catch: (cause) => {
      if (
        cause instanceof EmptyManifest ||
        cause instanceof MissingManifestEntry ||
        cause instanceof InvalidManifestFile ||
        cause instanceof InvalidManifestPath
      ) {
        return cause;
      }
      throw cause;
    },
  });
}
