import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "../src/theme/contrast.ts";
import { tokensCss } from "../src/theme/css.ts";
import { colorNames, contrastPairs, themes } from "../src/theme/tokens.ts";

describe("design tokens", () => {
  for (const [name, palette] of Object.entries(themes)) {
    describe(`${name} theme`, () => {
      it("defines every color as #RRGGBB", () => {
        for (const color of colorNames) expect(palette[color]).toMatch(/^#[0-9A-F]{6}$/);
      });

      it.each(contrastPairs)("$fg on $bg meets $min:1 ($use)", ({ fg, bg, min }) => {
        const ratio = contrast(palette[fg], palette[bg]);
        expect(
          ratio,
          `${fg} ${palette[fg]} on ${bg} ${palette[bg]} = ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(min);
      });
    });
  }

  it("committed tokens.css matches tokens.ts (run `npm run tokens -w @konsora/web`)", () => {
    const committed = readFileSync(new URL("../src/theme/tokens.css", import.meta.url), "utf8");
    expect(committed).toBe(tokensCss());
  });

  it("computes known WCAG ratios", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});
