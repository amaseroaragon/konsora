import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contentHash, sha256Hex, stableStringify } from "../src/hash.ts";

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("property: equals node:crypto for any string (incl. multi-block and non-ASCII)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: "grapheme" }), (s) => {
        expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
      }),
      { numRuns: 200 },
    );
  });
});

describe("contentHash", () => {
  it("ignores key order and undefined values", () => {
    expect(contentHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      contentHash({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }),
    );
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
    expect(stableStringify({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });
});
