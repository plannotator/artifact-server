import {describe, expect, test} from "vitest";

import {
  requireCloudObjectBody,
  verifyCloudObjectWriteSize,
} from "../../src/storage/cloud-object-storage.js";

describe("native cloud object integrity helpers", () => {
  test("an opened provider object must include the promised byte body", () => {
    const body = new Uint8Array([1, 2, 3]);
    expect(requireCloudObjectBody(body, "provider", "blob", "no body")).toBe(body);
    expect(() => requireCloudObjectBody(
      undefined,
      "provider",
      "staging",
      "no byte stream",
    )).toThrow("provider stored staging failed integrity inspection: no byte stream");
  });

  test("a completed provider upload must report the exact accepted size", () => {
    const stored = {sha256: "a".repeat(64), size: 8};
    expect(verifyCloudObjectWriteSize(stored, 8, "provider", "blob")).toBe(stored);
    expect(() => verifyCloudObjectWriteSize(
      stored,
      9,
      "provider",
      "blob",
    )).toThrow("provider recorded 8 bytes after a 9 byte upload");
  });
});
