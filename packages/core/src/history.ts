/**
 * The completion log: what got finished and when, newest first. With no approval step (M12),
 * this is how the human sees what the agents closed. Derived from the plan, nothing stored.
 */
import type { Block, MergeStrategy, TasksDocument } from "./schema.ts";

export type TaskLogEntry = {
  kind: "task";
  id: string;
  title: string;
  group: string;
  block?: string;
  /** When it was finished: its last `summary` note, else its `updated_at`. */
  at: string;
  /** Who wrote that summary; absent when the task has none. */
  by?: string;
  /** The closing summary; absent when the task has none. */
  summary?: string;
};

export type BlockLogEntry = {
  kind: "block";
  id: string;
  name: string;
  branch: string;
  base: string;
  at: string;
  by: string;
  commit: string;
  strategy: MergeStrategy;
};

export type LogEntry = TaskLogEntry | BlockLogEntry;

/**
 * Done tasks and merged blocks, newest first. Timestamps are UTC with seconds precision, so they
 * sort as strings. Ties put a block before tasks (a merge comes after its tasks are finished),
 * then go by id, so the order is deterministic.
 */
export function completionLog(doc: Pick<TasksDocument, "tasks" | "blocks">): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const task of doc.tasks) {
    if (task.state !== "done") continue;
    const summary = task.notes?.findLast((note) => note.kind === "summary");
    entries.push({
      kind: "task",
      id: task.id,
      title: task.title,
      group: task.group,
      ...(task.block ? { block: task.block } : {}),
      at: summary?.at ?? task.updated_at,
      ...(summary ? { by: summary.by, summary: summary.text } : {}),
    });
  }
  for (const block of doc.blocks ?? []) {
    if (block.merged) entries.push(blockEntry(block, block.merged));
  }
  return entries.sort(
    (a, b) =>
      compare(b.at, a.at) ||
      compare(a.kind === "block" ? 0 : 1, b.kind === "block" ? 0 : 1) ||
      compare(a.id, b.id),
  );
}

function blockEntry(block: Block, merged: NonNullable<Block["merged"]>): BlockLogEntry {
  return {
    kind: "block",
    id: block.id,
    name: block.name,
    branch: block.branch,
    base: block.base,
    at: merged.at,
    by: merged.by,
    commit: merged.commit,
    strategy: merged.strategy,
  };
}

function compare<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
