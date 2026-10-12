import {timingSafeEqual} from "node:crypto";

/** Prefix that marks a bearer as a staged upload grant, never an API key. */
export const uploadGrantPrefix = "as_upg_";

/** Report whether a bearer is shaped like an upload grant. */
export function isUploadGrantToken(token: string): boolean {
  return token.startsWith(uploadGrantPrefix);
}

/** Compare two hex SHA-256 digests without leaking where they differ. */
export function uploadGrantDigestsEqual(presented: string, stored: string): boolean {
  const left = Buffer.from(presented, "hex");
  const right = Buffer.from(stored, "hex");
  return left.byteLength === 32
    && right.byteLength === 32
    && timingSafeEqual(left, right);
}
