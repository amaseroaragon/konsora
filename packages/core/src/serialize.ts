/**
 * Canonical serialization of `konsora/2` documents (docs/esquema-tareas.md §4).
 *
 * The same document always produces the same bytes, whoever writes it (CLI, MCP, daemon),
 * so git diffs only show real changes. Rules:
 * - keys in the order of the spec, then `x-*` extension keys in alphabetical order;
 * - optional fields that are empty are omitted (`deps: []`, `desc: ""`, `notes: []`…);
 * - tasks ordered by the order of `groups`, then by id number; `seq` keys by `groups` order;
 * - `deps` in natural id order and `labels` alphabetically; notes, criteria, groups and checks
 *   keep their order (it is meaningful);
 * - 2-space indentation, LF line endings, trailing newline, UTF-8 without BOM.
 */
import type { TasksDocument } from "./schema.ts";
import { taskNumber } from "./semantics.ts";

type Obj = Record<string, unknown>;

const ORDER = {
  root: ["$schema", "schema", "project", "groups", "seq", "tasks"],
  project: ["name", "base_branch", "defaults", "recommended", "setup", "checks", "check_retries"],
  recommended: ["low", "medium", "high"],
  setup: ["run", "timeout_s"],
  agent: ["provider", "model", "effort", "permissions"],
  check: ["id", "run", "timeout_s"],
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
    "agent",
    "yolo",
    "created",
    "updated_at",
    "notes",
  ],
  acceptance: ["id", "text", "check"],
  created: ["at", "by"],
  note: ["id", "at", "by", "kind", "text", "run", "edited"],
} as const;

/** Optional fields dropped when empty. Required arrays (`groups`, `tasks`) are always kept. */
const OMIT_WHEN_EMPTY = new Set(["deps", "desc", "acceptance", "labels", "notes", "checks"]);

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
    if (key === "yolo" && value !== true) continue;
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

/** Returns a new document in canonical order with empty optionals removed. Input is not mutated. */
export function canonicalize(doc: TasksDocument): TasksDocument {
  const groupOrder = new Map(doc.groups.map((g, i) => [g.id, i]));
  const rankOf = (group: string) => groupOrder.get(group) ?? Number.MAX_SAFE_INTEGER;
  const agent = (value: unknown) => ordered(value as Obj, ORDER.agent);

  const tasks = [...doc.tasks]
    .sort((a, b) => rankOf(a.group) - rankOf(b.group) || compareTaskIds(a.id, b.id))
    .map((task) =>
      ordered(task as Obj, ORDER.task, (key, value) => {
        switch (key) {
          case "deps":
            return [...(value as string[])].sort(compareTaskIds);
          case "labels":
            return [...(value as string[])].sort();
          case "acceptance":
            return (value as Obj[]).map((a) => ordered(a, ORDER.acceptance));
          case "agent":
            return agent(value);
          case "created":
            return ordered(value as Obj, ORDER.created);
          case "notes":
            return (value as Obj[]).map((n) => ordered(n, ORDER.note));
          default:
            return value;
        }
      }),
    );

  const seq: Obj = {};
  for (const key of Object.keys(doc.seq).sort(
    (a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : 1),
  )) {
    seq[key] = doc.seq[key];
  }

  return ordered(doc as Obj, ORDER.root, (key, value) => {
    switch (key) {
      case "project":
        return ordered(value as Obj, ORDER.project, (k, v) =>
          k === "defaults"
            ? agent(v)
            : k === "recommended"
              ? ordered(v as Obj, ORDER.recommended, (_, spec) => agent(spec))
              : k === "setup"
                ? ordered(v as Obj, ORDER.setup)
                : k === "checks"
                  ? (v as Obj[]).map((c) => ordered(c, ORDER.check))
                  : v,
        );
      case "groups":
        return (value as Obj[]).map((g) => ordered(g, ORDER.group));
      case "seq":
        return seq;
      case "tasks":
        return tasks;
      default:
        return value;
    }
  }) as TasksDocument;
}

/** Canonical text of a document. Callers validate first; this function does not. */
export function serializeDocument(doc: TasksDocument): string {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}
