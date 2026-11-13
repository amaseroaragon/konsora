import { readFileSync } from "node:fs";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import {
  chainOf,
  elkInput,
  graphEdges,
  groupBoxesOf,
  layoutKey,
  linkFromDrag,
  NODE_COLORS,
  NODE_H,
  NODE_W,
  nextDependencyEdge,
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

describe("graph chain and grouping (UI-24)", () => {
  // A → B → C, D → B, E alone; F depends on A only.
  const plan = [
    { id: "A", group: "BE" },
    { id: "B", deps: ["A", "D"], group: "BE" },
    { id: "C", deps: ["B"], group: "FE" },
    { id: "D", group: "FE" },
    { id: "E", group: "FE" },
    { id: "F", deps: ["A"], group: "BE" },
  ];

  it("the chain of a task is what it needs and what it unblocks, transitively (ac2)", () => {
    const chain = chainOf(plan, "B");
    expect([...(chain?.nodes ?? [])].sort()).toEqual(["A", "B", "C", "D"]);
    // A → F is not on B's chain: F neither needs B nor is needed by it.
    expect([...(chain?.edges ?? [])].sort()).toEqual(["A->B", "B->C", "D->B"]);
    expect(chainOf(plan, null)).toBeNull();
    expect(chainOf(plan, "GONE")).toBeNull();
  });

  it("grouping changes the layout key, and only then the groups matter", () => {
    expect(layoutKey(plan, true)).not.toBe(layoutKey(plan));
    const moved = plan.map((task) => (task.id === "E" ? { ...task, group: "BE" } : task));
    expect(layoutKey(moved)).toBe(layoutKey(plan));
    expect(layoutKey(moved, true)).not.toBe(layoutKey(plan, true));
  });

  it("lays each group out in its own frame, with every task inside its group's (ac3)", async () => {
    const result = await new ELK().layout(elkInput(plan, true));
    const positions = positionsOf(result);
    const boxes = groupBoxesOf(result);
    expect(Object.keys(positions).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(boxes.map((box) => box.group).sort()).toEqual(["BE", "FE"]);
    for (const task of plan) {
      const box = boxes.find((b) => b.group === task.group);
      const at = positions[task.id];
      expect(box && at, task.id).toBeTruthy();
      if (!box || !at) continue;
      expect(at.x).toBeGreaterThanOrEqual(box.x);
      expect(at.y).toBeGreaterThanOrEqual(box.y);
      expect(at.x + NODE_W).toBeLessThanOrEqual(box.x + box.width);
      expect(at.y + NODE_H).toBeLessThanOrEqual(box.y + box.height);
    }
    // Ungrouped, there are no frames.
    expect(groupBoxesOf(await new ELK().layout(elkInput(plan)))).toEqual([]);
  });
});

describe("editing dependencies from the graph (UI-23)", () => {
  it("a drag from the right handle makes the target depend on the source, and vice versa (ac1)", () => {
    expect(linkFromDrag("A", "source", "B")).toEqual({ task: "B", on: "A" });
    expect(linkFromDrag("B", "target", "A")).toEqual({ task: "B", on: "A" });
    expect(linkFromDrag("A", "source", "A")).toBeNull();
    expect(linkFromDrag("A", "source", null)).toBeNull();
    expect(linkFromDrag("A", "source", "group:BE")).toBeNull();
  });

  it("D walks a task's dependencies one after another, cycling (ac2)", () => {
    expect(nextDependencyEdge("C", [], null)).toBeNull();
    const first = nextDependencyEdge("C", ["A", "B"], null);
    expect(first).toEqual({ task: "C", on: "A" });
    const second = nextDependencyEdge("C", ["A", "B"], first);
    expect(second).toEqual({ task: "C", on: "B" });
    expect(nextDependencyEdge("C", ["A", "B"], second)).toEqual({ task: "C", on: "A" });
    // A selection on another task starts over.
    expect(nextDependencyEdge("C", ["A", "B"], { task: "X", on: "B" })).toEqual({
      task: "C",
      on: "A",
    });
  });
});
