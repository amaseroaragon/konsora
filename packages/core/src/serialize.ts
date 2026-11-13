/**
 * Canonical serialization of `konsora/5` documents (docs/esquema-tareas.md §4).
 *
 * The same document always produces the same bytes, whoever writes it (CLI, MCP, daemon),
 * so git diffs only show real changes. Rules:
 * - keys in the order of the spec, then `x-*` extension keys in alphabetical order;
 * - optional fields that are empty are omitted (`deps: []`, `desc: ""`, `notes: []`…);
 * - tasks ordered by the order of `groups`, then by id number; `seq` keys by `groups` order;
 * - `deps` in natural id order and `labels` (of tasks and templates) alphabetically; notes,
 *   criteria, groups and templates keep their order (it is meaningful);
 * - 2-space indentation, LF line endings, trailing newline, UTF-8 without BOM.
 */
import type { ArchiveDocument, Task, TasksDocument } from "./schema.ts";
import { taskNumber } from "./semantics.ts";

type Obj = Record<string, unknown>;

const ORDER = {
  root: ["$schema", "schema", "project", "groups", "seq", "archived", "tasks", "deleted"],
  archive: ["schema", "tasks"],
  project: ["name", "templates"],
  template: ["id", "name", "desc", "acceptance", "labels"],
  criterion: ["text"],
  group: ["id", "name"],
  task: [
    "id",
    "title",
    "state",
    "group",
    "deps",
    "rank",
    "desc",
    "acceptance",
    "labels",
    "difficulty",
    "created",
    "updated_at",
    "notes",
    "events",
  ],
  acceptance: ["id", "text"],
  created: ["at", "by"],
  note: ["id", "at", "by", "kind", "text", "options", "edited"],
  event: ["at", "by", "type", "fields"],
  deleted: ["id", "title", "at", "by"],
} as const;

/** Optional fields dropped when empty. Required arrays (`groups`, `tasks`) are always kept. */
const OMIT_WHEN_EMPTY = new Set([
  "deps",
  "desc",
  "acceptance",
  "labels",
  "notes",
  "templates",
  "options",
  "archived",
  "events",
  "fields",
  "deleted",
]);

function isEmpty(value: unknown): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** Rebuilds `source` with known keys in `order`, then `x-*` keys sorted; drops empty optionals. */
function ordered(
  source: Obj,
  order: readonly string[],
  map: (key: string, value: unknown) => unknown = (_, v) => v,
): Obj {
  const out: Obj = {};
  for (const key of order) {
    const value = source[key];
    if (value === undefined || (OMIT_WHEN_EMPTY.has(key) && isEmpty(value))) continue;
    out[key] = map(key, value);
  }
  for (const key of Object.keys(source)
    .filter((k) => k.startsWith("x-"))
    .sort()) {
    out[key] = source[key];
  }
  return out;
}

/** Natural order for task ids: by prefix, then by number (`BE-99` < `BE-100`). */
export function compareTaskIds(a: string, b: string): number {
  const pa = a.slice(0, a.lastIndexOf("-"));
  const pb = b.slice(0, b.lastIndexOf("-"));
  if (pa !== pb) return pa < pb ? -1 : 1;
  return taskNumber(a) - taskNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function canonicalTask(task: Task): Obj {
  return ordered(task as Obj, ORDER.task, (key, value) => {
    switch (key) {
      case "deps":
        return [...(value as string[])].sort(compareTaskIds);
      case "labels":
        return [...(value as string[])].sort();
      case "acceptance":
        return (value as Obj[]).map((a) => ordered(a, ORDER.acceptance));
      case "created":
        return ordered(value as Obj, ORDER.created);
      case "notes":
        return (value as Obj[]).map((n) => ordered(n, ORDER.note));
      case "events":
        return (value as Obj[]).map((e) => ordered(e, ORDER.event));
      default:
        return value;
    }
  });
}

/** Returns a new document in canonical order with empty optionals removed. Input is not mutated. */
export function canonicalize(doc: TasksDocument): TasksDocument {
  const groupOrder = new Map(doc.groups.map((g, i) => [g.id, i]));
  const rankOf = (group: string) => groupOrder.get(group) ?? Number.MAX_SAFE_INTEGER;
  const template = (value: Obj) =>
    ordered(value, ORDER.template, (key, v) =>
      key === "acceptance"
        ? (v as Obj[]).map((c) => ordered(c, ORDER.criterion))
        : key === "labels"
          ? [...(v as string[])].sort()
          : v,
    );

  const tasks = [...doc.tasks]
    .sort((a, b) => rankOf(a.group) - rankOf(b.group) || compareTaskIds(a.id, b.id))
    .map(canonicalTask);

  const seq: Obj = {};
  for (const key of Object.keys(doc.seq).sort(
    (a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : 1),
  )) {
    seq[key] = doc.seq[key];
  }

  return ordered(doc as Obj, ORDER.root, (key, value) => {
    switch (key) {
      case "project":
        return ordered(value as Obj, ORDER.project, (k, v) => {
          return k === "templates" ? (v as Obj[]).map(template) : v;
        });
      case "groups":
        return (value as Obj[]).map((g) => ordered(g, ORDER.group));
      case "seq":
        return seq;
      case "archived":
        return [...(value as string[])].sort(compareTaskIds);
      case "tasks":
        return tasks;
      case "deleted":
        return (value as Obj[]).map((d) => ordered(d, ORDER.deleted));
      default:
        return value;
    }
  }) as TasksDocument;
}

/** Canonical text of a document. Callers validate first; this function does not. */
export function serializeDocument(doc: TasksDocument): string {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/** Canonical text of `.konsora/archive.json`: tasks in natural id order, each as in the plan. */
export function serializeArchive(archive: ArchiveDocument): string {
  const tasks = [...archive.tasks].sort((a, b) => compareTaskIds(a.id, b.id)).map(canonicalTask);
  return `${JSON.stringify(ordered({ ...archive, tasks } as Obj, ORDER.archive), null, 2)}\n`;
}
