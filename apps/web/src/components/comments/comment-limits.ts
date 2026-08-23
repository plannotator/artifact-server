/**
 * The comment limits the server enforces, mirrored here only so a composer can
 * refuse a body before the round trip. `src/core/publishing-limits.ts` remains
 * the authority: an over-long body is rejected there whatever this says.
 */
export const maximumCommentBodyCharacters = 8_192;
