/**
 * Pure derivations over a validated `konsora/5` document (docs/esquema-tareas.md §2, "Derivados").
 * Nothing here is stored in the file: `blocked`, `ready` and `waiting` are always computed.
 */
import type { Task, TasksDocument } from "./schema.ts";
import { compareTaskIds } from "./serialize.ts";

export type TaskIndex = ReadonlyMap<string, Task>;

export function indexTasks(doc: Pick<TasksDocument, "tasks">): TaskIndex {
  return new Map(doc.tasks.map((task) => [task.id, task]));
}

/**
 * Priority order: lowest `rank` first, then natural id. It is the order of a board column and of
 * the tasks `konsora ready` offers.
 */
export function compareByRank(a: Pick<Task, "id" | "rank">, b: Pick<Task, "id" | "rank">): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : compareTaskIds(a.id, b.id);
}

/**
 * Dependencies that keep a `todo` task blocked. Only `done` unblocks. A missing dependency counts as unmet. Tasks in other states have no blockers.
 */
export function blockers(task: Task, index: TaskIndex): string[] {
  if (task.state !== "todo") return [];
  return (task.deps ?? []).filter((id) => index.get(id)?.state !== "done");
}

export function isBlocked(task: Task, index: TaskIndex): boolean {
  return blockers(task, index).length > 0;
}

/** `todo` and every dependency `done`: an agent may start it. */
export function isReady(task: Task, index: TaskIndex): boolean {
  return task.state === "todo" && !isBlocked(task, index);
}

/** The latest `question` note has no `answer` note after it. */
export function isWaiting(task: Task): boolean {
  const notes = task.notes ?? [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const kind = notes[i]?.kind;
    if (kind === "answer") return false;
    if (kind === "question") return true;
  }
  return false;
}

/** Tasks that list `id` as a direct dependency. */
export function dependentsOf(id: string, doc: Pick<TasksDocument, "tasks">): string[] {
  return doc.tasks
    .filter((task) => task.deps?.includes(id))
    .map((t) => t.id)
    .sort(compareTaskIds);
}

/** Every task reachable through `deps` from `id` (excluding `id`). Iterative; cycle-safe. */
export function transitiveDeps(id: string, index: TaskIndex): Set<string> {
  return reach(id, (current) => index.get(current)?.deps ?? []);
}

/** Every task that depends on `id`, directly or indirectly (excluding `id`). */
export function transitiveDependents(id: string, doc: Pick<TasksDocument, "tasks">): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const task of doc.tasks) {
    for (const dep of task.deps ?? []) push(reverse, dep, task.id);
  }
  return reach(id, (current) => reverse.get(current) ?? []);
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function reach(start: string, next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(start)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === start || seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

export type TopoResult = {
  /** Every task id, dependencies before dependents. */
  order: string[];
  /** Ids that could not be ordered because they are in (or behind) a cycle; empty for valid docs. */
  cyclic: string[];
};

/**
 * Kahn's algorithm with a deterministic tie-break: among available tasks, lowest `rank`, then
 * natural id. The result does not depend on the order of the `tasks` array.
 */
export function topoOrder(doc: Pick<TasksDocument, "tasks">): TopoResult {
  const index = indexTasks(doc);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of index.values()) {
    const deps = [...new Set(task.deps ?? [])].filter((d) => index.has(d) && d !== task.id);
    indegree.set(task.id, deps.length);
    for (const dep of deps) push(dependents, dep, task.id);
  }
  const before = (a: string, b: string) =>
    compareByRank(
      { id: a, rank: index.get(a)?.rank ?? "" },
      { id: b, rank: index.get(b)?.rank ?? "" },
    );
  const available = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (available.length > 0) {
    available.sort(before);
    const id = available.shift() as string;
    order.push(id);
    for (const child of dependents.get(id) ?? []) {
      const n = (indegree.get(child) as number) - 1;
      indegree.set(child, n);
      if (n === 0) available.push(child);
    }
  }
  const cyclic = [...indegree]
    .filter(([, n]) => n > 0)
    .map(([id]) => id)
    .sort(compareTaskIds);
  return { order, cyclic };
}

/**
 * The subgraph that running `id` needs: the task plus every dependency that is not done yet,
 * followed only through unfinished tasks (a done dependency is satisfied, so what lies behind it
 * is not needed). Dependencies come before dependents. Empty for an unknown or done task.
 */
export function pendingSubgraph(id: string, doc: Pick<TasksDocument, "tasks">): string[] {
  const index = indexTasks(doc);
  const start = index.get(id);
  if (!start || start.state === "done") return [];
  const pending = new Set([
    id,
    ...reach(id, (current) =>
      (index.get(current)?.deps ?? []).filter((dep) => {
        const state = index.get(dep)?.state;
        return state !== undefined && state !== "done";
      }),
    ),
  ]);
  return topoOrder(doc).order.filter((taskId) => pending.has(taskId));
}

export type TaskFlags = { blockers: string[]; blocked: boolean; ready: boolean; waiting: boolean };

/** All derived flags at once, for views that render every task. */
export function deriveFlags(doc: Pick<TasksDocument, "tasks">): Map<string, TaskFlags> {
  const index = indexTasks(doc);
  return new Map(
    doc.tasks.map((task) => {
      const list = blockers(task, index);
      return [
        task.id,
        {
          blockers: list,
          blocked: list.length > 0,
          ready: task.state === "todo" && list.length === 0,
          waiting: isWaiting(task),
        },
      ];
    }),
  );
}
