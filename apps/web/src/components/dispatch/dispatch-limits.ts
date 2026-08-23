/**
 * The dispatch bounds the server enforces, mirrored here only so a send
 * control can cap a bundle and refuse an over-long note before the round trip.
 * `src/core/publishing-limits.ts` remains the authority: an oversized bundle
 * is rejected there whatever this says.
 */
export const maximumDispatchBundleSize = 100;

export const maximumDispatchNoteCharacters = 2_000;
