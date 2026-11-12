import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  type Over,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type MovePlan, planMove, type TaskState } from "@konsora/core";
import { useMemo, useState } from "react";
import {
  type BoardOk,
  type BoardTask,
  toDocument,
  useMoveTask,
  useReorderTask,
} from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { cx } from "../ui/cx.ts";
import {
  Matrix,
  type MatrixCellProps,
  stateLabel,
  TaskCard,
  taskStates,
  useToast,
} from "../ui/index.ts";
import {
  boardLanes,
  dropTargets,
  opErrorText,
  type Reorder,
  refusalText,
  reorderOnto,
} from "./board-model.ts";
import { isSelectable } from "./selection.ts";

/** What a droppable stands for: a cell of a state, or a card of the dragged task's own column. */
type DropData = { state: TaskState; card?: string };
const CARD = "card:";

/**
 * A card under the pointer (or under the dragged card, with the keyboard) wins over its cell:
 * dropping on it reorders. Only cards of the dragged task's column are droppable.
 */
export const cardsFirst: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  const hits = pointer.length > 0 ? pointer : rectIntersection(args);
  const card = hits.find((hit) => String(hit.id).startsWith(CARD));
  return card ? [card] : hits;
};

/**
 * Keyboard dragging jumps from cell to cell in the arrow's direction instead of by pixels, and
 * from card to card within the task's own column, where a drop reorders.
 */
export const cellToCell: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  const step = (
    { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<
      string,
      [number, number]
    >
  )[event.code];
  const from = context.collisionRect;
  if (!step || !from) return undefined;
  event.preventDefault();
  const cx0 = from.left + from.width / 2;
  const cy0 = from.top + from.height / 2;
  const own = (context.active?.data.current as DropData | undefined)?.state;
  let best: { score: number; dx: number; dy: number } | undefined;
  for (const container of context.droppableContainers.getEnabled()) {
    const rect = container.rect.current;
    if (!rect) continue;
    // In its own column the task goes onto the other cards; the cell itself changes nothing.
    const target = container.data.current as DropData | undefined;
    if (own && target?.state === own && !target.card) continue;
    const dx = rect.left + rect.width / 2 - cx0;
    const dy = rect.top + rect.height / 2 - cy0;
    const along = dx * step[0] + dy * step[1];
    if (along <= 1) continue;
    const score = along + 2 * Math.abs(dx * step[1] + dy * step[0]);
    if (!best || score < best.score) best = { score, dx, dy };
  }
  return best
    ? { x: currentCoordinates.x + best.dx, y: currentCoordinates.y + best.dy }
    : currentCoordinates;
};

/** The selection as the board sees it: what is ticked and how to tick or untick a card. */
export type BoardSelection = { selected: ReadonlySet<string>; onToggle: (id: string) => void };

function Card({
  task,
  external = false,
  onOpen,
  selection,
}: {
  task: BoardTask;
  external?: boolean;
  onOpen?: () => void;
  selection?: BoardSelection | undefined;
}) {
  const proposer = task.created.by.replace(/^agent:/, "");
  return (
    <TaskCard
      id={task.id}
      title={task.title}
      state={task.state}
      blockedBy={task.state === "todo" ? task.blockers : []}
      waiting={task.waiting}
      external={external}
      {...(onOpen ? { onOpen } : {})}
      {...(task.state === "proposed" ? { proposedBy: proposer } : {})}
      {...(selection
        ? {
            selected: selection.selected.has(task.id),
            selectable: isSelectable(task),
            onSelectedChange: () => selection.onToggle(task.id),
          }
        : {})}
    />
  );
}

function DraggableCard({
  task,
  external,
  disabled,
  dragged,
  onOpen,
  selection,
}: {
  task: BoardTask;
  external: boolean;
  disabled: boolean;
  /** The card being dragged, if it shares this card's cell: dropping it here reorders. */
  dragged: BoardTask | null;
  onOpen: () => void;
  selection: BoardSelection;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: task.id,
    disabled,
    data: { state: task.state } satisfies DropData,
    attributes: { roleDescription: t("board.draggable") },
  });
  // Done work keeps its own order (by closing date), so nothing is reordered there.
  const takes =
    dragged !== null &&
    dragged.id !== task.id &&
    dragged.state === task.state &&
    task.state !== "done";
  const drop = useDroppable({
    id: `${CARD}${task.id}`,
    data: { state: task.state, card: task.id } satisfies DropData,
    disabled: disabled || !takes,
  });
  const side =
    takes && drop.isOver && dragged
      ? "before" in reorderOnto(dragged, task)
        ? "before"
        : "after"
      : null;
  if (disabled)
    return <Card task={task} external={external} onOpen={onOpen} selection={selection} />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot contain the card's <article>/<h3>.
    <div
      ref={(node) => {
        setNodeRef(node);
        drop.setNodeRef(node);
      }}
      {...attributes}
      // dnd-kit's attributes already set these; restated so the linter sees them.
      role="button"
      tabIndex={0}
      {...listeners}
      // Keys pressed on the card's own open button open it; they do not pick the card up.
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) listeners?.onKeyDown?.(event);
      }}
      aria-label={`${t("board.drag", { id: task.id })}: ${task.title}`}
      className={cx("b-drag", isDragging && "b-drag--source", side && `b-drag--${side}`)}
    >
      <Card task={task} external={external} onOpen={onOpen} selection={selection} />
    </div>
  );
}

function DropCell({
  lane,
  state,
  label,
  className,
  children,
  verdict,
}: MatrixCellProps & { verdict?: "ok" | "no" | undefined }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${lane}:${state}`, data: { state } });
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cx(className, verdict && `b-cell--${verdict}`, isOver && "b-cell--over")}
    >
      {children}
    </section>
  );
}

const DONE_KEYS: Record<string, MessageKey> = {
  promote: "move.done.promote",
  reopen: "move.done.reopen",
  pause: "move.done.pause",
};

/** The board's columns and lanes with validated drag and drop; the toolbar and panel live outside. */
export function Board({
  board,
  swimlanes,
  onOpen,
  selection,
  visible,
  readOnly = false,
}: {
  board: BoardOk;
  swimlanes: boolean;
  onOpen: (id: string) => void;
  selection: BoardSelection;
  /** A filter is on: only these tasks are shown (the rules still see the whole plan). */
  visible?: ReadonlySet<string> | undefined;
  /** The file is invalid: this is the last valid version, shown without drag or actions. */
  readOnly?: boolean;
}) {
  const doc = useMemo(() => toDocument(board), [board]);
  const [active, setActive] = useState<BoardTask | null>(null);
  const move = useMoveTask(board.project.id);
  const reorder = useReorderTask(board.project.id);
  const toast = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: cellToCell }),
  );
  const targets = useMemo(() => (active ? dropTargets(doc, active.id) : null), [doc, active]);
  const lanes = boardLanes(board, swimlanes, visible);
  const byId = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board.tasks]);
  const flagged = useMemo(() => new Set(board.external.map((f) => f.task)), [board.external]);
  const dropOf = (over: Over | null) => over?.data.current as DropData | undefined;
  const stateOf = (over: Over | null) => dropOf(over)?.state;
  /** The reorder a drop on `over` means: only onto another card of the task's own column. */
  const reorderOf = (id: string, over: Over | null): (Reorder & { other: string }) | null => {
    const task = byId.get(id);
    const other = byId.get(dropOf(over)?.card ?? "");
    if (!task || !other || other.id === task.id || other.state !== task.state) return null;
    return { ...reorderOnto(task, other), other: other.id };
  };
  const onRefused = (task: BoardTask) => (error: Error) => {
    if (error instanceof ApiError && error.unauthorized) return;
    const code = error instanceof ApiError ? error.code : "error";
    toast.show(opErrorText(code, task.id, error.message), "error");
  };

  const commit = (task: BoardTask, plan: MovePlan & { ok: true }) =>
    move.mutate(
      { task, op: plan.op, to: plan.to },
      {
        onSuccess: () => {
          toast.show(t(DONE_KEYS[plan.op] ?? "move.done.other", { id: task.id }), "success");
        },
        onError: onRefused(task),
      },
    );

  const onDragStart = ({ active: dragged }: DragStartEvent) =>
    setActive(byId.get(String(dragged.id)) ?? null);
  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setActive(null);
    const task = byId.get(String(dragged.id));
    const to = stateOf(over);
    if (!task || !to) return;
    const place = reorderOf(task.id, over);
    if (place) {
      const { other: _other, ...where } = place;
      reorder.mutate({ task, ...where }, { onError: onRefused(task) });
      return;
    }
    const plan = planMove(doc, task.id, to);
    if (!plan.ok) {
      const text = refusalText(plan, task.id);
      if (text) toast.show(text, "info");
      return;
    }
    commit(task, plan);
  };

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t("board.dnd.start", { id: String(a.id) }),
    onDragOver: ({ active: a, over }) => {
      const to = stateOf(over);
      if (!to) return t("board.dnd.none", { id: String(a.id) });
      const place = reorderOf(String(a.id), over);
      if (place)
        return t("before" in place ? "board.dnd.over.before" : "board.dnd.over.after", {
          id: String(a.id),
          other: place.other,
        });
      const ok = planMove(doc, String(a.id), to).ok;
      return t(ok ? "board.dnd.over.ok" : "board.dnd.over.no", {
        id: String(a.id),
        state: stateLabel(to),
      });
    },
    onDragEnd: ({ active: a, over }) => {
      const to = stateOf(over);
      const place = reorderOf(String(a.id), over);
      if (place)
        return t("before" in place ? "board.dnd.end.before" : "board.dnd.end.after", {
          id: String(a.id),
          other: place.other,
        });
      return to
        ? t("board.dnd.end", { id: String(a.id), state: stateLabel(to) })
        : t("board.dnd.cancel", { id: String(a.id) });
    },
    onDragCancel: ({ active: a }) => t("board.dnd.cancel", { id: String(a.id) }),
  };

  const verdict = (state: TaskState) => {
    const plan = targets?.get(state);
    if (!plan || (!plan.ok && plan.reason === "same_state")) return undefined;
    return plan.ok ? "ok" : "no";
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={cardsFirst}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("board.dnd.instructions") },
      }}
    >
      <div className="a-board">
        <Matrix
          label={t("board.label", { name: board.project.name })}
          columns={taskStates.map((state) => ({
            state,
            count: board.tasks.filter(
              (task) => task.state === state && (!visible || visible.has(task.id)),
            ).length,
          }))}
          lanes={lanes.map((lane) => ({
            id: lane.id,
            name: lane.name,
            cells: lane.cells.map((cell) =>
              cell.map((task) => (
                <DraggableCard
                  key={task.id}
                  task={task}
                  external={flagged.has(task.id)}
                  disabled={readOnly}
                  dragged={!swimlanes || active?.group === task.group ? active : null}
                  onOpen={() => onOpen(task.id)}
                  selection={selection}
                />
              )),
            ),
          }))}
          renderCell={(props) => <DropCell {...props} verdict={verdict(props.state)} />}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? <Card task={active} external={flagged.has(active.id)} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
