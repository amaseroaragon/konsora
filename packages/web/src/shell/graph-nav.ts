/**
 * Keyboard navigation over the dependency graph (UI-06), as a pure model so it can be tested
 * without a browser. Arrows follow the structure, not pixels:
 * - Left: to a dependency (the one in the nearest layer, then the closest on screen).
 * - Right: to a dependent (same rule), i.e. a task that needs this one.
 * - Up / Down: to the previous / next task of the same layer; Home / End: its first / last.
 * Layers are longest-path depths (roots are 0), so every task is reachable from any other:
 * Up/Down covers a layer and Right always offers the next one when it exists.
 */
import type { TaskState } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { stateLabel } from "../ui/index.ts";
import type { LayoutTask, Point, Positions, Viewport } from "./graph-model.ts";
import { NODE_H, NODE_W, nodeTone } from "./graph-model.ts";

export type NavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";
export const navKeys: readonly NavKey[] = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

export type NavGraph = {
  deps: Map<string, string[]>;
  dependents: Map<string, string[]>;
  depth: Map<string, number>;
  /** Tasks of each depth, top to bottom on screen. */
  layers: string[][];
  position: Positions;
};

export function navGraph(tasks: readonly LayoutTask[], positions: Positions): NavGraph {
  const ids = new Set(tasks.map((task) => task.id));
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    const own = (task.deps ?? []).filter((dep) => ids.has(dep));
    deps.set(task.id, own);
    for (const dep of own) dependents.get(dep)?.push(task.id);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // core rejects cycles; never loop on a bad file
    visiting.add(id);
    const d = Math.max(-1, ...(deps.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const task of tasks) depthOf(task.id);
  const at = (id: string): Point => positions[id] ?? { x: 0, y: 0 };
  const layers: string[][] = [];
  for (const task of tasks) {
    const d = depth.get(task.id) ?? 0;
    layers[d] = [...(layers[d] ?? []), task.id];
  }
  for (const layer of layers) layer?.sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x);
  return { deps, dependents, depth, layers: layers.filter(Boolean), position: positions };
}

/** Where a key moves the focus from `from`; null when there is nowhere to go that way. */
export function navigateGraph(graph: NavGraph, from: string, key: NavKey): string | null {
  const depth = graph.depth.get(from);
  if (depth === undefined) return null;
  const y = graph.position[from]?.y ?? 0;
  const nearest = (candidates: string[], layerDistance: (id: string) => number) =>
    [...candidates].sort(
      (a, b) =>
        layerDistance(a) - layerDistance(b) ||
        Math.abs((graph.position[a]?.y ?? 0) - y) - Math.abs((graph.position[b]?.y ?? 0) - y),
    )[0] ?? null;
  const layer = graph.layers.find((ids) => ids.includes(from)) ?? [from];
  const index = layer.indexOf(from);
  switch (key) {
    case "ArrowLeft":
      return nearest(graph.deps.get(from) ?? [], (id) => depth - (graph.depth.get(id) ?? 0));
    case "ArrowRight":
      return nearest(graph.dependents.get(from) ?? [], (id) => (graph.depth.get(id) ?? 0) - depth);
    case "ArrowUp":
      return layer[index - 1] ?? null;
    case "ArrowDown":
      return layer[index + 1] ?? null;
    case "Home":
      return index > 0 ? (layer[0] ?? null) : null;
    case "End":
      return index < layer.length - 1 ? (layer[layer.length - 1] ?? null) : null;
  }
}

/**
 * The task the graph's single tab stop lands on: the open one, else the first root that other
 * tasks depend on (where the plan starts), else the first root.
 */
export function entryNode(graph: NavGraph, preferred: string | null): string | null {
  if (preferred && graph.depth.has(preferred)) return preferred;
  const roots = graph.layers[0] ?? [];
  return roots.find((id) => (graph.dependents.get(id)?.length ?? 0) > 0) ?? roots[0] ?? null;
}

/** Room kept around a revealed node; also clears the zoom controls in the bottom-left corner. */
export const REVEAL_MARGIN = 56;
const MARGIN = REVEAL_MARGIN;

/**
 * The smallest pan that brings a node (with a margin) inside a view of `size`, keeping the zoom;
 * null when it is already fully visible.
 */
export function panIntoView(
  viewport: Viewport,
  size: { width: number; height: number },
  node: Point,
): Viewport | null {
  const { zoom } = viewport;
  const left = node.x * zoom + viewport.x;
  const top = node.y * zoom + viewport.y;
  const right = left + NODE_W * zoom;
  const bottom = top + NODE_H * zoom;
  const shift = (start: number, end: number, limit: number) => {
    if (end - start > limit - 2 * MARGIN) return MARGIN - start; // too big: align its start
    if (start < MARGIN) return MARGIN - start;
    if (end > limit - MARGIN) return limit - MARGIN - end;
    return 0;
  };
  const dx = shift(left, right, size.width);
  const dy = shift(top, bottom, size.height);
  if (dx === 0 && dy === 0) return null;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom };
}

/** What a screen reader says on a node, in Spanish: task, state, flags and both directions of deps. */
export function nodeLabel(
  task: { id: string; title: string; state: TaskState; blocked?: boolean; waiting?: boolean },
  external: boolean,
  graph: NavGraph,
): string {
  const deps = graph.deps.get(task.id) ?? [];
  const dependents = graph.dependents.get(task.id) ?? [];
  const flags = [task.waiting && stateLabel("waiting"), external && stateLabel("external")]
    .filter(Boolean)
    .map((flag) => `${flag}.`);
  return [
    t("graph.node.label", { id: task.id, title: task.title, state: stateLabel(nodeTone(task)) }),
    ...flags,
    deps.length ? t("graph.node.deps", { ids: deps.join(", ") }) : t("graph.node.noDeps"),
    dependents.length
      ? t("graph.node.dependents", { ids: dependents.join(", ") })
      : t("graph.node.noDependents"),
  ].join(" ");
}
