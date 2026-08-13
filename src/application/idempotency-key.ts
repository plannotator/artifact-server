import { Effect, Schema } from "effect";

import { InvalidIdempotencyKey } from "../core/errors.js";

const idempotencyKeySchema = Schema.String.check(
  Schema.isLengthBetween(16, 200),
);
const decodeIdempotencyKey = Schema.decodeUnknownEffect(idempotencyKeySchema);

/** Parse a protocol idempotency key into the supported application value. */
export function parseIdempotencyKey(
  candidate: string,
): Effect.Effect<string, InvalidIdempotencyKey> {
  return decodeIdempotencyKey(candidate).pipe(
    Effect.mapError(() =>
      new InvalidIdempotencyKey({
        message: "Idempotency keys must contain between 16 and 200 characters.",
      })
    ),
  );
}
