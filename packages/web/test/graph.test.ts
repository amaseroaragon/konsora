import { readFileSync } from "node:fs";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import {
  elkInput,
  graphEdges,
  layoutKey,
  NODE_COLORS,
  NODE_W,
  nodeStyle,
  nodeTone,
  positionsOf,
} from "../src/shell/graph-model.ts";
import { contrast } from "../src/theme/contrast.ts";
import { themes } from "../src/theme/tokens.ts";
import { generatedPlan } from "./fixtures/plan.ts";

describe("graph node colors (UI-05 ac3)", () => {
  for (const [theme, palette] of Object.entries(themes)) {
    describe(`${theme} theme`, () => {
      it.each(Object.entries(NODE_COLORS))("%s meets AA", (_tone, colors) => {
        const bg = palette[colors.bg];
        expect(contrast(palette[colors.ink], bg), "title").toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette[colors.muted], bg), "state label").toBeGreaterThanOrEqual(4.5);
        // The border is what separates the node from the canvas (non-text UI: 3:1).
        expect(contrast(palette[colors.border], palette.bg), "border").toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("paints nodes only with Plano tokens that exist in tokens.css", () => {
    const css = readFileSync(new URL("../src/theme/tokens.css", import.meta.url), "utf8");
    for (const tone of Object.keys(NODE_COLORS) as (keyof typeof NODE_COLORS)[]) {
      for (const value of Object.values(nodeStyle(tone))) {
        const token = /^var\((--k-[a-z-]+)\)$/.exec(value)?.[1];
        if (token) expect(css).toContain(`${token}:`);
        else expect(["solid", "dashed"]).toContain(value);
      }
    }
  });

  it("derives the tone from the state, with blocked todos apart", () => {
    expect(nodeTone({ state: "todo", blocked: true })).toBe("blocked");
    expect(nodeTone({ state: "todo", blocked: false })).toBe("todo");
    expect(nodeTone({ state: "doing", blocked: true })).toBe("doing");
  });
});

describe("graph layout", () => {
  it("draws an edge per dependency, dep → task, ignoring unknown ids", () => {
    expect(
      graphEdges([
        { id: "A", deps: [] },
        { id: "B", deps: ["A", "Z"] },
      ]),
    ).toEqual([{ id: "A->B", from: "A", to: "B" }]);
  });

  it("re-lays out only when tasks or dependencies change", () => {
    const plan = [
      { id: "A", deps: [] },
      { id: "B", deps: ["A"] },
    ];
    expect(layoutKey(plan)).toBe(layoutKey(plan.map((task) => ({ ...task, state: "done" }))));
    expect(layoutKey(plan)).not.toBe(layoutKey([...plan, { id: "C", deps: ["B"] }]));
  });

  it("lays out 150 tasks in layers, each to the right of its dependencies", async () => {
    const plan = generatedPlan(150);
    const positions = positionsOf(await new ELK().layout(elkInput(plan)));
    expect(Object.keys(positions)).toHaveLength(150);
    for (const edge of graphEdges(plan)) {
      const from = positions[edge.from];
      const to = positions[edge.to];
      expect(from && to && from.x + NODE_W <= to.x, `${edge.from} → ${edge.to}`).toBe(true);
    }
    // Timing is measured in the browser and recorded in the commit (ac1), not asserted here.
  }, 20_000);
});
