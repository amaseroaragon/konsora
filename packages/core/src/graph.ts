/**
 * Pure derivations over a validated `konsora/2` document (docs/esquema-tareas.md §2, "Derivados").
 * Nothing here is stored in the file: `blocked`, `ready` and `waiting` are always computed.
 */
import type { Task, TasksDocument } from "./schema.ts";
import { compareTaskIds } from "./serialize.ts";

export type TaskIndex = ReadonlyMap<string, Task>;

export function indexTasks(doc: Pick<TasksDocument, "tasks">): TaskIndex {
  return new Map(doc.tasks.map((task) => [task.id, task]));
}

/**
 * Dependencies that keep a `todo` task blocked. Only `done` unblocks: a dependency in `review`
 * still blocks. A missing dependency counts as unmet. Tasks in other states have no blockers.
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
  const before = (a: string, b: string) => {
    const ra = index.get(a)?.rank ?? "";
    const rb = index.get(b)?.rank ?? "";
    return ra < rb ? -1 : ra > rb ? 1 : compareTaskIds(a, b);
  };
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

/** A YOLO task's chain: the task itself plus all its transitive dependencies. */
export function yoloChain(task: Task, index: TaskIndex): Set<string> {
  return new Set([task.id, ...transitiveDeps(task.id, index)]);
}

/**
 * Active YOLO tasks whose chain contains `id`. A YOLO task stops being active once it reaches
 * `review` or `done` (docs/esquema-tareas.md §2).
 */
export function yoloCovering(id: string, doc: Pick<TasksDocument, "tasks">): string[] {
  const index = indexTasks(doc);
  return doc.tasks
    .filter((t) => t.yolo && t.state !== "review" && t.state !== "done")
    .filter((t) => yoloChain(t, index).has(id))
    .map((t) => t.id)
    .sort(compareTaskIds);
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
