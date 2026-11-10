import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  type Over,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  groupCost,
  type MovePlan,
  planMove,
  type Run,
  type TaskState,
  usageTotals,
} from "@konsora/core";
import { useMemo, useState } from "react";
import { type BoardOk, type BoardTask, toDocument, useMoveTask } from "../api/board.ts";
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
import { difficultyText } from "./agent-model.ts";
import { ALL_LANE, boardLanes, dropTargets, opErrorText, refusalText } from "./board-model.ts";
import { costLine } from "./cost-model.ts";
import { FeedbackDialog } from "./FeedbackDialog.tsx";
import { isSelectable } from "./selection.ts";

/** Keyboard dragging jumps from cell to cell in the arrow's direction instead of by pixels. */
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
  let best: { score: number; dx: number; dy: number } | undefined;
  for (const container of context.droppableContainers.getEnabled()) {
    const rect = container.rect.current;
    if (!rect) continue;
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

const agentLabel = (task: BoardTask) =>
  task.agent
    ? [task.agent.provider, task.agent.model, task.agent.effort].filter(Boolean).join(" · ")
    : undefined;

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
  const agent = agentLabel(task);
  const proposer = task.created.by.replace(/^agent:/, "");
  return (
    <TaskCard
      id={task.id}
      title={task.title}
      state={task.state}
      blockedBy={task.state === "todo" ? task.blockers : []}
      waiting={task.waiting}
      external={external}
      checksFailed={task.checks_failed === true}
      awaitingApproval={task.awaiting_approval === true}
      {...(onOpen ? { onOpen } : {})}
      {...(agent ? { agent } : {})}
      {...(task.difficulty ? { difficulty: difficultyText(task.difficulty) } : {})}
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
  onOpen,
  selection,
}: {
  task: BoardTask;
  external: boolean;
  disabled: boolean;
  onOpen: () => void;
  selection: BoardSelection;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: task.id,
    disabled,
    attributes: { roleDescription: t("board.draggable") },
  });
  if (disabled)
    return <Card task={task} external={external} onOpen={onOpen} selection={selection} />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot contain the card's <article>/<h3>.
    <div
      ref={setNodeRef}
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
      className={cx("b-drag", isDragging && "b-drag--source")}
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
  approve: "move.done.approve",
  accept: "move.done.accept",
  "send-back": "move.done.send-back",
  reopen: "move.done.reopen",
  pause: "move.done.pause",
};

/** The board's columns and lanes with validated drag and drop; the toolbar and panel live outside. */
export function Board({
  board,
  swimlanes,
  onOpen,
  selection,
  readOnly = false,
  runs,
}: {
  board: BoardOk;
  swimlanes: boolean;
  onOpen: (id: string) => void;
  selection: BoardSelection;
  /** The project's runs, for each lane's accumulated cost (UI-23); live from `run.state`. */
  runs?: readonly Run[] | undefined;
  /** The file is invalid: this is the last valid version, shown without drag or actions. */
  readOnly?: boolean;
}) {
  const doc = useMemo(() => toDocument(board), [board]);
  const [active, setActive] = useState<BoardTask | null>(null);
  const [sendBack, setSendBack] = useState<{
    task: BoardTask;
    plan: MovePlan & { ok: true };
  } | null>(null);
  const move = useMoveTask(board.project.id);
  const toast = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: cellToCell }),
  );
  const targets = useMemo(() => (active ? dropTargets(doc, active.id) : null), [doc, active]);
  const lanes = boardLanes(board, swimlanes);
  const byId = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board.tasks]);
  const flagged = useMemo(() => new Set(board.external.map((f) => f.task)), [board.external]);
  const stateOf = (over: Over | null) => over?.data.current?.state as TaskState | undefined;

  const commit = (task: BoardTask, plan: MovePlan & { ok: true }, feedback?: string) =>
    move.mutate(
      { task, op: plan.op, to: plan.to, ...(feedback ? { feedback } : {}) },
      {
        onSuccess: () => {
          setSendBack(null);
          toast.show(t(DONE_KEYS[plan.op] ?? "move.done.other", { id: task.id }), "success");
        },
        onError: (error) => {
          setSendBack(null);
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          toast.show(opErrorText(code, task.id, error.message), "error");
        },
      },
    );

  const onDragStart = ({ active: dragged }: DragStartEvent) =>
    setActive(byId.get(String(dragged.id)) ?? null);
  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setActive(null);
    const task = byId.get(String(dragged.id));
    const to = stateOf(over);
    if (!task || !to) return;
    const plan = planMove(doc, task.id, to);
    if (!plan.ok) {
      const text = refusalText(plan, task.id);
      if (text) toast.show(text, "info");
      return;
    }
    if (plan.needs === "feedback") setSendBack({ task, plan });
    else commit(task, plan);
  };

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t("board.dnd.start", { id: String(a.id) }),
    onDragOver: ({ active: a, over }) => {
      const to = stateOf(over);
      if (!to) return t("board.dnd.none", { id: String(a.id) });
      const ok = planMove(doc, String(a.id), to).ok;
      return t(ok ? "board.dnd.over.ok" : "board.dnd.over.no", {
        id: String(a.id),
        state: stateLabel(to),
      });
    },
    onDragEnd: ({ active: a, over }) => {
      const to = stateOf(over);
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
    <>
      <DndContext
        sensors={sensors}
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
              count: board.tasks.filter((task) => task.state === state).length,
            }))}
            lanes={lanes.map((lane) => ({
              id: lane.id,
              name: lane.name,
              meta: runs
                ? costLine(lane.id === ALL_LANE ? usageTotals(runs) : groupCost(runs, doc, lane.id))
                : undefined,
              cells: lane.cells.map((cell) =>
                cell.map((task) => (
                  <DraggableCard
                    key={task.id}
                    task={task}
                    external={flagged.has(task.id)}
                    disabled={readOnly}
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
      {sendBack && (
        <FeedbackDialog
          id={sendBack.task.id}
          busy={move.isPending}
          onCancel={() => setSendBack(null)}
          onSubmit={(feedback) => commit(sendBack.task, sendBack.plan, feedback)}
        />
      )}
    </>
  );
}
