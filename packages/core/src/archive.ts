/**
 * Archiving old done tasks (CORE-18). Done tasks stay in the plan with all their notes, so the
 * file agents read only grows. `konsora archive` moves those finished before a date to
 * `.konsora/archive.json`, as they were, and leaves their ids in the plan's `archived` list: a
 * dependency on one still counts as done and the id is never reused. Pure; the store writes.
 */
import { completionLog, type LogEntry } from "./history.ts";
import { ARCHIVE_SCHEMA_VERSION, type ArchiveDocument, type TasksDocument } from "./schema.ts";
import { compareTaskIds } from "./serialize.ts";

export const EMPTY_ARCHIVE: ArchiveDocument = { schema: ARCHIVE_SCHEMA_VERSION, tasks: [] };

export type ArchivePlan = {
  /** The plan without the moved tasks and with their ids in `archived`. */
  document: TasksDocument;
  /** The archive with the moved tasks added. */
  archive: ArchiveDocument;
  /** What moves, newest first (as the History lists it). */
  moved: LogEntry[];
};

/**
 * Moves every done task finished strictly before `before` (an ISO UTC timestamp) from the plan
 * to the archive. When nothing qualifies, `moved` is empty and both documents are unchanged.
 */
export function planArchive(
  doc: TasksDocument,
  archive: ArchiveDocument,
  before: string,
): ArchivePlan {
  const moved = completionLog(doc).filter((entry) => entry.at < before);
  if (moved.length === 0) return { document: doc, archive, moved };
  const ids = new Set(moved.map((entry) => entry.id));
  const document: TasksDocument = {
    ...doc,
    archived: [...new Set([...(doc.archived ?? []), ...ids])].sort(compareTaskIds),
    tasks: doc.tasks.filter((task) => !ids.has(task.id)),
  };
  const next: ArchiveDocument = {
    ...archive,
    tasks: [
      ...archive.tasks.filter((task) => !ids.has(task.id)),
      ...doc.tasks.filter((task) => ids.has(task.id)),
    ].sort((a, b) => compareTaskIds(a.id, b.id)),
  };
  return { document, archive: next, moved };
}
