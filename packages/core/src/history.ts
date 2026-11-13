/**
 * The completion log: what got finished and when, newest first. With no approval step (M12),
 * this is how the human sees what the agents closed. Derived from the plan, nothing stored.
 */
import { deriveFlags } from "./graph.ts";
import type { EditedField, EventType, Task, TaskState, TasksDocument } from "./schema.ts";

export type LogEntry = {
  id: string;
  title: string;
  group: string;
  /** When it was finished: its last `summary` note, else its `updated_at`. */
  at: string;
  /** Who wrote that summary; absent when the task has none. */
  by?: string;
  /** The closing summary; absent when the task has none. */
  summary?: string;
  /** Moved to `.konsora/archive.json` (`konsora archive`). */
  archived?: true;
};

/**
 * Done tasks, newest first, including the `archived` ones when given (the tasks of
 * `.konsora/archive.json`). Timestamps are UTC with seconds precision, so they sort as strings.
 * Ties go to the higher id first (usually the later one, compared as numbers), so the order is
 * deterministic.
 */
export function completionLog(
  doc: Pick<TasksDocument, "tasks">,
  archived: readonly Task[] = [],
): LogEntry[] {
  const entries: LogEntry[] = [];
  const add = (task: Task, isArchived: boolean) => {
    if (task.state !== "done") return;
    const summary = task.notes?.findLast((note) => note.kind === "summary");
    entries.push({
      id: task.id,
      title: task.title,
      group: task.group,
      at: summary?.at ?? task.updated_at,
      ...(summary ? { by: summary.by, summary: summary.text } : {}),
      ...(isArchived ? { archived: true as const } : {}),
    });
  };
  const live = new Set(doc.tasks.map((task) => task.id));
  for (const task of doc.tasks) add(task, false);
  // A task both in the plan and the archive (an interrupted archive) is shown once, from the plan.
  for (const task of archived) if (!live.has(task.id)) add(task, true);
  return entries.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || b.id.localeCompare(a.id, "en", { numeric: true }),
  );
}

/** A plan at a glance (UI-14): what is moving and where the human is needed. */
export type PlanSummary = {
  tasks: number;
  byState: Record<TaskState, number>;
  /** `todo` tasks with every dependency done. */
  ready: number;
  /** Tasks whose last question has no answer yet. */
  waiting: number;
  /** When the latest task was finished (archived ones included when given); absent if none. */
  lastDone?: string;
};

export function planSummary(doc: TasksDocument, archived: readonly Task[] = []): PlanSummary {
  const byState: Record<TaskState, number> = { proposed: 0, todo: 0, doing: 0, done: 0 };
  let ready = 0;
  let waiting = 0;
  const flags = deriveFlags(doc);
  for (const task of doc.tasks) {
    byState[task.state]++;
    const flag = flags.get(task.id);
    if (flag?.ready) ready++;
    if (flag?.waiting) waiting++;
  }
  const last = completionLog(doc, archived)[0];
  return {
    tasks: doc.tasks.length,
    byState,
    ready,
    waiting,
    ...(last ? { lastDone: last.at } : {}),
  };
}

/** What happened to a task in the plan's activity (CORE-17). */
export type ActivityType = "create" | EventType | "delete";

export type ActivityEntry = {
  task: string;
  title: string;
  type: ActivityType;
  at: string;
  by: string;
  /** Only on an `edit`: what it changed. */
  fields?: EditedField[];
  /** The task is no longer in the plan (a `delete`); its id and title are all that is left. */
  deleted?: true;
  /** Moved to `.konsora/archive.json`. */
  archived?: true;
};

const byIdDesc = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true });

/**
 * The plan's activity, newest first: each task's creation (from `created`), its stored events
 * and the deletions. Tasks closed before events were recorded get their closures from their
 * `summary` notes. Includes the `archived` tasks when given. Ties go to the higher id first and,
 * within a task, to the later event, so the order is deterministic.
 */
export function planActivity(
  doc: Pick<TasksDocument, "tasks" | "deleted">,
  archived: readonly Task[] = [],
): ActivityEntry[] {
  const entries: (ActivityEntry & { seq: number })[] = [];
  const add = (task: Task, isArchived: boolean) => {
    const base = {
      task: task.id,
      title: task.title,
      ...(isArchived ? { archived: true as const } : {}),
    };
    let seq = 0;
    const push = (entry: Omit<ActivityEntry, "task" | "title">) =>
      entries.push({ ...base, ...entry, seq: seq++ });
    push({ type: "create", at: task.created.at, by: task.created.by });
    const events = task.events ?? [];
    const since = events[0]?.at;
    for (const note of task.notes ?? [])
      if (note.kind === "summary" && (since === undefined || note.at < since))
        push({ type: "finish", at: note.at, by: note.by });
    for (const event of events)
      push({
        type: event.type,
        at: event.at,
        by: event.by,
        ...(event.fields ? { fields: event.fields } : {}),
      });
  };
  const live = new Set(doc.tasks.map((task) => task.id));
  for (const task of doc.tasks) add(task, false);
  for (const task of archived) if (!live.has(task.id)) add(task, true);
  for (const gone of doc.deleted ?? [])
    entries.push({
      task: gone.id,
      title: gone.title,
      type: "delete",
      at: gone.at,
      by: gone.by,
      deleted: true,
      seq: Number.MAX_SAFE_INTEGER,
    });
  return entries
    .sort(
      (a, b) =>
        (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || byIdDesc(a.task, b.task) || b.seq - a.seq,
    )
    .map(({ seq: _, ...entry }) => entry);
}
