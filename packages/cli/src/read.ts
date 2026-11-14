/**
 * Read operations shared by the CLI (`--json`) and the MCP server: each returns the exact value
 * the CLI prints with `--json`, so both surfaces stay identical by construction.
 */
import {
  completionLog,
  isStale,
  type LogEntry,
  milestoneProgress,
  STALE_AFTER_HOURS,
  type Task,
  type TaskState,
  type TasksDocument,
  taskMatches,
} from "@konsora/core";
import { ARCHIVE_FILE, readArchive, readTasks, type StoreError } from "@konsora/core/store";
import { parseBefore } from "./archive.ts";
import { issuesText, readyViews, STATES, type TaskView, views } from "./format.ts";
import { HINTS } from "./hints.ts";
import { CliError, EXIT } from "./shared.ts";
import { isOutdated, type SkillState, skillState } from "./skill.ts";

/** When `status` looks at the clock: what counts as an abandoned task in progress (CORE-10). */
export type StaleCheck = { now: Date; hours: number };

export function statusData(
  doc: TasksDocument,
  stale: StaleCheck = { now: new Date(), hours: STALE_AFTER_HOURS },
  skill?: SkillState,
) {
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
    // CORE-10: in progress with no activity for longer than the threshold.
    stale: list.filter((t) => isStale(t, stale.now, stale.hours)).map((t) => t.id),
    proposed: list.filter((t) => t.state === "proposed").map((t) => t.id),
    // CORE-19: each milestone with its done and total tasks; absent when the plan has none.
    ...(doc.milestones?.length ? { milestones: milestoneProgress(doc) } : {}),
    // CLI-03: the installed protocol skill, only when it is older than this checkout's.
    ...(skill && isOutdated(skill) ? { skillOutdated: skill } : {}),
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
  /** Only tasks with this label (CLI-07). */
  label?: string | undefined;
  /** Words that must all appear in the id, title or description, ignoring case (CLI-07). */
  search?: string | undefined;
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
      (!filter.difficulty || (t.difficulty ?? "none") === filter.difficulty) &&
      // The same rule as the board's filter bar (core's taskMatches).
      taskMatches(t, {
        ...(filter.label ? { label: filter.label } : {}),
        ...(filter.search ? { text: filter.search } : {}),
      }),
  );
  // What is ready comes in priority order (rank), so the first one is the next to take.
  return preset === LIST_PRESETS.ready || filter.ready ? readyViews(list) : list;
}

/**
 * The next task to take (CLI-04): the ready task with the lowest `rank`, in the shape of `show`.
 * With none ready, the error says why: nothing left to do, everything blocked, and which tasks
 * wait for an answer from the human.
 */
export function nextData(doc: TasksDocument): TaskView {
  const list = views(doc);
  const first = readyViews(list)[0];
  if (first) return first;
  const ids = (items: TaskView[]) => items.map((t) => t.id).join(", ");
  const todo = list.filter((t) => t.state === "todo");
  const doing = list.filter((t) => t.state === "doing");
  const ideas = list.filter((t) => t.state === "proposed");
  const waiting = list.filter((t) => t.waiting);
  const facts: string[] = [];
  if (doing.length) facts.push(`In progress: ${ids(doing)}.`);
  if (waiting.length) facts.push(`Waiting for an answer from the human: ${ids(waiting)}.`);
  if (todo.length === 0) {
    const what =
      list.length === 0
        ? "The plan is empty."
        : `No task is left to do${ideas.length ? ` (ideas: ${ids(ideas)})` : ""}.`;
    throw new CliError([`No task is ready. ${what}`, ...facts].join("\n"), HINTS.nothingToDo);
  }
  const blocked = todo.map((t) => `${t.id} by ${t.blockers.join(", ")}`).join("; ");
  throw new CliError(
    [`No task is ready: every todo task is blocked (${blocked}).`, ...facts].join("\n"),
    HINTS.allBlocked,
  );
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

/**
 * The done tasks of `.konsora/archive.json` when the plan has archived some; an unreadable archive
 * is an error, so `log` never presents a partial history as the whole one.
 */
export async function archivedTasks(root: string, doc: TasksDocument): Promise<Task[]> {
  if (!doc.archived?.length) return [];
  const read = await readArchive(root);
  if (!read.ok)
    throw new CliError(
      `${ARCHIVE_FILE} cannot be read: ${read.error.message}`,
      read.error.issues?.length ? issuesText(read.error.issues).trimEnd() : undefined,
    );
  return read.archive.tasks;
}

export type LogFilter = {
  /** Only tasks finished at or after this moment (a date or an ISO timestamp). */
  since?: string | undefined;
  /** At most this many entries, the most recent ones. */
  limit?: number | undefined;
};

export function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new CliError(
      `Invalid limit "${value}".`,
      "Give a positive whole number, e.g. --limit 10.",
      EXIT.usage,
    );
  return n;
}

/** The completion log (core's `completionLog`, archived tasks included), newest first. */
export async function logData(
  root: string,
  doc: TasksDocument,
  filter: LogFilter = {},
): Promise<LogEntry[]> {
  const since = filter.since === undefined ? undefined : parseBefore(filter.since);
  const entries = completionLog(doc, await archivedTasks(root, doc)).filter(
    (entry) => since === undefined || entry.at >= since,
  );
  return filter.limit === undefined ? entries : entries.slice(0, filter.limit);
}

/** The installed skill's state for `status`; a skill that cannot be read is not reported. */
export function statusSkill(root: string): Promise<SkillState | undefined> {
  return skillState(root).catch(() => undefined);
}
