/**
 * Graph view model (UI-05): ELK input for the dependency DAG, the layout's structural key, and the
 * Plano tokens each node is drawn with. Pure, so it runs in the layout worker and in tests.
 */
import type { TaskState } from "@konsora/core";
import type { ColorName } from "../theme/tokens.ts";

export const NODE_W = 232;
export const NODE_H = 76;

/** What the layout needs from a task: nothing else moves a node. */
export type LayoutTask = { id: string; deps?: readonly string[] | undefined; group?: string };
export type Point = { x: number; y: number };
export type Positions = Record<string, Point>;
/** A group's frame when the graph is grouped (UI-24): top-left, size, absolute. */
export type GroupBox = { group: string; x: number; y: number; width: number; height: number };

type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
};
export type ElkInput = {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkNode[];
  edges: { id: string; sources: string[]; targets: string[] }[];
};

/** Prefix of a group's compound node, never a task id (ids are `GROUP-NN`). */
export const GROUP_NODE = "group:";
/** Room inside a group's frame; the top one holds its name. */
const GROUP_PADDING = "[top=36,left=16,bottom=16,right=16]";

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

/**
 * The ELK graph. Grouped (UI-24), each group is a compound node holding its tasks, in the order
 * groups first appear; edges cross groups, so ELK lays out the whole hierarchy at once.
 */
export function elkInput(tasks: readonly LayoutTask[], grouped = false): ElkInput {
  const node = (task: LayoutTask): ElkNode => ({ id: task.id, width: NODE_W, height: NODE_H });
  const edges = graphEdges(tasks).map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
  }));
  if (!grouped) return { id: "root", layoutOptions: ELK_OPTIONS, children: tasks.map(node), edges };
  const groups = new Map<string, ElkNode[]>();
  for (const task of tasks) {
    const group = task.group ?? "";
    groups.set(group, [...(groups.get(group) ?? []), node(task)]);
  }
  return {
    id: "root",
    layoutOptions: { ...ELK_OPTIONS, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [...groups].map(([group, children]) => ({
      id: `${GROUP_NODE}${group}`,
      layoutOptions: { "elk.padding": GROUP_PADDING },
      children,
    })),
    edges,
  };
}

/** Changes only when tasks, dependencies or grouping do: a state change recolors in place. */
export function layoutKey(tasks: readonly LayoutTask[], grouped = false): string {
  const key = tasks.map((task) => `${task.id}<${(task.deps ?? []).join(",")}`);
  return grouped
    ? `grouped|${tasks.map((task, i) => `${key[i]}@${task.group ?? ""}`).join("|")}`
    : key.join("|");
}

type ElkResult = {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkResult[];
};

/** ELK's result → absolute top-left positions by task id (group frames left out). */
export function positionsOf(result: ElkResult): Positions {
  const out: Positions = {};
  const walk = (node: ElkResult, dx: number, dy: number) => {
    for (const child of node.children ?? []) {
      const x = dx + (child.x ?? 0);
      const y = dy + (child.y ?? 0);
      if (child.id?.startsWith(GROUP_NODE)) walk(child, x, y);
      else if (child.id) out[child.id] = { x, y };
    }
  };
  walk(result, 0, 0);
  return out;
}

/** The group frames of a grouped layout; empty when it is not grouped. */
export function groupBoxesOf(result: ElkResult): GroupBox[] {
  return (result.children ?? [])
    .filter((child) => child.id?.startsWith(GROUP_NODE))
    .map((child) => ({
      group: (child.id ?? "").slice(GROUP_NODE.length),
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
    }));
}

/**
 * The chain of an open task (UI-24): the task, everything it needs and everything it unblocks,
 * transitively, plus the edges along it (between two of its dependencies, or two of its
 * dependents, or to and from the task). Null when nothing is open.
 */
export function chainOf(
  tasks: readonly LayoutTask[],
  id: string | null,
): { nodes: Set<string>; edges: Set<string> } | null {
  if (!id || !tasks.some((task) => task.id === id)) return null;
  const edges = graphEdges(tasks);
  const reach = (start: string, next: (from: string) => string[]) => {
    const seen = new Set<string>();
    const stack = next(start);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === start || seen.has(current)) continue;
      seen.add(current);
      stack.push(...next(current));
    }
    return seen;
  };
  const up = reach(id, (from) => edges.filter((e) => e.to === from).map((e) => e.from));
  const down = reach(id, (from) => edges.filter((e) => e.from === from).map((e) => e.to));
  const upside = new Set([...up, id]);
  const downside = new Set([...down, id]);
  return {
    nodes: new Set([id, ...up, ...down]),
    edges: new Set(
      edges
        .filter(
          (e) =>
            (upside.has(e.from) && upside.has(e.to)) ||
            (downside.has(e.from) && downside.has(e.to)),
        )
        .map((e) => e.id),
    ),
  };
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
