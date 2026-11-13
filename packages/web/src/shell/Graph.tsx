import {
  type AriaLabelConfig,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import Elk, { type ELK } from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BoardTask } from "../api/board.ts";
import { t } from "../i18n/index.ts";
import { cx } from "../ui/cx.ts";
import { DifficultyMark, StateBadge, stateLabel } from "../ui/index.ts";
import {
  elkInput,
  graphEdges,
  initialViewport,
  type LayoutTask,
  layoutKey,
  NODE_H,
  NODE_W,
  nodeStyle,
  nodeTone,
  type Positions,
  positionsOf,
} from "./graph-model.ts";
import {
  entryNode,
  type NavKey,
  navGraph,
  navigateGraph,
  navKeys,
  nodeLabel,
  panIntoView,
} from "./graph-nav.ts";
import { isSelectable } from "./selection.ts";

type Layout = { key: string; positions: Positions; ms: number } | { key: string; error: string };

/**
 * Lays the DAG out with ELK in its own web worker (so a large plan never freezes the page), and
 * again only when tasks or dependencies change. Until a newer layout arrives the last one stays.
 */
function useGraphLayout(tasks: readonly LayoutTask[]): Layout | null {
  const key = layoutKey(tasks);
  const [layout, setLayout] = useState<Layout | null>(null);
  const elk = useRef<ELK | null>(null);
  const latest = useRef(0);
  const input = useRef(tasks);
  input.current = tasks;
  useEffect(() => {
    const instance = new Elk({ workerUrl: elkWorkerUrl });
    elk.current = instance;
    return () => {
      instance.terminateWorker();
      elk.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = elk.current;
    if (!instance) return;
    const id = ++latest.current;
    const started = performance.now();
    instance.layout(elkInput(input.current)).then(
      (result) => {
        if (id === latest.current)
          setLayout({ key, positions: positionsOf(result), ms: performance.now() - started });
      },
      (error: unknown) => {
        if (id === latest.current) setLayout({ key, error: String(error) });
      },
    );
  }, [key]);
  return layout;
}

type TaskNodeData = {
  task: BoardTask;
  external: boolean;
  open: boolean;
  /** Spoken name: id, title, state, dependencies and dependents. */
  label: string;
  /** The graph's single tab stop (roving tabindex). */
  tabbable: boolean;
  describedBy: string;
  selected: boolean;
  selectable: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onSelectWithDeps: (id: string) => void;
};
type TaskNode = Node<TaskNodeData, "task">;

/** A task in the graph: id, state and flags on top, title below, painted from its state tokens. */
const TaskNodeView = memo(function TaskNodeView({ data }: NodeProps<TaskNode>) {
  const {
    task,
    external,
    open,
    label,
    tabbable,
    describedBy,
    selected,
    selectable,
    onOpen,
    onToggle,
    onSelectWithDeps,
  } = data;
  const tone = nodeTone(task);
  return (
    <div
      className={cx("g-node", open && "g-node--open", selected && "g-node--selected")}
      style={{ ...nodeStyle(tone), width: NODE_W, height: NODE_H } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {selectable && (
        <input
          type="checkbox"
          className="g-node__select"
          // One tab stop for the graph: from the keyboard, Space on the node selects it.
          tabIndex={-1}
          checked={selected}
          aria-label={t("selection.node", { id: task.id })}
          onChange={() => onToggle(task.id)}
        />
      )}
      <button
        type="button"
        className="g-node__open"
        data-task={task.id}
        tabIndex={tabbable ? 0 : -1}
        // Shift+click selects the task with its pending dependencies instead of opening it.
        onClick={(event) =>
          event.shiftKey && selectable ? onSelectWithDeps(task.id) : onOpen(task.id)
        }
        aria-label={label}
        aria-describedby={describedBy}
        aria-expanded={open}
      >
        <span className="g-node__head">
          <span className="g-node__id">{task.id}</span>
          {task.difficulty && <DifficultyMark difficulty={task.difficulty} />}
          <span className="g-node__state">{stateLabel(tone)}</span>
        </span>
        <span className="g-node__title">{task.title}</span>
      </button>
      {(task.waiting || external) && (
        <span className="g-node__flags">
          {task.waiting && <StateBadge kind="waiting" />}
          {external && <StateBadge kind="external" />}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { task: TaskNodeView };

const ariaLabels = (): Partial<AriaLabelConfig> => ({
  "node.a11yDescription.default": t("graph.a11y.node"),
  "node.a11yDescription.keyboardDisabled": t("graph.a11y.node"),
  "edge.a11yDescription.default": t("graph.a11y.edge"),
  "controls.ariaLabel": t("graph.controls"),
  "controls.zoomIn.ariaLabel": t("graph.zoomIn"),
  "controls.zoomOut.ariaLabel": t("graph.zoomOut"),
  "controls.fitView.ariaLabel": t("graph.fit"),
});

export type GraphProps = {
  label: string;
  tasks: readonly BoardTask[];
  external: ReadonlySet<string>;
  openId: string | null;
  onOpen: (id: string) => void;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectWithDeps: (id: string) => void;
};

function GraphCanvas({
  label,
  tasks,
  external,
  openId,
  onOpen,
  selected,
  onToggle,
  onSelectWithDeps,
}: GraphProps) {
  const layout = useGraphLayout(tasks);
  const flow = useReactFlow();
  const fitted = useRef(false);
  const mounted = useRef(performance.now());
  const [drawnMs, setDrawnMs] = useState<number | null>(null);

  const positions = layout && "positions" in layout ? layout.positions : null;
  const nav = useMemo(() => (positions ? navGraph(tasks, positions) : null), [tasks, positions]);
  const instructionsId = useId();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const tabStop = nav
    ? focusId && nav.depth.has(focusId)
      ? focusId
      : entryNode(nav, openId)
    : null;
  const nodes = useMemo<TaskNode[]>(() => {
    if (!positions || !nav) return [];
    return tasks.flatMap((task) => {
      const position = positions[task.id];
      if (!position) return [];
      return [
        {
          id: task.id,
          type: "task" as const,
          position,
          width: NODE_W,
          height: NODE_H,
          data: {
            task,
            external: external.has(task.id),
            open: openId === task.id,
            label: nodeLabel(task, external.has(task.id), nav, selected.has(task.id)),
            tabbable: task.id === tabStop,
            describedBy: instructionsId,
            selected: selected.has(task.id),
            selectable: isSelectable(task),
            onOpen,
            onToggle,
            onSelectWithDeps,
          },
        },
      ];
    });
  }, [
    tasks,
    positions,
    nav,
    external,
    openId,
    onOpen,
    tabStop,
    instructionsId,
    selected,
    onToggle,
    onSelectWithDeps,
  ]);
  const edges = useMemo<Edge[]>(() => {
    const state = new Map(tasks.map((task) => [task.id, task.state]));
    return graphEdges(tasks).map((edge) => {
      const done = state.get(edge.from) === "done";
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        className: cx("g-edge", done && "g-edge--done"),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        focusable: false,
      };
    });
  }, [tasks]);

  // Place the view once, when the first layout is on screen; later updates keep the human's.
  const section = useRef<HTMLElement>(null);
  const focus = useRef(openId);
  focus.current = openId;
  useEffect(() => {
    if (fitted.current || nodes.length === 0 || !positions) return;
    fitted.current = true;
    const frame = requestAnimationFrame(() => {
      const box = section.current;
      const size = { width: box?.clientWidth ?? 800, height: box?.clientHeight ?? 600 };
      flow.setViewport(initialViewport(positions, size, focus.current));
      const ms = performance.now() - mounted.current;
      performance.measure("konsora:graph-first-draw", { start: mounted.current, duration: ms });
      setDrawnMs(Math.round(ms));
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes.length, positions, flow]);

  // Keep the focused node inside the view: the smallest pan that shows it, same zoom.
  const reveal = useCallback(
    (id: string) => {
      const position = positions?.[id];
      const box = section.current;
      if (!position || !box) return;
      // The graph fits in the page by design; bring all of it on screen if the page scrolled.
      box.scrollIntoView({ block: "nearest", inline: "nearest" });
      const size = { width: box.clientWidth, height: box.clientHeight };
      const next = panIntoView(flow.getViewport(), size, position);
      if (next) flow.setViewport(next);
    },
    [positions, flow],
  );
  const moveTo = (id: string) => {
    setFocusId(id);
    reveal(id);
    section.current
      ?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = (event.target as HTMLElement).dataset?.task;
    if (from && event.key === " ") {
      // Space selects instead of opening (Enter opens); Shift+Space takes the pending deps too.
      event.preventDefault();
      const task = tasks.find((x) => x.id === from);
      if (task && isSelectable(task)) {
        if (event.shiftKey) onSelectWithDeps(from);
        else onToggle(from);
      }
      return;
    }
    const key = event.key as NavKey;
    if (!from || !nav || !navKeys.includes(key)) return;
    event.preventDefault();
    const next = navigateGraph(nav, from, key);
    if (next) {
      setAnnouncement("");
      moveTo(next);
    } else {
      // A trailing no-break space makes a repeated message count as new, so it is said again.
      const text = t(`graph.nav.${key}`, { id: from });
      setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
    }
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const id = (event.target as HTMLElement).dataset?.task;
    if (!id) return;
    setFocusId(id);
    reveal(id);
  };

  return (
    <section
      ref={section}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className="g-graph"
      aria-label={label}
      data-layout-ms={positions && layout && "ms" in layout ? Math.round(layout.ms) : undefined}
      data-draw-ms={drawnMs ?? undefined}
    >
      {layout && "error" in layout && (
        <p className="s-alert" role="alert">
          {t("graph.error", { message: layout.error })}
        </p>
      )}
      <p id={instructionsId} className="k-visually-hidden">
        {t("graph.instructions")}
      </p>
      <p className="k-visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {!layout && (
        <p className="g-graph__status s-muted" role="status">
          {t("graph.layout")}
        </p>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        // Shift is ours (select with dependencies), not React Flow's box selection.
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        minZoom={0.1}
        maxZoom={2}
        ariaLabelConfig={ariaLabels()}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

/**
 * The plan as a dependency graph laid out by ELK. Clicking a node, or Enter on it, opens the task
 * panel; the arrows walk the graph (graph-nav.ts) with one tab stop for the whole graph.
 */
export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
