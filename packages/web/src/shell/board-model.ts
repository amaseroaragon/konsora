/** Board view model: lanes, drop targets and the Spanish reason for each refused move. */
import {
  compareByRank,
  type MovePlan,
  planMove,
  type TaskState,
  type TasksDocument,
} from "@konsora/core";
import type { BoardOk, BoardTask, ExternalFlag } from "../api/board.ts";
import { t } from "../i18n/index.ts";
import { type ConfirmAsk, stateLabel, taskStates } from "../ui/index.ts";

export const ALL_LANE = "*";

export type Lane = { id: string; name: string; cells: BoardTask[][] };

/**
 * One lane per group that has tasks (in plan order), or a single lane with everything. Each cell
 * is in priority order (`rank`), the order dragging a card up or down changes. With `visible` (a
 * filter), only those tasks are laid out.
 */
export function boardLanes(
  board: BoardOk,
  swimlanes: boolean,
  visible?: ReadonlySet<string>,
): Lane[] {
  const shown = (
    visible ? board.tasks.filter((task) => visible.has(task.id)) : [...board.tasks]
  ).sort(compareByRank);
  const cells = (tasks: BoardTask[]) =>
    taskStates.map((state) => tasks.filter((task) => task.state === state));
  if (!swimlanes) return [{ id: ALL_LANE, name: t("board.lane.all"), cells: cells(shown) }];
  return board.plan.groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      cells: cells(shown.filter((task) => task.group === group.id)),
    }))
    .filter((lane) => lane.cells.some((cell) => cell.length > 0));
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
