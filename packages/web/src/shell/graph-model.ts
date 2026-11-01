/**
 * Graph view model (UI-05): ELK input for the dependency DAG, the layout's structural key, and the
 * Plano tokens each node is drawn with. Pure, so it runs in the layout worker and in tests.
 */
import type { TaskState } from "@konsora/core";
import type { ColorName } from "../theme/tokens.ts";

export const NODE_W = 232;
export const NODE_H = 76;

/** What the layout needs from a task: nothing else moves a node. */
export type LayoutTask = { id: string; deps?: readonly string[] | undefined };
export type Point = { x: number; y: number };
export type Positions = Record<string, Point>;

export type ElkInput = {
  id: string;
  layoutOptions: Record<string, string>;
  children: { id: string; width: number; height: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
};

/** Layered left-to-right: a task sits to the right of everything it depends on. */
export const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "20",
  "elk.spacing.componentComponent": "40",
  // Measured on a 150-task plan: thoroughness 7 → 3 and no model-order pass save ~150 ms of a
  // ~600 ms cold layout, with no visible loss on plans this size.
  "elk.layered.thoroughness": "3",
};

/** Edge `dep → task`, only between tasks in the plan (core rejects dangling deps anyway). */
export function graphEdges(
  tasks: readonly LayoutTask[],
): { id: string; from: string; to: string }[] {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks.flatMap((task) =>
    (task.deps ?? [])
      .filter((dep) => ids.has(dep))
      .map((dep) => ({ id: `${dep}->${task.id}`, from: dep, to: task.id })),
  );
}

export function elkInput(tasks: readonly LayoutTask[]): ElkInput {
  return {
    id: "root",
    layoutOptions: ELK_OPTIONS,
    children: tasks.map((task) => ({ id: task.id, width: NODE_W, height: NODE_H })),
    edges: graphEdges(tasks).map((edge) => ({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };
}

/** Changes only when tasks or dependencies do: a state change recolors without re-layout. */
export function layoutKey(tasks: readonly LayoutTask[]): string {
  return tasks.map((task) => `${task.id}<${(task.deps ?? []).join(",")}`).join("|");
}

/** ELK's result → top-left positions by task id. */
export function positionsOf(result: {
  children?: { id: string; x?: number; y?: number }[];
}): Positions {
  const out: Positions = {};
  for (const child of result.children ?? []) out[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  return out;
}

/** A node's look: its stored state, or "blocked" for a todo still waiting on dependencies. */
export type NodeTone = TaskState | "blocked";

export type NodeColors = {
  /** Fill, text, secondary text and border, all Plano color tokens. */
  bg: ColorName;
  ink: ColorName;
  muted: ColorName;
  border: ColorName;
  dashed: boolean;
};

/** The single source for node colors; `test/graph.test.ts` checks every pair for AA contrast. */
export const NODE_COLORS: Record<NodeTone, NodeColors> = {
  proposed: {
    bg: "proposed-soft",
    ink: "proposed-ink",
    muted: "proposed-ink",
    border: "proposed",
    dashed: true,
  },
  todo: { bg: "surface", ink: "ink", muted: "ink-muted", border: "line-strong", dashed: false },
  blocked: {
    bg: "neutral-soft",
    ink: "neutral-ink",
    muted: "neutral-ink",
    border: "line-strong",
    dashed: true,
  },
  doing: { bg: "surface", ink: "ink", muted: "accent", border: "accent", dashed: false },
  review: {
    bg: "accent-soft",
    ink: "ink",
    muted: "accent-soft-ink",
    border: "accent",
    dashed: false,
  },
  done: { bg: "done-soft", ink: "ink", muted: "done-ink", border: "done", dashed: false },
};

export function nodeTone(task: { state: TaskState; blocked?: boolean }): NodeTone {
  return task.state === "todo" && task.blocked ? "blocked" : task.state;
}

/** Inline style that paints a node from its tone's tokens. */
export function nodeStyle(tone: NodeTone): Record<string, string> {
  const colors = NODE_COLORS[tone];
  return {
    "--g-bg": `var(--k-${colors.bg})`,
    "--g-ink": `var(--k-${colors.ink})`,
    "--g-muted": `var(--k-${colors.muted})`,
    "--g-border": `var(--k-${colors.border})`,
    "--g-border-style": colors.dashed ? "dashed" : "solid",
  };
}

export type Viewport = { x: number; y: number; zoom: number };
const VIEW_PAD = 24;
/** Below this zoom node titles are unreadable, so a big plan opens at its roots instead. */
const MIN_FIT_ZOOM = 0.5;
const OVERVIEW_ZOOM = 0.75;

/**
 * Where the graph opens: centered on the open task at 100 %, the whole plan if it fits readably,
 * or else the top-left (where the roots are) at a readable zoom.
 */
export function initialViewport(
  positions: Positions,
  size: { width: number; height: number },
  focus: string | null,
): Viewport {
  const points = Object.values(positions);
  if (points.length === 0) return { x: 0, y: 0, zoom: 1 };
  const target = focus ? positions[focus] : undefined;
  if (target)
    return {
      x: size.width / 2 - (target.x + NODE_W / 2),
      y: size.height / 2 - (target.y + NODE_H / 2),
      zoom: 1,
    };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const width = Math.max(...points.map((p) => p.x)) + NODE_W - minX;
  const height = Math.max(...points.map((p) => p.y)) + NODE_H - minY;
  const fit = Math.min(
    (size.width - 2 * VIEW_PAD) / width,
    (size.height - 2 * VIEW_PAD) / height,
    1,
  );
  if (fit >= MIN_FIT_ZOOM)
    return {
      x: (size.width - width * fit) / 2 - minX * fit,
      y: (size.height - height * fit) / 2 - minY * fit,
      zoom: fit,
    };
  return {
    x: VIEW_PAD - minX * OVERVIEW_ZOOM,
    y: VIEW_PAD - minY * OVERVIEW_ZOOM,
    zoom: OVERVIEW_ZOOM,
  };
}
