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
import { blockProgress, indexTasks, isBlocked, isWaiting, transitiveDeps } from "./graph.ts";
import { contentHash } from "./hash.ts";
import { rankAfterAll } from "./rank.ts";
import type {
  Acceptance,
  Block,
  MergeStrategy,
  Note,
  NoteKind,
  SchemaIssue,
  Task,
  TaskState,
  TasksDocument,
  Template,
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
   * revise and delete tasks nobody started yet, and set up blocks; it starts nothing.
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
  /**
   * A template of `project.templates` the task starts from: its own desc replaces the
   * template's, its criteria come after the template's and its labels join them.
   */
  template?: string;
  /** A block id (existing, or created in the same batch). */
  block?: string;
};

export type NewBlock = { id: string; name: string; branch?: string; base: string };

/** A block's base when git cannot say (no repository, detached HEAD). */
export const DEFAULT_BASE_BRANCH = "main";

/** The branch a block uses when none is given. */
export const defaultBranch = (id: string) => `konsora/${id}`;

export type Op = Base &
  (
    | ({ op: "propose"; state?: "proposed" | "todo" } & NewTask)
    | {
        op: "batch";
        groups?: { id: string; name: string }[];
        blocks?: NewBlock[];
        /** `idea: true` creates that task as an idea (`proposed`) instead of in `todo`. */
        tasks: (NewTask & { idea?: boolean })[];
      }
    | { op: "add-group"; id: string; name: string }
    /** An idea (`proposed`) becomes work to do. Anyone may do it: there is no approval. */
    | { op: "promote"; task: string }
    | {
        op: "edit";
        task: string;
        changes: Partial<Pick<Task, "title" | "desc" | "labels" | "group" | "rank">> & {
          acceptance?: Acceptance[];
        };
      }
    /** Removes a task; tasks that depended on it lose that dependency (with a note). */
    | { op: "delete"; task: string }
    | { op: "depend"; task: string; on: string }
    | { op: "undepend"; task: string; on: string }
    | { op: "start"; task: string; text?: string }
    | { op: "pause"; task: string; text?: string }
    | { op: "note"; task: string; text: string }
    | { op: "ask"; task: string; text: string }
    | { op: "answer"; task: string; text: string }
    | { op: "finish"; task: string; summary: string }
    /** The human sets the project's task templates (it replaces them all); `[]` removes them. */
    | { op: "set-templates"; templates: Template[] }
    | { op: "reopen"; task: string; text?: string }
    | ({ op: "add-block" } & NewBlock)
    | {
        op: "edit-block";
        block: string;
        changes: Partial<Pick<Block, "name" | "branch" | "base">>;
      }
    /** The human removes a block that was not merged; its tasks stay, outside any block. */
    | { op: "delete-block"; block: string }
    /** Puts a task in a block, or takes it out with `block: null`. */
    | { op: "set-block"; task: string; block: string | null }
    /**
     * Records that the human merged a ready block (the daemon did the git merge first). The block
     * is closed from then on: no task joins, leaves or reopens in it.
     */
    | { op: "mark-merged"; block: string; commit: string; strategy: MergeStrategy }
    | { op: "restore"; task: string; version: Task }
  );

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
  | "unknown_block"
  | "block_merged"
  | "block_not_ready"
  | "invalid";

export type OpError = {
  code: OpErrorCode;
  message: string;
  task?: string;
  /** The block it is about, for block errors. */
  block?: string;
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

/** Who may run each op (docs/esquema-tareas.md §2). */
const ROLES: Record<OpName, readonly Role[]> = {
  propose: ["human", "agent"],
  batch: ["human", "agent"],
  "add-group": ["human", "agent"],
  promote: ["human", "agent"],
  edit: ["human", "agent"], // agents: unfinished tasks only (checked below)
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
  "add-block": ["human", "agent"],
  "edit-block": ["human", "agent"],
  "delete-block": ["human"],
  "set-block": ["human", "agent"], // agents: unfinished tasks only
  "mark-merged": ["human"],
  restore: ["human"],
};

const EDITABLE = ["title", "desc", "acceptance", "labels", "group", "rank"] as const;

/** All an agent in a planning session may do. */
const PLAN_OPS: ReadonlySet<OpName> = new Set([
  "propose",
  "batch",
  "edit",
  "delete",
  "depend",
  "undepend",
  "promote",
  "add-block",
  "edit-block",
  "set-block",
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
        `In a planning session you can only plan: create, revise and delete tasks nobody started, and set up blocks; ${op.op} is not available`,
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
  const addNote = (task: Task, kind: NoteKind, text: string) => {
    const body = text.trim();
    const notes = task.notes ?? [];
    const next = Math.max(0, ...notes.map((n) => Number(n.id.slice(1)))) + 1;
    const note: Note = { id: `n${next}`, at: ctx.at, by: ctx.actor, kind, text: body };
    task.notes = [...notes, note];
    touch(task);
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
  };
  const requireText = (value: string | undefined, code: OpErrorCode, what: string): string => {
    if (!value?.trim()) fail(code, `${op.op} requires ${what}`);
    return value as string;
  };
  const getBlock = (id: string): Block =>
    doc.blocks?.find((b) => b.id === id) ??
    fail("unknown_block", `Block ${id} does not exist`, { block: id });
  const openBlock = (id: string): Block => {
    const block = getBlock(id);
    if (block.merged)
      fail("block_merged", `Block ${id} is already merged; it takes no more changes`, {
        block: id,
      });
    return block;
  };
  const addBlock = (spec: NewBlock) => {
    if (doc.blocks?.some((b) => b.id === spec.id))
      fail("invalid", `Block ${spec.id} already exists`, { block: spec.id });
    const block: Block = {
      id: spec.id,
      name: spec.name.trim(),
      branch: spec.branch?.trim() || defaultBranch(spec.id),
      base: spec.base.trim(),
      created: { at: ctx.at, by: ctx.actor },
    };
    doc.blocks = [...(doc.blocks ?? []), block];
  };
  /** A task in a merged block is closed: it can neither leave it nor be reopened. */
  const inMergedBlock = (task: Task) =>
    task.block !== undefined && doc.blocks?.find((b) => b.id === task.block)?.merged !== undefined;
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
    if (spec.block) task.block = openBlock(spec.block).id;
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
      for (const block of op.blocks ?? []) addBlock(block);
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
    case "promote":
      transition(get(op.task), ["proposed"], "todo");
      break;
    case "edit": {
      const task = get(op.task);
      if (role !== "human" && task.state === "done") {
        fail("forbidden", `${task.id} is done; only humans can change finished work`, {
          task: task.id,
        });
      }
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
      if (inMergedBlock(task))
        fail("block_merged", `${task.id} belongs to merged block ${task.block}; it stays`, {
          task: task.id,
          block: task.block as string,
        });
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
      for (const dependent of doc.tasks.filter((t) => t.deps?.includes(task.id))) {
        dependent.deps = (dependent.deps ?? []).filter((d) => d !== task.id);
        if (dependent.deps.length === 0) delete dependent.deps;
        addNote(dependent, "note", `Dependency ${task.id} (${task.title}) was deleted.`);
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
      }
      break;
    }
    case "start": {
      const task = get(op.task);
      if (task.state === "todo" && isBlocked(task, index)) {
        const pending = (task.deps ?? []).filter((d) => index.get(d)?.state !== "done");
        fail("blocked", `${task.id} is blocked by ${pending.join(", ")}`, { task: task.id });
      }
      transition(task, ["todo"], "doing");
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "pause": {
      const task = get(op.task);
      transition(task, ["doing"], "todo");
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
      addNote(task, "question", requireText(op.text, "text_required", "a question"));
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
      if (inMergedBlock(task))
        fail(
          "block_merged",
          `${task.id} belongs to merged block ${task.block}; create a new task instead`,
          {
            task: task.id,
            block: task.block as string,
          },
        );
      transition(task, ["done"], "todo");
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "add-block": {
      addBlock(op);
      break;
    }
    case "edit-block": {
      const block = openBlock(op.block);
      const unknown = Object.keys(op.changes).filter(
        (k) => !["name", "branch", "base"].includes(k),
      );
      if (unknown.length) fail("forbidden", `edit-block cannot change ${unknown.join(", ")}`);
      if (op.changes.name !== undefined) block.name = op.changes.name.trim();
      if (op.changes.branch !== undefined) block.branch = op.changes.branch.trim();
      if (op.changes.base !== undefined) block.base = op.changes.base.trim();
      break;
    }
    case "delete-block": {
      openBlock(op.block);
      doc.blocks = (doc.blocks ?? []).filter((b) => b.id !== op.block);
      if (doc.blocks.length === 0) delete doc.blocks;
      for (const task of doc.tasks.filter((t) => t.block === op.block)) {
        delete task.block;
        touch(task);
      }
      break;
    }
    case "set-block": {
      const task = get(op.task);
      if (role !== "human" && task.state === "done")
        fail("forbidden", `${task.id} is done; only humans can move finished work`, {
          task: task.id,
        });
      if (task.block !== undefined) openBlock(task.block);
      if (op.block === null) delete task.block;
      else task.block = openBlock(op.block).id;
      touch(task);
      break;
    }
    case "mark-merged": {
      const block = openBlock(op.block);
      const progress = blockProgress(input, block.id);
      if (progress.status !== "ready")
        fail(
          "block_not_ready",
          `Block ${block.id} is not ready to merge: ${progress.done} of ${progress.tasks.length} tasks done`,
          { block: block.id },
        );
      block.merged = { at: ctx.at, by: ctx.actor, commit: op.commit, strategy: op.strategy };
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
