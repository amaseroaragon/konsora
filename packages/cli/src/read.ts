/**
 * Read operations shared by the CLI (`--json`) and the MCP server: each returns the exact value
 * the CLI prints with `--json`, so both surfaces stay identical by construction.
 */
import { milestoneProgress, type TaskState, type TasksDocument } from "@konsora/core";
import { ARCHIVE_FILE, readArchive, readTasks, type StoreError } from "@konsora/core/store";
import { issuesText, readyViews, STATES, type TaskView, views } from "./format.ts";
import { HINTS } from "./hints.ts";
import { CliError, EXIT } from "./shared.ts";

export function statusData(doc: TasksDocument) {
  const list = views(doc);
  const byState = Object.fromEntries(
    STATES.map((s) => [s, list.filter((t) => t.state === s).length]),
  );
  return {
    project: doc.project,
    groups: doc.groups,
    tasks: list.length,
    byState,
    ready: readyViews(list).map((t) => t.id),
    blocked: list.filter((t) => t.blocked).map((t) => t.id),
    waiting: list.filter((t) => t.waiting).map((t) => t.id),
    proposed: list.filter((t) => t.state === "proposed").map((t) => t.id),
    // CORE-19: each milestone with its done and total tasks; absent when the plan has none.
    ...(doc.milestones?.length ? { milestones: milestoneProgress(doc) } : {}),
  };
}

export type ListFilter = {
  state?: TaskState | undefined;
  group?: string | undefined;
  ready?: boolean | undefined;
  blocked?: boolean | undefined;
  waiting?: boolean | undefined;
  /** `low`, `medium`, `high`, or `none` for the tasks without one. */
  difficulty?: string | undefined;
};

/** The presets behind `list`, `ready` and `blocked`. */
export const LIST_PRESETS = {
  list: () => true,
  ready: (t: TaskView) => t.ready,
  blocked: (t: TaskView) => t.blocked,
} as const satisfies Record<string, (t: TaskView) => boolean>;

export function listData(
  doc: TasksDocument,
  filter: ListFilter,
  preset: (t: TaskView) => boolean = LIST_PRESETS.list,
): TaskView[] {
  if (filter.group && !doc.groups.some((g) => g.id === filter.group)) {
    throw new CliError(
      `Unknown group "${filter.group}".`,
      `Groups: ${doc.groups.map((g) => g.id).join(", ")}.`,
      EXIT.usage,
    );
  }
  const list = views(doc).filter(
    (t) =>
      preset(t) &&
      (!filter.state || t.state === filter.state) &&
      (!filter.group || t.group === filter.group) &&
      (!filter.ready || t.ready) &&
      (!filter.blocked || t.blocked) &&
      (!filter.waiting || t.waiting) &&
      (!filter.difficulty || (t.difficulty ?? "none") === filter.difficulty),
  );
  // What is ready comes in priority order (rank), so the first one is the next to take.
  return preset === LIST_PRESETS.ready || filter.ready ? readyViews(list) : list;
}

export function showData(doc: TasksDocument, id: string): TaskView {
  const view = views(doc).find((t) => t.id === id.toUpperCase());
  if (!view) throw new CliError(`Task ${id} does not exist.`, HINTS.unknownTask);
  return view;
}

/** Like `showData`, but an archived task comes from `.konsora/archive.json`, marked as such. */
export async function showAnyData(root: string, doc: TasksDocument, id: string): Promise<TaskView> {
  const key = id.toUpperCase();
  if (!doc.archived?.includes(key)) return showData(doc, key);
  const read = await readArchive(root);
  if (!read.ok)
    throw new CliError(
      `${key} is archived, but ${ARCHIVE_FILE} cannot be read: ${read.error.message}`,
      read.error.issues?.length ? issuesText(read.error.issues).trimEnd() : undefined,
    );
  const task = read.archive.tasks.find((t) => t.id === key);
  if (!task)
    throw new CliError(
      `${key} is archived, but ${ARCHIVE_FILE} does not have it.`,
      `Restore .konsora/${ARCHIVE_FILE} from version control.`,
    );
  return { ...task, blockers: [], blocked: false, ready: false, waiting: false, archived: true };
}

export type CheckData =
  | { ok: true; tasks: number; groups: number; hash: string }
  | { ok: false; error: StoreError };

export async function checkData(root: string): Promise<CheckData> {
  const result = await readTasks(root);
  return result.ok
    ? {
        ok: true,
        tasks: result.document.tasks.length,
        groups: result.document.groups.length,
        hash: result.hash,
      }
    : { ok: false, error: result.error };
}
