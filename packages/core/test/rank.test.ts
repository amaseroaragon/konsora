import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rankAfterAll, rankBetween } from "../src/rank.ts";

const rank = fc.string({
  minLength: 1,
  maxLength: 6,
  unit: fc.constantFrom(..."0123456789abcdefghijklmnopqrstuvwxyz"),
});

describe("rankBetween", () => {
  it("handles the open ends", () => {
    expect(rankBetween()).toBe("i");
    expect(rankBetween(undefined, "1") < "1").toBe(true);
    expect(rankBetween("z") > "z").toBe(true);
  });

  it("finds room between adjacent ranks", () => {
    const r = rankBetween("a", "b");
    expect(r > "a" && r < "b").toBe(true);
    const s = rankBetween("a0", "a1");
    expect(s > "a0" && s < "a1").toBe(true);
  });

  it("property: result is strictly between and uses only 0-9a-z", () => {
    fc.assert(
      fc.property(rank, rank, (x, y) => {
        fc.pre(x !== y);
        const [lo, hi] = x < y ? [x, y] : [y, x];
        // Only `lo + "0"…0` directly before `hi` leaves no room; skip that degenerate case.
        fc.pre(!/^0+$/.test(hi.slice(lo.length)) || !hi.startsWith(lo));
        const r = rankBetween(lo, hi);
        expect(r > lo && r < hi).toBe(true);
        expect(r).toMatch(/^[0-9a-z]+$/);
      }),
    );
  });

  it("property: repeated insertion before the same neighbour keeps working", () => {
    fc.assert(
      fc.property(rank, fc.integer({ min: 1, max: 40 }), (start, n) => {
        fc.pre(!/^0+$/.test(start));
        let hi = start;
        for (let i = 0; i < n; i++) {
          const r = rankBetween(undefined, hi);
          expect(r < hi).toBe(true);
          expect(r.endsWith("0")).toBe(false);
          hi = r;
        }
      }),
    );
  });

  it("handles prefixes and zeros in string order (a < a0 < a00 < a1)", () => {
    for (const [lo, hi] of [
      ["a", "a01"],
      ["a0", "a01"],
      [undefined, "00"],
      [undefined, "a"],
      ["zz", undefined],
      ["a0", "a1"],
    ] as const) {
      const r = rankBetween(lo, hi);
      if (lo !== undefined) expect(r > lo).toBe(true);
      if (hi !== undefined) expect(r < hi).toBe(true);
    }
  });

  it("throws when nothing fits", () => {
    expect(() => rankBetween(undefined, "0")).toThrow();
    expect(() => rankBetween("a", "a0")).toThrow();
    expect(() => rankBetween("a0", "a00")).toThrow();
  });

  it("rejects an inverted range", () => {
    expect(() => rankBetween("b", "a")).toThrow();
  });
});

describe("rankAfterAll", () => {
  it("is after every given rank", () => {
    expect(rankAfterAll([])).toBe("i");
    const r = rankAfterAll(["a0", "zz", "9"]);
    expect(r > "zz").toBe(true);
  });
});
