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
import { Button, DifficultyMark, StateBadge, stateLabel } from "../ui/index.ts";
import {
  chainOf,
  edgeId,
  elkInput,
  type GroupBox,
  graphEdges,
  groupBoxesOf,
  initialViewport,
  type LayoutTask,
  type Link,
  layoutKey,
  linkFromDrag,
  NODE_H,
  NODE_W,
  nextDependencyEdge,
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

type Layout =
  | { key: string; positions: Positions; boxes: GroupBox[]; ms: number }
  | { key: string; error: string };

/**
 * Lays the DAG out with ELK in its own web worker (so a large plan never freezes the page), and
 * again only when tasks or dependencies change. Until a newer layout arrives the last one stays.
 */
function useGraphLayout(tasks: readonly LayoutTask[], grouped: boolean): Layout | null {
  const key = layoutKey(tasks, grouped);
  const [layout, setLayout] = useState<Layout | null>(null);
  const elk = useRef<ELK | null>(null);
  const latest = useRef(0);
  const input = useRef({ tasks, grouped });
  input.current = { tasks, grouped };
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
    instance.layout(elkInput(input.current.tasks, input.current.grouped)).then(
      (result) => {
        if (id === latest.current)
          setLayout({
            key,
            positions: positionsOf(result),
            boxes: groupBoxesOf(result),
            ms: performance.now() - started,
          });
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
  /** Outside the open task's chain (UI-24): drawn faded. */
  dimmed: boolean;
  /** Its handles start or end a new dependency (UI-23). */
  connectable: boolean;
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
    dimmed,
    connectable,
    onOpen,
    onToggle,
    onSelectWithDeps,
  } = data;
  const tone = nodeTone(task);
  return (
    <div
      className={cx(
        "g-node",
        open && "g-node--open",
        selected && "g-node--selected",
        dimmed && "g-node--dim",
      )}
      style={{ ...nodeStyle(tone), width: NODE_W, height: NODE_H } as CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={connectable}
        className={cx(connectable && "g-handle")}
        aria-label={connectable ? t("graph.link.handle.in", { id: task.id }) : undefined}
      />
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
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={connectable}
        className={cx(connectable && "g-handle")}
        aria-label={connectable ? t("graph.link.handle.out", { id: task.id }) : undefined}
      />
    </div>
  );
});

type GroupNodeData = { label: string };
type GroupNode = Node<GroupNodeData, "group-box">;

/** A group's frame behind its tasks when the graph is grouped (UI-24); never interactive. */
const GroupNodeView = memo(function GroupNodeView({ data }: NodeProps<GroupNode>) {
  return (
    <div className="g-group">
      <span className="g-group__name">{data.label}</span>
    </div>
  );
});

const nodeTypes = { task: TaskNodeView, "group-box": GroupNodeView };

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
  /** Lay the tasks out inside a frame per group (UI-24). */
  grouped: boolean;
  groups: readonly { id: string; name: string }[];
  external: ReadonlySet<string>;
  openId: string | null;
  onOpen: (id: string) => void;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectWithDeps: (id: string) => void;
  /** Adds a dependency dragged between two nodes (UI-23); absent in read-only. */
  onLink?: ((link: Link) => void) | undefined;
  /** Removes a dependency (UI-23); absent in read-only. */
  onUnlink?: ((link: Link) => void) | undefined;
};

function GraphCanvas({
  label,
  tasks,
  grouped,
  groups,
  external,
  openId,
  onOpen,
  selected,
  onToggle,
  onSelectWithDeps,
  onLink,
  onUnlink,
}: GraphProps) {
  const layout = useGraphLayout(tasks, grouped);
  const editable = Boolean(onLink && onUnlink);
  const stateOf = useMemo(() => new Map(tasks.map((task) => [task.id, task.state])), [tasks]);
  /** A done task's links are not edited from here: reopening it is a human action of its own. */
  const removable = useCallback(
    (link: Link) => editable && stateOf.has(link.task) && stateOf.get(link.task) !== "done",
    [editable, stateOf],
  );
  const [pickedEdge, setPickedEdge] = useState<Link | null>(null);
  const linked = (link: Link) =>
    tasks.some((task) => task.id === link.task && (task.deps ?? []).includes(link.on));
  // A selected edge that vanished (removed here or elsewhere) is no longer selected.
  const selectedEdge =
    pickedEdge && removable(pickedEdge) && linked(pickedEdge) ? pickedEdge : null;
  const flow = useReactFlow();
  const fitted = useRef(false);
  const mounted = useRef(performance.now());
  const [drawnMs, setDrawnMs] = useState<number | null>(null);

  const positions = layout && "positions" in layout ? layout.positions : null;
  const boxes = layout && "boxes" in layout ? layout.boxes : null;
  const chain = useMemo(() => chainOf(tasks, openId), [tasks, openId]);
  const nav = useMemo(() => (positions ? navGraph(tasks, positions) : null), [tasks, positions]);
  const instructionsId = useId();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const tabStop = nav
    ? focusId && nav.depth.has(focusId)
      ? focusId
      : entryNode(nav, openId)
    : null;
  const nodes = useMemo<(TaskNode | GroupNode)[]>(() => {
    if (!positions || !nav) return [];
    const frames: GroupNode[] = (boxes ?? []).map((box) => ({
      id: `group:${box.group}`,
      type: "group-box" as const,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      zIndex: -1,
      data: {
        label: `${box.group} · ${groups.find((g) => g.id === box.group)?.name ?? box.group}`,
      },
    }));
    const taskNodes = tasks.flatMap((task) => {
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
            dimmed: chain !== null && !chain.nodes.has(task.id),
            connectable: editable && task.state !== "done",
            onOpen,
            onToggle,
            onSelectWithDeps,
          },
        },
      ];
    });
    return [...frames, ...taskNodes];
  }, [
    tasks,
    positions,
    boxes,
    groups,
    chain,
    editable,
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
      const inChain = chain?.edges.has(edge.id);
      const link = { task: edge.to, on: edge.from };
      const picked = selectedEdge !== null && edgeId(selectedEdge) === edge.id;
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        className: cx(
          "g-edge",
          done && "g-edge--done",
          inChain && "g-edge--chain",
          chain && !inChain && "g-edge--dim",
          removable(link) && "g-edge--editable",
          picked && "g-edge--selected",
        ),
        data: link,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        focusable: false,
      };
    });
  }, [tasks, chain, removable, selectedEdge]);

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
  const say = (text: string) =>
    // A trailing no-break space makes a repeated message count as new, so it is said again.
    setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
  const unlink = (link: Link) => {
    setPickedEdge(null);
    onUnlink?.(link);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = (event.target as HTMLElement).dataset?.task;
    if (selectedEdge && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      unlink(selectedEdge);
      return;
    }
    if (selectedEdge && event.key === "Escape") {
      // Clears the edge only; the panel stays open.
      event.preventDefault();
      event.stopPropagation();
      setPickedEdge(null);
      say(t("graph.link.cleared"));
      return;
    }
    if (from && editable && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      const deps = (nav?.deps.get(from) ?? []).filter((on) => removable({ task: from, on }));
      const next = nextDependencyEdge(from, deps, selectedEdge);
      setPickedEdge(next);
      say(
        next
          ? t("graph.link.selected", { id: next.task, on: next.on })
          : t("graph.link.none", { id: from }),
      );
      return;
    }
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
    } else say(t(`graph.nav.${key}`, { id: from }));
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
        {editable && ` ${t("graph.instructions.edit")}`}
      </p>
      {selectedEdge && (
        // biome-ignore lint/a11y/useSemanticElements: a toolbar for the selected edge, not a form.
        <div className="g-edgebar" role="group" aria-label={t("graph.link.bar")}>
          <span className="g-edgebar__text">
            {t("graph.link.text", { id: selectedEdge.task, on: selectedEdge.on })}
          </span>
          <Button size="sm" variant="danger" onClick={() => unlink(selectedEdge)}>
            {t("graph.link.remove")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPickedEdge(null)}>
            {t("graph.link.cancel")}
          </Button>
        </div>
      )}
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
        nodesConnectable={editable}
        onConnectEnd={(event, connection) => {
          const from = connection.fromNode?.id;
          const handle = connection.fromHandle?.type;
          if (!from || !handle || !onLink) return;
          // Dropped anywhere on a node, not only on its handle.
          const point = "changedTouches" in event ? event.changedTouches[0] : event;
          const under = point
            ? document
                .elementFromPoint(point.clientX, point.clientY)
                ?.closest(".react-flow__node")
                ?.getAttribute("data-id")
            : null;
          const link = linkFromDrag(from, handle, connection.toNode?.id ?? under);
          if (link) onLink(link);
        }}
        onEdgeClick={(_event, edge) => {
          const link = { task: edge.target, on: edge.source };
          if (removable(link)) setPickedEdge(link);
        }}
        onPaneClick={() => setPickedEdge(null)}
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
