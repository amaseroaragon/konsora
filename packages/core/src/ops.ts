/**
 * State machine and semantic operations (docs/esquema-tareas.md §2 and §5).
 *
 * Every change to a plan is an operation such as `start BE-02` or `note BE-02 …`, applied by
 * `applyOp` to the latest document. Each op checks:
 * 1. the actor's role (human / agent / konsora) and, in a planning session, its scope;
 * 2. per-task preconditions: hashes of the tasks the client read (`expect`); if one of those
 *    tasks changed meanwhile → `conflict`, while changes to other tasks never conflict;
 * 3. the transition rules; and finally that the whole result still validates.
 * `applyOp` is pure: it never mutates its input.
 */
import {
  blockers,
  compareByRank,
  indexTasks,
  isBlocked,
  isWaiting,
  transitiveDeps,
} from "./graph.ts";
import { contentHash } from "./hash.ts";
import { rankAfterAll, rankBetween } from "./rank.ts";
import {
  type Acceptance,
  DELETED_LIMIT,
  type Difficulty,
  type EditedField,
  EVENTS_LIMIT,
  type EventType,
  EventTypeSchema,
  type Note,
  type NoteKind,
  type SchemaIssue,
  type Task,
  type TaskState,
  type TasksDocument,
  type Template,
} from "./schema.ts";
import { validateDocument } from "./semantics.ts";

export type Role = "human" | "agent" | "konsora";

export function roleOf(actor: string): Role {
  if (actor === "human") return "human";
  if (actor === "konsora") return "konsora";
  return "agent";
}

export type OpContext = {
  /** `human`, `konsora` or `agent:<name>`. */
  actor: string;
  /** ISO UTC timestamp with seconds precision, used for notes and `updated_at`. */
  at: string;
  /**
   * An agent in a planning session (`konsora plan` or the UI's AI panel): it may only create,
   * revise and delete tasks nobody started yet; it starts nothing.
   */
  plan?: boolean;
};

/** Precondition: hash (see `taskHash`) of each task the client based the op on. */
export type Expectations = Readonly<Record<string, string>>;

type Base = { expect?: Expectations };
export type NewTask = {
  title: string;
  group: string;
  desc?: string;
  acceptance?: string[];
  deps?: string[];
  labels?: string[];
  difficulty?: Difficulty;
  /** CORE-19: the milestone the task belongs to. */
  milestone?: string;
  /**
   * A template of `project.templates` the task starts from: its own desc replaces the
   * template's, its criteria come after the template's and its labels join them.
   */
  template?: string;
};

export type Op = Base &
  (
    | ({ op: "propose"; state?: "proposed" | "todo" } & NewTask)
    | {
        op: "batch";
        groups?: { id: string; name: string }[];
        /** `idea: true` creates that task as an idea (`proposed`) instead of in `todo`. */
        tasks: (NewTask & { idea?: boolean })[];
      }
    | { op: "add-group"; id: string; name: string }
    /** CORE-13: renames a group; its id (the prefix of its tasks' ids) never changes. */
    | { op: "rename-group"; id: string; name: string }
    /** CORE-13: the groups in a new order; `ids` lists every group exactly once. */
    | { op: "reorder-groups"; ids: string[] }
    /**
     * CORE-13: removes a group no task uses: none belongs to it and no id, in the plan or
     * archived, has its prefix. Otherwise `in_use`.
     */
    | { op: "remove-group"; id: string }
    /** CORE-13: the human renames the project. */
    | { op: "rename-project"; name: string }
    /** CORE-19: adds a milestone at the end. */
    | { op: "add-milestone"; id: string; name: string; criterion?: string }
    /** CORE-19: renames a milestone or changes its done criterion (`null` removes it). */
    | { op: "edit-milestone"; id: string; name?: string; criterion?: string | null }
    /** CORE-19: removes a milestone no task belongs to; otherwise `in_use`. */
    | { op: "remove-milestone"; id: string }
    /** An idea (`proposed`) becomes work to do. Anyone may do it: there is no approval. */
    | { op: "promote"; task: string }
    /** The way back: a `todo` task nobody started becomes an idea (`proposed`) again. */
    | { op: "demote"; task: string }
    | {
        op: "edit";
        task: string;
        changes: Partial<Pick<Task, "title" | "desc" | "labels" | "group" | "rank">> & {
          acceptance?: Acceptance[];
          /** `null` removes it. */
          difficulty?: Difficulty | null;
          /** CORE-19: the milestone; `null` takes the task out of it. */
          milestone?: string | null;
        };
      }
    /**
     * Reorders a task: right before or after another one, or first of all (exactly one of the
     * three). Only its own `rank` changes.
     */
    | { op: "move"; task: string; before?: string; after?: string; top?: boolean }
    /** Removes a task; tasks that depended on it lose that dependency (with a note). */
    | { op: "delete"; task: string }
    | { op: "depend"; task: string; on: string }
    | { op: "undepend"; task: string; on: string }
    | { op: "start"; task: string; text?: string }
    | { op: "pause"; task: string; text?: string }
    | { op: "note"; task: string; text: string }
    /** `options`: two or more answers the human may pick from (they can still write their own). */
    | { op: "ask"; task: string; text: string; options?: string[] }
    | { op: "answer"; task: string; text: string }
    | { op: "finish"; task: string; summary: string }
    /** The human sets the project's task templates (it replaces them all); `[]` removes them. */
    | { op: "set-templates"; templates: Template[] }
    | { op: "reopen"; task: string; text?: string }
    | { op: "restore"; task: string; version: Task }
    /**
     * Human-only: undoes one of their own actions (UI-21). Each change puts a task back to
     * `before` (null: the task did not exist, so it is removed), but only if it is still exactly
     * as that action left it (`after`, its hash; null: it was deleted). Otherwise nothing applies.
     */
    | { op: "undo"; changes: UndoChange[] }
  );

/** One task's part of an undo: the version to put back and the hash it must have now. */
export type UndoChange = { task: string; before: Task | null; after: string | null };

export type OpName = Op["op"];

export type OpErrorCode =
  | "forbidden"
  | "out_of_scope"
  | "not_found"
  | "invalid_transition"
  | "blocked"
  | "conflict"
  | "summary_required"
  | "feedback_required"
  | "text_required"
  | "not_waiting"
  | "unknown_template"
  | "in_use"
  | "invalid";

export type OpError = {
  code: OpErrorCode;
  message: string;
  task?: string;
  /** For `conflict`: the task as it is now, so the client can show it and retry. */
  current?: Task;
  /** For `invalid`: what the result would have broken. */
  issues?: SchemaIssue[];
};

export type OpResult =
  | { ok: true; document: TasksDocument; changed: string[]; created: string[] }
  | { ok: false; error: OpError };

/** Hash used in `expect`. Changes whenever anything in the task changes. */
export function taskHash(task: Task): string {
  return contentHash(task);
}

/**
 * What undoes an action: for each task it changed, its version before and the hash it has after
 * (null when the action deleted it). Tasks are in `ids` order.
 */
export function undoOf(
  before: Pick<TasksDocument, "tasks">,
  after: Pick<TasksDocument, "tasks">,
  ids: readonly string[],
): UndoChange[] {
  const old = indexTasks(before);
  const now = indexTasks(after);
  return ids.map((task) => {
    const then = old.get(task);
    const current = now.get(task);
    return { task, before: then ?? null, after: current ? taskHash(current) : null };
  });
}

/**
 * Several consecutive actions undone at once (a bulk action, task by task): per task, the version
 * before the first and the hash after the last.
 */
export function mergeUndo(steps: readonly (readonly UndoChange[])[]): UndoChange[] {
  const merged = new Map<string, UndoChange>();
  for (const step of steps)
    for (const change of step) {
      const first = merged.get(change.task);
      merged.set(change.task, first ? { ...first, after: change.after } : change);
    }
  return [...merged.values()];
}

/** Who may run each op (docs/esquema-tareas.md §2). */
const ROLES: Record<OpName, readonly Role[]> = {
  propose: ["human", "agent"],
  batch: ["human", "agent"],
  "add-group": ["human", "agent"],
  "rename-group": ["human", "agent"],
  "reorder-groups": ["human", "agent"],
  "remove-group": ["human", "agent"],
  "rename-project": ["human"],
  "add-milestone": ["human", "agent"],
  "edit-milestone": ["human", "agent"],
  "remove-milestone": ["human", "agent"],
  promote: ["human", "agent"],
  demote: ["human", "agent"],
  edit: ["human", "agent"], // agents: unfinished tasks only (checked below)
  move: ["human", "agent"], // agents: unfinished tasks only
  delete: ["human", "agent"], // agents: tasks nobody started only
  depend: ["human", "agent"],
  undepend: ["human", "agent"], // agents: unfinished tasks only
  start: ["agent", "konsora"],
  pause: ["human", "agent", "konsora"],
  note: ["human", "agent", "konsora"],
  ask: ["agent"],
  answer: ["human"],
  finish: ["agent", "konsora"],
  "set-templates": ["human"],
  reopen: ["human"],
  restore: ["human"],
  undo: ["human"],
};

const EDITABLE = [
  "title",
  "desc",
  "acceptance",
  "labels",
  "group",
  "rank",
  "difficulty",
  "milestone",
] as const;

/** All an agent in a planning session may do. */
const PLAN_OPS: ReadonlySet<OpName> = new Set([
  "propose",
  "batch",
  "edit",
  "move",
  "delete",
  "depend",
  "undepend",
  "promote",
  "demote",
]);

/** States nobody has started working on: what agents may delete and plan sessions may change. */
const NOT_STARTED: ReadonlySet<TaskState> = new Set(["proposed", "todo"]);

class OpFailure extends Error {
  readonly detail: OpError;
  constructor(detail: OpError) {
    super(detail.message);
    this.detail = detail;
  }
}

const fail = (code: OpErrorCode, message: string, extra: Partial<OpError> = {}): never => {
  throw new OpFailure({ code, message, ...extra });
};

export function applyOp(input: TasksDocument, op: Op, ctx: OpContext): OpResult {
  try {
    return apply(input, op, ctx);
  } catch (error) {
    if (error instanceof OpFailure) return { ok: false, error: error.detail };
    throw error;
  }
}

function apply(input: TasksDocument, op: Op, ctx: OpContext): OpResult {
  const role = roleOf(ctx.actor);
  if (!ROLES[op.op].includes(role)) {
    fail("forbidden", `${op.op} is not allowed for ${role === "human" ? "humans" : `${role}s`}`);
  }

  const doc = structuredClone(input);
  const index = new Map(doc.tasks.map((t) => [t.id, t]));
  const original = indexTasks(input);

  for (const [id, hash] of Object.entries(op.expect ?? {})) {
    const current = original.get(id);
    if (!current) fail("conflict", `${id} no longer exists`, { task: id });
    else if (taskHash(current) !== hash) {
      fail("conflict", `${id} changed since you read it; review the current version and retry`, {
        task: id,
        current,
      });
    }
  }

  if (ctx.plan && role === "agent") {
    if (!PLAN_OPS.has(op.op)) {
      fail(
        "out_of_scope",
        `In a planning session you can only plan: create, revise and delete tasks nobody started; ${op.op} is not available`,
        "task" in op ? { task: op.task } : {},
      );
    }
    const target = "task" in op ? original.get(op.task) : undefined;
    if (target && !NOT_STARTED.has(target.state)) {
      fail(
        "out_of_scope",
        `In a planning session you can only change tasks nobody started; ${target.id} is ${target.state}`,
        { task: target.id },
      );
    }
  }

  const changed = new Set<string>();
  const created: string[] = [];
  const get = (id: string): Task =>
    index.get(id) ?? fail("not_found", `Task ${id} does not exist`, { task: id });
  const touch = (task: Task) => {
    task.updated_at = ctx.at;
    changed.add(task.id);
  };
  const addNote = (task: Task, kind: NoteKind, text: string, options?: string[]) => {
    const body = text.trim();
    const notes = task.notes ?? [];
    const next = Math.max(0, ...notes.map((n) => Number(n.id.slice(1)))) + 1;
    const note: Note = { id: `n${next}`, at: ctx.at, by: ctx.actor, kind, text: body };
    if (options?.length) note.options = options;
    task.notes = [...notes, note];
    touch(task);
  };
  // CORE-17: who changed the task, what and when; only the latest EVENTS_LIMIT are kept.
  const log = (task: Task, type: EventType, fields?: EditedField[]) => {
    const event = { at: ctx.at, by: ctx.actor, type, ...(fields?.length ? { fields } : {}) };
    task.events = [...(task.events ?? []), event].slice(-EVENTS_LIMIT);
  };
  const forget = (id: string) => {
    if (!doc.deleted?.some((d) => d.id === id)) return;
    doc.deleted = doc.deleted.filter((d) => d.id !== id);
    if (doc.deleted.length === 0) delete doc.deleted;
  };
  const transition = (task: Task, from: readonly TaskState[], to: TaskState) => {
    if (!from.includes(task.state)) {
      fail(
        "invalid_transition",
        `${task.id} is ${task.state}; ${op.op} needs ${from.join(" or ")}`,
        {
          task: task.id,
        },
      );
    }
    task.state = to;
    touch(task);
    const type = EventTypeSchema.safeParse(op.op);
    if (type.success) log(task, type.data);
  };
  const requireText = (value: string | undefined, code: OpErrorCode, what: string): string => {
    if (!value?.trim()) fail(code, `${op.op} requires ${what}`);
    return value as string;
  };
  const milestoneOf = (id: string): string => {
    if (!doc.milestones?.some((m) => m.id === id))
      fail("not_found", `Milestone ${id} does not exist`);
    return id;
  };
  const createTask = (spec: NewTask, state: TaskState, deps: string[]): Task => {
    if (!doc.groups.some((g) => g.id === spec.group))
      fail("not_found", `Group ${spec.group} does not exist`);
    const template =
      spec.template === undefined
        ? undefined
        : (doc.project.templates?.find((t) => t.id === spec.template) ??
          fail("unknown_template", `Template "${spec.template}" does not exist`));
    const number = (doc.seq[spec.group] ?? 0) + 1;
    doc.seq[spec.group] = number;
    const task: Task = {
      id: `${spec.group}-${String(number).padStart(2, "0")}`,
      title: spec.title.trim(),
      state,
      group: spec.group,
      rank: rankAfterAll(doc.tasks.map((t) => t.rank)),
      created: { at: ctx.at, by: ctx.actor },
      updated_at: ctx.at,
    };
    if (deps.length) task.deps = deps;
    const desc = spec.desc?.trim() || template?.desc?.trim();
    if (desc) task.desc = desc;
    const criteria = [
      ...(template?.acceptance ?? []),
      ...(spec.acceptance ?? []).map((text) => ({ text })),
    ];
    if (criteria.length)
      task.acceptance = criteria.map((c, i) => ({ id: `ac${i + 1}`, ...structuredClone(c) }));
    const labels = [...new Set([...(template?.labels ?? []), ...(spec.labels ?? [])])];
    if (labels.length) task.labels = labels;
    if (spec.difficulty) task.difficulty = spec.difficulty;
    if (spec.milestone) task.milestone = milestoneOf(spec.milestone);
    doc.tasks.push(task);
    index.set(task.id, task);
    created.push(task.id);
    changed.add(task.id);
    return task;
  };

  switch (op.op) {
    case "propose": {
      for (const dep of op.deps ?? []) get(dep);
      createTask(op, op.state ?? "todo", op.deps ?? []);
      break;
    }
    case "batch": {
      for (const group of op.groups ?? []) {
        if (!doc.groups.some((g) => g.id === group.id)) {
          doc.groups.push(group);
          doc.seq[group.id] = doc.seq[group.id] ?? 0;
        }
      }
      // Deps may name an existing id or the title of an earlier task in the same batch.
      const byTitle = new Map<string, string>();
      for (const spec of op.tasks) {
        const deps = (spec.deps ?? []).map(
          (ref) =>
            byTitle.get(ref) ??
            (index.has(ref) ? ref : fail("not_found", `Unknown dependency "${ref}" in batch`)),
        );
        const task = createTask(spec, spec.idea ? "proposed" : "todo", deps);
        byTitle.set(spec.title.trim(), task.id);
      }
      break;
    }
    case "add-group": {
      if (doc.groups.some((g) => g.id === op.id)) fail("invalid", `Group ${op.id} already exists`);
      doc.groups.push({ id: op.id, name: op.name });
      doc.seq[op.id] = doc.seq[op.id] ?? 0;
      break;
    }
    case "rename-group": {
      const group =
        doc.groups.find((g) => g.id === op.id) ??
        fail("not_found", `Group ${op.id} does not exist`);
      const name = op.name.trim();
      if (!name) fail("invalid", "A group needs a name");
      group.name = name;
      break;
    }
    case "reorder-groups": {
      const current = doc.groups.map((g) => g.id);
      const same =
        op.ids.length === current.length &&
        new Set(op.ids).size === op.ids.length &&
        current.every((id) => op.ids.includes(id));
      if (!same)
        fail("invalid", `reorder-groups must list every group exactly once: ${current.join(", ")}`);
      const byId = new Map(doc.groups.map((g) => [g.id, g]));
      doc.groups = op.ids.map((id) => byId.get(id) as (typeof doc.groups)[number]);
      break;
    }
    case "remove-group": {
      if (!doc.groups.some((g) => g.id === op.id))
        fail("not_found", `Group ${op.id} does not exist`);
      const prefix = `${op.id}-`;
      const users = [
        ...doc.tasks.filter((t) => t.group === op.id || t.id.startsWith(prefix)).map((t) => t.id),
        ...(doc.archived ?? []).filter((id) => id.startsWith(prefix)),
      ];
      if (users.length > 0) {
        const shown = users.slice(0, 5).join(", ") + (users.length > 5 ? ", …" : "");
        fail(
          "in_use",
          `Group ${op.id} is still used by ${users.length} task(s) (${shown}); a group can only be removed when no task belongs to it or has its prefix in the id`,
        );
      }
      if (doc.groups.length === 1) fail("invalid", "The plan needs at least one group");
      doc.groups = doc.groups.filter((g) => g.id !== op.id);
      delete doc.seq[op.id];
      break;
    }
    case "rename-project": {
      const name = op.name.trim();
      if (!name) fail("invalid", "The project needs a name");
      doc.project.name = name;
      break;
    }
    case "add-milestone": {
      if (doc.milestones?.some((m) => m.id === op.id))
        fail("invalid", `Milestone ${op.id} already exists`);
      const name = op.name.trim();
      if (!name) fail("invalid", "A milestone needs a name");
      const criterion = op.criterion?.trim();
      doc.milestones = [
        ...(doc.milestones ?? []),
        { id: op.id, name, ...(criterion ? { criterion } : {}) },
      ];
      break;
    }
    case "edit-milestone": {
      const milestone =
        doc.milestones?.find((m) => m.id === op.id) ??
        fail("not_found", `Milestone ${op.id} does not exist`);
      if (op.name !== undefined) {
        const name = op.name.trim();
        if (!name) fail("invalid", "A milestone needs a name");
        milestone.name = name;
      }
      if (op.criterion !== undefined) {
        const criterion = op.criterion?.trim();
        if (criterion) milestone.criterion = criterion;
        else delete milestone.criterion;
      }
      break;
    }
    case "remove-milestone": {
      if (!doc.milestones?.some((m) => m.id === op.id))
        fail("not_found", `Milestone ${op.id} does not exist`);
      const users = doc.tasks.filter((t) => t.milestone === op.id).map((t) => t.id);
      if (users.length > 0) {
        const shown = users.slice(0, 5).join(", ") + (users.length > 5 ? ", …" : "");
        fail(
          "in_use",
          `Milestone ${op.id} still has ${users.length} task(s) (${shown}); take them out of it first`,
        );
      }
      doc.milestones = (doc.milestones ?? []).filter((m) => m.id !== op.id);
      if (doc.milestones.length === 0) delete doc.milestones;
      break;
    }
    case "promote":
      transition(get(op.task), ["proposed"], "todo");
      break;
    case "demote":
      transition(get(op.task), ["todo"], "proposed");
      break;
    case "edit": {
      const task = get(op.task);
      if (role !== "human" && task.state === "done") {
        fail("forbidden", `${task.id} is done; only humans can change finished work`, {
          task: task.id,
        });
      }
      if (typeof op.changes.milestone === "string") milestoneOf(op.changes.milestone);
      // Whitelist at runtime too: callers (CLI, MCP) pass JSON from agents.
      for (const key of EDITABLE) {
        if (!(key in op.changes)) continue;
        const value = op.changes[key];
        if (value === undefined || value === null) delete task[key];
        else Object.assign(task, { [key]: value });
      }
      const unknown = Object.keys(op.changes).filter(
        (k) => !(EDITABLE as readonly string[]).includes(k),
      );
      if (unknown.length)
        fail("forbidden", `edit cannot change ${unknown.join(", ")}`, { task: task.id });
      if (task.desc === "") delete task.desc;
      touch(task);
      log(
        task,
        "edit",
        EDITABLE.filter((key) => key in op.changes),
      );
      break;
    }
    case "move": {
      const task = get(op.task);
      if (role !== "human" && task.state === "done") {
        fail("forbidden", `${task.id} is done; only humans can change finished work`, {
          task: task.id,
        });
      }
      const places = [op.before, op.after, op.top ? "top" : undefined].filter(
        (place) => place !== undefined,
      );
      if (places.length !== 1)
        fail("invalid", "move needs exactly one of before, after or top", { task: task.id });
      const anchorId = op.before ?? op.after;
      if (anchorId === task.id)
        fail("invalid", `${task.id} cannot be placed next to itself`, { task: task.id });
      const others = doc.tasks.filter((t) => t.id !== task.id).sort(compareByRank);
      // The new rank goes strictly between `lower` and `upper` (either may be open).
      let lower: string | undefined;
      let upper: string | undefined;
      if (anchorId === undefined) upper = others[0]?.rank;
      else {
        const anchor = get(anchorId);
        if (op.before !== undefined) {
          upper = anchor.rank;
          lower = others.findLast((t) => t.rank < anchor.rank)?.rank;
        } else {
          lower = anchor.rank;
          upper = others.find((t) => t.rank > anchor.rank)?.rank;
        }
      }
      const inPlace =
        (lower === undefined || task.rank > lower) && (upper === undefined || task.rank < upper);
      // Already there (next to the anchor, or the first of all): nothing changes.
      if (inPlace) break;
      try {
        task.rank = rankBetween(lower, upper);
      } catch {
        fail(
          "invalid",
          `No rank fits ${op.top ? "before every task" : `next to ${anchorId}`}; move another task first`,
          { task: task.id },
        );
      }
      touch(task);
      break;
    }
    case "delete": {
      const task = get(op.task);
      if (role !== "human" && !NOT_STARTED.has(task.state)) {
        fail(
          "forbidden",
          `${task.id} is ${task.state}; agents can only delete tasks nobody started`,
          {
            task: task.id,
          },
        );
      }
      const doneDependent = doc.tasks.find((t) => t.state === "done" && t.deps?.includes(task.id));
      if (role !== "human" && doneDependent)
        fail(
          "forbidden",
          `${task.id} is a dependency of finished task ${doneDependent.id}; only humans can delete it`,
          { task: task.id },
        );
      doc.tasks = doc.tasks.filter((t) => t.id !== task.id);
      index.delete(task.id);
      changed.add(task.id);
      doc.deleted = [
        ...(doc.deleted ?? []),
        { id: task.id, title: task.title, at: ctx.at, by: ctx.actor },
      ].slice(-DELETED_LIMIT);
      for (const dependent of doc.tasks.filter((t) => t.deps?.includes(task.id))) {
        dependent.deps = (dependent.deps ?? []).filter((d) => d !== task.id);
        if (dependent.deps.length === 0) delete dependent.deps;
        addNote(dependent, "note", `Dependency ${task.id} (${task.title}) was deleted.`);
        log(dependent, "edit", ["deps"]);
      }
      break;
    }
    case "depend": {
      const task = get(op.task);
      get(op.on);
      if (task.state === "done")
        fail("invalid_transition", `${task.id} is done; reopen it first`, { task: task.id });
      if (op.on === task.id || transitiveDeps(op.on, index).has(task.id)) {
        fail("invalid", `Adding ${op.on} as a dependency of ${task.id} would create a cycle`, {
          task: task.id,
        });
      }
      if (!task.deps?.includes(op.on)) {
        task.deps = [...(task.deps ?? []), op.on];
        touch(task);
        log(task, "edit", ["deps"]);
      }
      break;
    }
    case "undepend": {
      const task = get(op.task);
      if (role !== "human" && task.state === "done") {
        fail("forbidden", `${task.id} is done; only humans can remove its dependencies`, {
          task: task.id,
        });
      }
      if (task.deps?.includes(op.on)) {
        task.deps = task.deps.filter((d) => d !== op.on);
        if (task.deps.length === 0) delete task.deps;
        touch(task);
        log(task, "edit", ["deps"]);
      }
      break;
    }
    case "start": {
      const task = get(op.task);
      const archived = new Set(doc.archived);
      if (task.state === "todo" && isBlocked(task, index, archived)) {
        const pending = blockers(task, index, archived);
        fail("blocked", `${task.id} is blocked by ${pending.join(", ")}`, { task: task.id });
      }
      transition(task, ["todo"], "doing");
      task.started = { at: ctx.at, by: ctx.actor };
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "pause": {
      const task = get(op.task);
      transition(task, ["doing"], "todo");
      delete task.started;
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "note": {
      const task = get(op.task);
      if (task.state === "done" && role !== "human") {
        fail("invalid_transition", `${task.id} is done; agents cannot add notes to finished work`, {
          task: task.id,
        });
      }
      addNote(task, "note", requireText(op.text, "text_required", "a text"));
      break;
    }
    case "ask": {
      const task = get(op.task);
      if (task.state !== "doing")
        fail("invalid_transition", `${task.id} is ${task.state}; ask needs doing`, {
          task: task.id,
        });
      const options = (op.options ?? []).map((option) => option.trim());
      if (options.length === 1)
        fail("invalid", "Offer at least two options, or none", { task: task.id });
      if (new Set(options).size !== options.length)
        fail("invalid", "Options must be different from each other", { task: task.id });
      addNote(task, "question", requireText(op.text, "text_required", "a question"), options);
      break;
    }
    case "answer": {
      const task = get(op.task);
      if (!isWaiting(task))
        fail("not_waiting", `${task.id} has no open question`, { task: task.id });
      addNote(task, "answer", requireText(op.text, "text_required", "an answer"));
      break;
    }
    case "finish": {
      const task = get(op.task);
      const summary = requireText(op.summary, "summary_required", "a summary of what was done");
      transition(task, ["doing"], "done");
      addNote(task, "summary", summary);
      break;
    }
    case "set-templates": {
      if (op.templates.length > 0) doc.project.templates = structuredClone(op.templates);
      else delete doc.project.templates;
      break;
    }
    case "reopen": {
      const task = get(op.task);
      transition(task, ["done"], "todo");
      delete task.started;
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "undo": {
      if (op.changes.length === 0) fail("invalid", "undo needs at least one change");
      for (const change of op.changes) {
        const current = original.get(change.task);
        const now = current ? taskHash(current) : null;
        if (now !== change.after)
          fail(
            "conflict",
            change.after === null
              ? `${change.task} was created again since; undo would overwrite it`
              : `${change.task} changed since that action; undo would overwrite the newer change`,
            { task: change.task, ...(current ? { current } : {}) },
          );
        if (change.before && change.before.id !== change.task)
          fail("invalid", `undo: version is for ${change.before.id}, not ${change.task}`);
      }
      for (const change of op.changes) {
        const others = doc.tasks.filter((t) => t.id !== change.task);
        doc.tasks = change.before ? [...others, structuredClone(change.before)] : others;
        if (change.before) {
          index.set(change.task, change.before);
          // An undone deletion is no longer a deletion.
          forget(change.task);
        } else index.delete(change.task);
        changed.add(change.task);
      }
      break;
    }
    case "restore": {
      // Human-only: put back a previous version of a task (reverting an unapproved external change).
      if (op.version.id !== op.task)
        fail("invalid", `restore: version is for ${op.version.id}, not ${op.task}`);
      const version: Task = { ...structuredClone(op.version), updated_at: ctx.at };
      const position = doc.tasks.findIndex((t) => t.id === op.task);
      if (position >= 0) doc.tasks[position] = version;
      else doc.tasks.push(version);
      index.set(version.id, version);
      changed.add(version.id);
      forget(version.id);
      break;
    }
  }

  const result = validateDocument(doc);
  if (!result.ok)
    fail("invalid", `${op.op} would make the plan invalid: ${result.issues[0]?.message}`, {
      issues: result.issues,
    });
  return { ok: true, document: doc, changed: [...changed], created };
}
