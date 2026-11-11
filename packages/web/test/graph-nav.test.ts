import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { elkInput, NODE_H, NODE_W, positionsOf } from "../src/shell/graph-model.ts";
import {
  entryNode,
  type NavGraph,
  navGraph,
  navigateGraph,
  navKeys,
  nodeLabel,
  panIntoView,
  REVEAL_MARGIN,
} from "../src/shell/graph-nav.ts";
import { generatedPlan } from "./fixtures/plan.ts";

//   A ─┬─ C ── E
//   B ─┘   └── F      D (alone)
const plan = [
  { id: "A", deps: [] },
  { id: "B", deps: [] },
  { id: "C", deps: ["A", "B"] },
  { id: "D", deps: [] },
  { id: "E", deps: ["C"] },
  { id: "F", deps: ["C", "A"] },
];
const positions = {
  A: { x: 0, y: 0 },
  B: { x: 0, y: 100 },
  D: { x: 0, y: 300 },
  C: { x: 300, y: 50 },
  E: { x: 600, y: 0 },
  F: { x: 600, y: 100 },
};

/** Every task reachable from the entry with the arrow keys alone. */
function reachable(graph: NavGraph, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const key of navKeys) {
      const next = navigateGraph(graph, id, key);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("graph keyboard navigation (UI-06)", () => {
  const graph = navGraph(plan, positions);

  it("groups tasks in longest-path layers, top to bottom", () => {
    expect(graph.layers).toEqual([["A", "B", "D"], ["C"], ["E", "F"]]);
  });

  it("Left goes to a dependency, Right to a dependent, nearest on screen first", () => {
    expect(navigateGraph(graph, "C", "ArrowLeft")).toBe("A");
    expect(navigateGraph(graph, "C", "ArrowRight")).toBe("E");
    expect(navigateGraph(graph, "F", "ArrowLeft")).toBe("C"); // C (1 layer back) before A (2)
    expect(navigateGraph(graph, "A", "ArrowRight")).toBe("C"); // C (next layer) before F
    expect(navigateGraph(graph, "A", "ArrowLeft")).toBeNull();
    expect(navigateGraph(graph, "E", "ArrowRight")).toBeNull();
  });

  it("Up/Down move within the layer and Home/End jump to its ends", () => {
    expect(navigateGraph(graph, "A", "ArrowDown")).toBe("B");
    expect(navigateGraph(graph, "B", "ArrowDown")).toBe("D");
    expect(navigateGraph(graph, "D", "ArrowDown")).toBeNull();
    expect(navigateGraph(graph, "A", "ArrowUp")).toBeNull();
    expect(navigateGraph(graph, "A", "End")).toBe("D");
    expect(navigateGraph(graph, "D", "Home")).toBe("A");
    expect(navigateGraph(graph, "A", "Home")).toBeNull();
  });

  it("enters on the open task, else on the first root", () => {
    expect(entryNode(graph, "E")).toBe("E");
    expect(entryNode(graph, null)).toBe("A");
    expect(entryNode(graph, "gone")).toBe("A");
    // An isolated task first on screen is skipped in favour of a root that starts a chain.
    const lone = navGraph(plan, { ...positions, D: { x: 0, y: -100 } });
    expect(lone.layers[0]?.[0]).toBe("D");
    expect(entryNode(lone, null)).toBe("A");
  });

  it("reaches every task of the small plan, including an isolated one", () => {
    expect(reachable(graph, "A")).toEqual(new Set(plan.map((task) => task.id)));
  });

  it("reaches all 150 tasks of a generated plan laid out by ELK (ac1)", async () => {
    const tasks = generatedPlan(150);
    const big = navGraph(tasks, positionsOf(await new ELK().layout(elkInput(tasks))));
    const start = entryNode(big, null);
    expect(start).not.toBeNull();
    expect(reachable(big, start as string).size).toBe(150);
  }, 20_000);
});

describe("panIntoView (ac2)", () => {
  const size = { width: 800, height: 600 };

  it("does nothing when the node is already visible", () => {
    expect(panIntoView({ x: 0, y: 0, zoom: 1 }, size, { x: 100, y: 100 })).toBeNull();
  });

  it("pans the least needed to bring an off-screen node inside, keeping the zoom", () => {
    const right = panIntoView({ x: 0, y: 0, zoom: 1 }, size, { x: 1000, y: 100 });
    expect(right).toEqual({ x: 800 - REVEAL_MARGIN - (1000 + NODE_W), y: 0, zoom: 1 });
    const above = panIntoView({ x: 0, y: 0, zoom: 0.5 }, size, { x: 200, y: -400 });
    expect(above).toEqual({ x: 0, y: REVEAL_MARGIN + 200, zoom: 0.5 });
  });

  it("leaves the node fully inside the view after panning", () => {
    for (const node of [
      { x: -900, y: 50 },
      { x: 5000, y: 5000 },
      { x: 300, y: -2000 },
    ]) {
      const view = panIntoView({ x: 10, y: 20, zoom: 0.75 }, size, node);
      expect(view).not.toBeNull();
      if (!view) continue;
      const left = node.x * view.zoom + view.x;
      const top = node.y * view.zoom + view.y;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + NODE_W * view.zoom).toBeLessThanOrEqual(size.width);
      expect(top + NODE_H * view.zoom).toBeLessThanOrEqual(size.height);
    }
  });
});

describe("node labels for screen readers (ac3)", () => {
  const graph = navGraph(plan, positions);

  it("names the task, its state and its dependencies in Spanish", () => {
    expect(
      nodeLabel({ id: "C", title: "Tarea C", state: "todo", blocked: true }, false, graph),
    ).toBe("C, Tarea C. Bloqueada. Depende de A, B. La necesitan E, F.");
    expect(nodeLabel({ id: "D", title: "Sola", state: "doing", waiting: true }, true, graph)).toBe(
      "D, Sola. En curso. Esperando respuesta. Cambio externo. Sin dependencias. Ninguna tarea depende de ella.",
    );
  });
});
