/**
 * Task filters shared by every view that narrows the plan (the board and the graph today): free
 * text, group, label and who created or closed the task. Pure and derived: a filter never changes
 * the plan.
 */
import type { Task, TasksDocument } from "./schema.ts";

export type TaskFilter = {
  /** Words that must all appear in the id, the title or the description (case-insensitive). */
  text?: string;
  group?: string;
  label?: string;
  /** An actor (`human`, `agent:<name>`): who created the task or wrote its closing summary. */
  by?: string;
};

const FILTER_KEYS = ["text", "group", "label", "by"] as const;

/** The filter without empty values; `{}` when nothing narrows the plan. */
export function cleanFilter(filter: TaskFilter): TaskFilter {
  const clean: TaskFilter = {};
  for (const key of FILTER_KEYS) {
    const value = filter[key]?.trim();
    if (value) clean[key] = value;
  }
  return clean;
}

export function isFilterActive(filter: TaskFilter): boolean {
  return Object.keys(cleanFilter(filter)).length > 0;
}

/** The actors a task is attributed to: who created it and who wrote its last summary. */
function actorsOf(task: Task): string[] {
  const summary = task.notes?.findLast((note) => note.kind === "summary");
  return summary ? [task.created.by, summary.by] : [task.created.by];
}

/** Whether `task` passes every part of `filter` (an empty filter passes everything). */
export function taskMatches(task: Task, filter: TaskFilter): boolean {
  const { text, group, label, by } = cleanFilter(filter);
  if (group && task.group !== group) return false;
  if (label && !task.labels?.includes(label)) return false;
  if (by && !actorsOf(task).includes(by)) return false;
  if (text) {
    const haystack = `${task.id}\n${task.title}\n${task.desc ?? ""}`.toLowerCase();
    for (const word of text.toLowerCase().split(/\s+/)) {
      if (word && !haystack.includes(word)) return false;
    }
  }
  return true;
}

/** The ids of the tasks that pass `filter`. */
export function matchingIds(doc: Pick<TasksDocument, "tasks">, filter: TaskFilter): Set<string> {
  return new Set(doc.tasks.filter((task) => taskMatches(task, filter)).map((task) => task.id));
}

export type FilterFacets = { labels: string[]; actors: string[] };

/** What the plan can be filtered by: its labels and its actors, sorted. */
export function filterFacets(doc: Pick<TasksDocument, "tasks">): FilterFacets {
  const labels = new Set<string>();
  const actors = new Set<string>();
  for (const task of doc.tasks) {
    for (const label of task.labels ?? []) labels.add(label);
    for (const actor of actorsOf(task)) actors.add(actor);
  }
  return { labels: [...labels].sort(), actors: [...actors].sort() };
}
