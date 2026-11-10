/**
 * Board moves (UI-02): what dragging a task from one state column to another means. Each move is
 * exactly one semantic op; whether it is allowed is decided by `applyOp` itself (roles,
 * preconditions, blocked deps), so the board never re-implements a rule.
 */
import { indexTasks } from "./graph.ts";
import { applyOp, type OpErrorCode, type OpName } from "./ops.ts";
import type { TaskState, TasksDocument } from "./schema.ts";

/** The op behind each state change; any pair not listed has no single op. */
const EDGES: Partial<Record<TaskState, Partial<Record<TaskState, OpName>>>> = {
  proposed: { todo: "approve" },
  todo: { doing: "start" },
  doing: { todo: "pause", review: "finish" },
  review: { done: "accept", todo: "send-back" },
  done: { todo: "reopen" },
};

/** Text the op requires from the person moving the task. */
export type MoveInput = "feedback" | "summary";
const INPUT: Partial<Record<OpName, MoveInput>> = { "send-back": "feedback", finish: "summary" };

export type MoveDenial =
  /** Dropped where it already is. */
  | "same_state"
  /** No single op goes from this state to that one. */
  | "no_op"
  /** Any other refusal from `applyOp` (forbidden for this role, blocked, …). */
  | OpErrorCode;

export type MovePlan =
  | { ok: true; op: OpName; from: TaskState; to: TaskState; needs?: MoveInput }
  | {
      ok: false;
      reason: MoveDenial;
      from?: TaskState;
      to: TaskState;
      /** The op that would do it (when there is one but this actor may not run it). */
      op?: OpName;
      /** Unfinished dependencies, for `blocked`. */
      blockers?: string[];
      message: string;
    };

/** Plans moving `taskId` to state `to` as `actor` (default `human`, the board's user). */
export function planMove(
  doc: TasksDocument,
  taskId: string,
  to: TaskState,
  actor = "human",
): MovePlan {
  const task = indexTasks(doc).get(taskId);
  if (!task)
    return { ok: false, reason: "not_found", to, message: `Task ${taskId} does not exist` };
  const from = task.state;
  if (from === to)
    return { ok: false, reason: "same_state", from, to, message: `${taskId} is already ${to}` };
  const op = EDGES[from]?.[to];
  if (!op)
    return {
      ok: false,
      reason: "no_op",
      from,
      to,
      message: `No single action moves ${taskId} from ${from} to ${to}`,
    };
  const needs = INPUT[op];
  // Dry run with placeholder text: only the rules decide, never the wording.
  const probe = applyOp(
    doc,
    {
      op,
      task: taskId,
      ...(needs === "feedback" ? { feedback: "…" } : {}),
      ...(needs === "summary" ? { summary: "…" } : {}),
    } as Parameters<typeof applyOp>[1],
    { actor, at: "1970-01-01T00:00:00Z" },
  );
  if (!probe.ok) {
    const pending =
      probe.error.code === "blocked"
        ? (task.deps ?? []).filter((d) => doc.tasks.find((t) => t.id === d)?.state !== "done")
        : undefined;
    return {
      ok: false,
      reason: probe.error.code,
      from,
      to,
      op,
      ...(pending ? { blockers: pending } : {}),
      message: probe.error.message,
    };
  }
  // Inside a YOLO chain `finish` may land in done rather than review; report where it lands.
  const landed = probe.document.tasks.find((t) => t.id === taskId)?.state ?? to;
  if (landed !== to)
    return {
      ok: false,
      reason: "no_op",
      from,
      to,
      op,
      message: `${op} moves ${taskId} to ${landed}`,
    };
  return { ok: true, op, from, to, ...(needs ? { needs } : {}) };
}

/** Actions offered as buttons on a task (UI-03), in display order. */
export const TASK_ACTIONS = [
  "approve",
  "withdraw",
  "answer",
  "accept",
  "send-back",
  "reopen",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** Text each action asks for: required, optional or none. */
export const ACTION_TEXT: Record<TaskAction, "required" | "optional" | "none"> = {
  approve: "none",
  withdraw: "none",
  answer: "required",
  accept: "none",
  "send-back": "required",
  reopen: "optional",
};

/** The actions `actor` may take on a task right now, decided by dry-running each op. */
export function availableActions(
  doc: TasksDocument,
  taskId: string,
  actor = "human",
): TaskAction[] {
  return TASK_ACTIONS.filter((action) => {
    const op = {
      op: action,
      task: taskId,
      ...(action === "answer" ? { text: "…" } : {}),
      ...(action === "send-back" ? { feedback: "…" } : {}),
    } as Parameters<typeof applyOp>[1];
    return applyOp(doc, op, { actor, at: "1970-01-01T00:00:00Z" }).ok;
  });
}
