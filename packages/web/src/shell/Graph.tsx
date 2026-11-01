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
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import type { BoardTask } from "../api/board.ts";
import { t } from "../i18n/index.ts";
import { cx } from "../ui/cx.ts";
import { StateBadge, stateLabel } from "../ui/index.ts";
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
  onOpen: (id: string) => void;
};
type TaskNode = Node<TaskNodeData, "task">;

/** A task in the graph: id, state and flags on top, title below, painted from its state tokens. */
const TaskNodeView = memo(function TaskNodeView({ data }: NodeProps<TaskNode>) {
  const { task, external, open, onOpen } = data;
  const tone = nodeTone(task);
  return (
    <div
      className={cx("g-node", open && "g-node--open")}
      style={{ ...nodeStyle(tone), width: NODE_W, height: NODE_H } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="g-node__open"
        onClick={() => onOpen(task.id)}
        aria-label={`${t("card.open", { id: task.id })}: ${task.title}`}
      >
        <span className="g-node__head">
          <span className="g-node__id">{task.id}</span>
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
};

function GraphCanvas({ label, tasks, external, openId, onOpen }: GraphProps) {
  const layout = useGraphLayout(tasks);
  const flow = useReactFlow();
  const fitted = useRef(false);
  const mounted = useRef(performance.now());
  const [drawnMs, setDrawnMs] = useState<number | null>(null);

  const positions = layout && "positions" in layout ? layout.positions : null;
  const nodes = useMemo<TaskNode[]>(() => {
    if (!positions) return [];
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
          data: { task, external: external.has(task.id), open: openId === task.id, onOpen },
        },
      ];
    });
  }, [tasks, positions, external, openId, onOpen]);
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

  return (
    <section
      ref={section}
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
        onlyRenderVisibleElements
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

/** The plan as a dependency graph laid out by ELK; clicking a node opens the task panel. */
export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
