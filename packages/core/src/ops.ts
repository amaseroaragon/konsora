/**
 * State machine and semantic operations (docs/esquema-tareas.md §2 and §5).
 *
 * Every change to a plan is an operation such as `approve BE-02` or `note BE-02 …`, applied by
 * `applyOp` to the latest document. Each op checks:
 * 1. the actor's role (human / agent / konsora) and, in a planning session, its scope;
 * 2. per-task preconditions: hashes of the tasks the client read (`expect`); if one of those
 *    tasks changed meanwhile → `conflict`, while changes to other tasks never conflict;
 * 3. the transition rules; and finally that the whole result still validates.
 * `applyOp` is pure: it never mutates its input.
 */
import {
  indexTasks,
  isBlocked,
  isWaiting,
  transitiveDeps,
  yoloChain,
  yoloCovering,
} from "./graph.ts";
import { contentHash } from "./hash.ts";
import { rankAfterAll } from "./rank.ts";
import type {
  Acceptance,
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
   * An agent in a planning session (`konsora plan` or the UI's AI panel): it may only propose
   * tasks and revise or withdraw proposals; it starts nothing and touches no approved work.
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
};

export type Op = Base &
  (
    | ({ op: "propose"; state?: "proposed" | "todo" } & NewTask)
    | { op: "batch"; groups?: { id: string; name: string }[]; tasks: NewTask[] }
    | { op: "add-group"; id: string; name: string }
    | { op: "approve"; task: string }
    | {
        op: "edit";
        task: string;
        changes: Partial<Pick<Task, "title" | "desc" | "labels" | "group" | "rank">> & {
          acceptance?: Acceptance[];
        };
      }
    | { op: "withdraw"; task: string }
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
    | { op: "accept"; task: string }
    | { op: "send-back"; task: string; feedback: string }
    | { op: "reopen"; task: string; text?: string }
    | { op: "set-yolo"; task: string; value: boolean }
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
  | "has_dependents"
  | "unknown_template"
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

/** Who may run each op (docs/esquema-tareas.md §2). */
const ROLES: Record<OpName, readonly Role[]> = {
  propose: ["human", "agent"],
  batch: ["human", "agent"],
  "add-group": ["human", "agent"],
  approve: ["human"],
  edit: ["human", "agent"], // agents: proposals only (checked below)
  withdraw: ["human", "agent"],
  depend: ["human", "agent"],
  undepend: ["human", "agent"], // agents: proposals only
  start: ["agent", "konsora"],
  pause: ["human", "agent", "konsora"],
  note: ["human", "agent", "konsora"],
  ask: ["agent"],
  answer: ["human"],
  finish: ["agent", "konsora"],
  "set-templates": ["human"],
  accept: ["human"],
  "send-back": ["human"],
  reopen: ["human"],
  "set-yolo": ["human"],
  restore: ["human"],
};

const EDITABLE = ["title", "desc", "acceptance", "labels", "group", "rank"] as const;

/** All an agent in a planning session may do. */
const PLAN_OPS: ReadonlySet<OpName> = new Set(["propose", "batch", "edit", "withdraw"]);

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

/**
 * The task is an intermediate task of an active YOLO chain (not the YOLO task itself): when its
 * agent finishes it, it goes straight to `done` instead of `review`.
 */
export function skipsReview(doc: Pick<TasksDocument, "tasks">, id: string): boolean {
  const task = doc.tasks.find((t) => t.id === id);
  return task !== undefined && !task.yolo && yoloCovering(id, doc).length > 0;
}

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
        `In a planning session you can only propose tasks and revise or withdraw proposals; ${op.op} is not available`,
        "task" in op ? { task: op.task } : {},
      );
    }
    const target = "task" in op ? original.get(op.task) : undefined;
    if (target && target.state !== "proposed") {
      fail(
        "out_of_scope",
        `In a planning session you can only change proposals; ${target.id} is ${target.state}`,
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
    doc.tasks.push(task);
    index.set(task.id, task);
    created.push(task.id);
    changed.add(task.id);
    return task;
  };

  switch (op.op) {
    case "propose": {
      const state = op.state ?? "proposed";
      if (state === "todo" && role !== "human")
        fail("forbidden", "Only humans can create approved tasks");
      for (const dep of op.deps ?? []) get(dep);
      createTask(op, state, op.deps ?? []);
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
        const task = createTask(spec, "proposed", deps);
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
    case "approve":
      transition(get(op.task), ["proposed"], "todo");
      break;
    case "edit": {
      const task = get(op.task);
      if (role !== "human" && task.state !== "proposed") {
        fail("forbidden", `${task.id} is approved; only humans can change approved work`, {
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
    case "withdraw": {
      const task = get(op.task);
      if (task.state !== "proposed") {
        fail("invalid_transition", `${task.id} is ${task.state}; only proposals can be withdrawn`, {
          task: task.id,
        });
      }
      const dependents = doc.tasks.filter((t) => t.deps?.includes(task.id)).map((t) => t.id);
      if (dependents.length) {
        fail(
          "has_dependents",
          `${task.id} is a dependency of ${dependents.join(", ")}; unlink them first`,
          {
            task: task.id,
          },
        );
      }
      doc.tasks = doc.tasks.filter((t) => t.id !== task.id);
      changed.add(task.id);
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
      if (role !== "human" && task.state !== "proposed") {
        fail("forbidden", `${task.id} is approved; only humans can remove its dependencies`, {
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
      // Inside an active YOLO chain, intermediate tasks skip review; the YOLO task itself does not.
      transition(task, ["doing"], skipsReview(input, task.id) ? "done" : "review");
      if (task.yolo) delete task.yolo; // YOLO ends when its task reaches review
      addNote(task, "summary", summary);
      break;
    }
    case "set-templates": {
      if (op.templates.length > 0) doc.project.templates = structuredClone(op.templates);
      else delete doc.project.templates;
      break;
    }
    case "accept":
      transition(get(op.task), ["review"], "done");
      break;
    case "send-back": {
      const task = get(op.task);
      const feedback = requireText(op.feedback, "feedback_required", "feedback for the agent");
      transition(task, ["review"], "todo");
      addNote(task, "feedback", feedback);
      break;
    }
    case "reopen": {
      const task = get(op.task);
      transition(task, ["done"], "todo");
      if (op.text?.trim()) addNote(task, "note", op.text);
      break;
    }
    case "set-yolo": {
      const task = get(op.task);
      if (task.state === "done")
        fail("invalid_transition", `${task.id} is done; YOLO only applies to unfinished work`);
      if (op.value) {
        task.yolo = true;
        // Turning YOLO on approves the chain's proposals.
        for (const id of yoloChain(task, index)) {
          const member = index.get(id);
          if (member?.state === "proposed") {
            member.state = "todo";
            touch(member);
          }
        }
      } else {
        delete task.yolo;
      }
      touch(task);
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
