/**
 * The completion log: what got finished and when, newest first. With no approval step (M12),
 * this is how the human sees what the agents closed. Derived from the plan, nothing stored.
 */
import type { TasksDocument } from "./schema.ts";

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
};

/**
 * Done tasks, newest first. Timestamps are UTC with seconds precision, so they sort as strings.
 * Ties go to the higher id first (usually the later one, compared as numbers), so the order is
 * deterministic.
 */
export function completionLog(doc: Pick<TasksDocument, "tasks">): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const task of doc.tasks) {
    if (task.state !== "done") continue;
    const summary = task.notes?.findLast((note) => note.kind === "summary");
    entries.push({
      id: task.id,
      title: task.title,
      group: task.group,
      at: summary?.at ?? task.updated_at,
      ...(summary ? { by: summary.by, summary: summary.text } : {}),
    });
  }
  return entries.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || b.id.localeCompare(a.id, "en", { numeric: true }),
  );
}
