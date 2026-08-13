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
  type ManifestInput,
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
