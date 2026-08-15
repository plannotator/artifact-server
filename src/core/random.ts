import {randomBytes} from "node:crypto";

/** Issue cryptographically random bytes as lowercase hexadecimal text. */
export function randomHex(byteLength: number): string {
  let encoded = "";
  for (const byte of randomBytes(byteLength)) {
    encoded += byte.toString(16).padStart(2, "0");
  }
  return encoded;
}

/** Issue cryptographically random bytes as unpadded URL-safe Base64 text. */
export function randomBase64Url(byteLength: number): string {
  let binary = "";
  for (const byte of randomBytes(byteLength)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
