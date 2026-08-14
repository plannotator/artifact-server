import {Effect} from "effect";

/** Execute one expected Effect failure as a stable CLI error. */
export function runCliEffect<A, E extends {_tag: string; message: string}>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(
    Effect.mapError((error) => new Error(`${error._tag}: ${error.message}`)),
  ));
}
