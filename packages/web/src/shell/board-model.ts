/** Board view model: lanes, drop targets and the Spanish reason for each refused move. */
import {
  compareByRank,
  completionLog,
  type MovePlan,
  planMove,
  type TaskState,
  type TasksDocument,
} from "@konsora/core";
import type { BoardOk, BoardTask, ExternalFlag } from "../api/board.ts";
import { t } from "../i18n/index.ts";
import { type ConfirmAsk, stateLabel, taskStates } from "../ui/index.ts";

export const ALL_LANE = "*";

export type Lane = {
  id: string;
  name: string;
  cells: BoardTask[][];
  /** Done tasks of this lane left out of the board (closed too long ago); the History has them. */
  hiddenDone: number;
};

/**
 * One lane per group that has tasks (in plan order), or a single lane with everything. Each cell
 * is in priority order (`rank`), the order dragging a card up or down changes. With `visible` (a
 * filter), only those tasks are laid out; `hiddenDone` (see `oldDone`) leave the Done column.
 */
export function boardLanes(
  board: BoardOk,
  swimlanes: boolean,
  visible?: ReadonlySet<string>,
  hiddenDone: ReadonlySet<string> = new Set(),
): Lane[] {
  const all = (
    visible ? board.tasks.filter((task) => visible.has(task.id)) : [...board.tasks]
  ).sort(compareByRank);
  const lane = (id: string, name: string, tasks: BoardTask[]): Lane => {
    const shown = tasks.filter((task) => !hiddenDone.has(task.id));
    return {
      id,
      name,
      cells: taskStates.map((state) => shown.filter((task) => task.state === state)),
      hiddenDone: tasks.length - shown.length,
    };
  };
  if (!swimlanes) return [lane(ALL_LANE, t("board.lane.all"), all)];
  return board.plan.groups
    .map((group) =>
      lane(
        group.id,
        group.name,
        all.filter((task) => task.group === group.id),
      ),
    )
    .filter((l) => l.hiddenDone > 0 || l.cells.some((cell) => cell.length > 0));
}

/** How many days of done work the board keeps in sight (UI-19); 0 keeps all of it. */
export const DONE_WINDOWS = [7, 14, 30, 0] as const;
export type DoneWindow = (typeof DONE_WINDOWS)[number];
export const DEFAULT_DONE_WINDOW: DoneWindow = 14;

/** Done tasks closed more than `days` days before `now`: they leave the board for the History. */
export function oldDone(doc: Pick<TasksDocument, "tasks">, days: number, now: Date): Set<string> {
  if (days <= 0) return new Set();
  const cutoff = new Date(now.getTime() - days * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  return new Set(
    completionLog(doc)
      .filter((entry) => entry.at < cutoff)
      .map((entry) => entry.id),
  );
}

/** Where a card dropped on another one of its column goes: past it, in the direction it came from. */
export type Reorder = { before: string } | { after: string };

export function reorderOnto(
  task: Pick<BoardTask, "id" | "rank">,
  target: Pick<BoardTask, "id" | "rank">,
): Reorder {
  return compareByRank(task, target) < 0 ? { after: target.id } : { before: target.id };
}

/** Where a task may be dropped, decided by core for every column. */
export function dropTargets(doc: TasksDocument, taskId: string): Map<TaskState, MovePlan> {
  return new Map(taskStates.map((state) => [state, planMove(doc, taskId, state)]));
}

/** Why a move is refused, in Spanish; null when there is nothing to explain (same column). */
export function refusalText(plan: MovePlan, id: string): string | null {
  if (plan.ok || plan.reason === "same_state") return null;
  const from = plan.from ? stateLabel(plan.from) : "";
  const to = stateLabel(plan.to);
  switch (plan.reason) {
    case "no_op":
      return plan.from === "proposed"
        ? t("move.no_op.proposed", { id })
        : t("move.no_op", { id, from, to });
    case "forbidden":
      if (plan.op === "start") return t("move.agent_only.start", { id });
      if (plan.op === "finish") return t("move.agent_only.finish", { id });
      return t("move.forbidden", { id, from, to });
    case "blocked":
      return t("move.blocked", { id, ids: (plan.blockers ?? []).join(", ") });
    case "not_found":
      return t("move.not_found", { id });
    default:
      return t("move.refused", { id, message: plan.message });
  }
}

/** Asks before deleting one or more tasks, naming the tasks that will lose them as a dependency. */
export function confirmDelete(
  ids: readonly string[],
  dependents: readonly string[],
  ask: ConfirmAsk,
): Promise<boolean> {
  const many = ids.length > 1;
  const key =
    dependents.length > 0
      ? many
        ? "delete.confirm.many.dependents"
        : "delete.confirm.dependents"
      : many
        ? "delete.confirm.many"
        : "delete.confirm";
  return ask(t(key, { ids: ids.join(", "), deps: dependents.join(", ") }), {
    yes: t("action.delete"),
    danger: true,
  });
}

/** Asks before reverting an external change: the task goes back to its previous version. */
export function confirmRevert(id: string, ask: ConfirmAsk): Promise<boolean> {
  return ask(t("external.revert.confirm", { id }), { yes: t("external.revert"), danger: true });
}

/** Spanish text for an op the daemon refused after the drop (e.g. the file changed meanwhile). */
export function opErrorText(code: string, id: string, message: string): string {
  if (code === "conflict") return t("move.conflict", { id });
  if (code.startsWith("plan_")) return t("move.plan_unavailable");
  return t("move.refused", { id, message });
}

/** Spanish description of an unapproved external change (the daemon's message is English). */
export function externalText(flag: ExternalFlag): string {
  const state = (value: string | undefined) =>
    value && (taskStates as readonly string[]).includes(value)
      ? stateLabel(value as TaskState)
      : (value ?? "");
  switch (flag.kind) {
    case "transition":
      return t("external.transition", { from: state(flag.from), to: state(flag.to) });
    case "created_approved":
      return t("external.created_approved", { to: state(flag.to) });
    case "edited":
      return t("external.edited");
    case "deleted":
      return t("external.deleted", { from: state(flag.from) });
    case "notes_rewritten":
      return t("external.notes_rewritten");
    default:
      return flag.message;
  }
}

/** The answer sent when the human picks an option: the option, then their comment if any. */
export function choiceAnswer(option: string, comment: string): string {
  const extra = comment.trim();
  return extra ? `${option}\n\n${extra}` : option;
}

const COLLAPSED_KEY = "konsora.board.collapsed";
const DONE_WINDOW_KEY = "konsora.board.doneDays";

/** The folded columns (UI-19), remembered in this browser; unknown values are ignored. */
export function readCollapsed(): Set<TaskState> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(
      Array.isArray(raw)
        ? raw.filter((s): s is TaskState => (taskStates as readonly unknown[]).includes(s))
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsed(states: ReadonlySet<TaskState>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...states]));
  } catch {
    // Not persisted; folding still works for this page.
  }
}

/** The Done window (UI-19), remembered in this browser. */
export function readDoneWindow(): DoneWindow {
  try {
    const raw = window.localStorage.getItem(DONE_WINDOW_KEY);
    const value = Number(raw);
    return raw !== null && (DONE_WINDOWS as readonly number[]).includes(value)
      ? (value as DoneWindow)
      : DEFAULT_DONE_WINDOW;
  } catch {
    return DEFAULT_DONE_WINDOW;
  }
}

export function writeDoneWindow(days: DoneWindow) {
  try {
    window.localStorage.setItem(DONE_WINDOW_KEY, String(days));
  } catch {
    // Not persisted; the choice still works for this page.
  }
}

/** Cards a board cell shows before «Ver N más» (UI-32). */
export const CELL_LIMIT = 8;

/** The key of a board cell: its lane and its state, e.g. `BE:todo`. */
export const cellKey = (lane: string, state: TaskState) => `${lane}:${state}`;

/**
 * What a cell shows (UI-32): its first `limit` cards in rank order, unless it is expanded or one of
 * `reveal` (the open or selected tasks) is among the rest, which unfolds it by itself.
 */
export function cellView<T extends { id: string }>(
  cards: readonly T[],
  expanded: boolean,
  reveal: ReadonlySet<string> = new Set(),
  limit = CELL_LIMIT,
): { shown: readonly T[]; hidden: number; canCollapse: boolean } {
  if (cards.length <= limit) return { shown: cards, hidden: 0, canCollapse: false };
  const forced = cards.slice(limit).some((card) => reveal.has(card.id));
  if (expanded || forced) return { shown: cards, hidden: 0, canCollapse: !forced };
  return { shown: cards.slice(0, limit), hidden: cards.length - limit, canCollapse: false };
}

/** A per-project set of strings remembered in this browser (expanded cells, folded lanes). */
export function readBoardSet(name: "expanded" | "lanes", project: string): Set<string> {
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(`konsora.board.${name}.${project}`) ?? "[]",
    ) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeBoardSet(
  name: "expanded" | "lanes",
  project: string,
  values: ReadonlySet<string>,
) {
  try {
    window.localStorage.setItem(`konsora.board.${name}.${project}`, JSON.stringify([...values]));
  } catch {
    // Not persisted; it still works for this page.
  }
}
