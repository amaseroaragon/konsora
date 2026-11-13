/**
 * Semantic validation of a structurally valid `konsora/5` document (docs/esquema-tareas.md §3).
 * Reports every problem it finds, each located by JSON Pointer, and never throws.
 */
import { parseJsonText } from "./json-text.ts";
import {
  type ArchiveDocument,
  ArchiveSchema,
  type SchemaIssue,
  type Task,
  type TasksDocument,
  toPointer,
  validateStructure,
} from "./schema.ts";

export type ValidationResult =
  | { ok: true; document: TasksDocument }
  | { ok: false; issues: SchemaIssue[] };

/** Number part of a task id: `CORE-07` → 7. */
export function taskNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

export function validateSemantics(doc: TasksDocument): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: (string | number)[], code: string, message: string) =>
    issues.push({ path: toPointer(path), code, message });

  checkUnique(
    doc.project.templates?.map((t) => t.id),
    (j, id) =>
      add(
        ["project", "templates", j, "id"],
        "duplicate_template_id",
        `Template ${id} is defined twice`,
      ),
  );
  doc.project.templates?.forEach((template, j) => {
    checkUnique(template.labels, (k, label) =>
      add(
        ["project", "templates", j, "labels", k],
        "duplicate_label",
        `Template ${template.id} repeats label ${label}`,
      ),
    );
  });

  const groups = new Set<string>();
  doc.groups.forEach((group, i) => {
    if (groups.has(group.id))
      add(["groups", i, "id"], "duplicate_group", `Group ${group.id} is defined twice`);
    groups.add(group.id);
  });

  for (const key of Object.keys(doc.seq)) {
    if (!groups.has(key))
      add(["seq", key], "seq_unknown_group", `seq has an entry for unknown group ${key}`);
  }

  const milestones = new Set<string>();
  doc.milestones?.forEach((milestone, i) => {
    if (milestones.has(milestone.id))
      add(
        ["milestones", i, "id"],
        "duplicate_milestone",
        `Milestone ${milestone.id} is defined twice`,
      );
    milestones.add(milestone.id);
  });

  const indexById = new Map<string, number>();
  const maxNumber = new Map<string, number>();
  doc.tasks.forEach((task, i) => {
    if (indexById.has(task.id)) {
      add(
        ["tasks", i, "id"],
        "duplicate_id",
        `Task id ${task.id} is used twice; ids must be unique`,
      );
    } else {
      indexById.set(task.id, i);
    }
    if (!groups.has(task.group)) {
      add(
        ["tasks", i, "group"],
        "unknown_group",
        `Task ${task.id} belongs to unknown group ${task.group}`,
      );
    }
    const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
    if (!groups.has(prefix)) {
      add(
        ["tasks", i, "id"],
        "unknown_id_prefix",
        `Task id ${task.id} uses prefix ${prefix}, which is not a group`,
      );
    } else {
      maxNumber.set(prefix, Math.max(maxNumber.get(prefix) ?? 0, taskNumber(task.id)));
    }
    if (task.milestone !== undefined && !milestones.has(task.milestone))
      add(
        ["tasks", i, "milestone"],
        "unknown_milestone",
        `Task ${task.id} belongs to unknown milestone ${task.milestone}`,
      );
    checkUnique(task.deps, (j, dep) =>
      add(["tasks", i, "deps", j], "duplicate_dependency", `Task ${task.id} lists ${dep} twice`),
    );
    checkUnique(task.labels, (j, label) =>
      add(["tasks", i, "labels", j], "duplicate_label", `Task ${task.id} repeats label ${label}`),
    );
    checkUnique(
      task.acceptance?.map((a) => a.id),
      (j, id) =>
        add(
          ["tasks", i, "acceptance", j, "id"],
          "duplicate_acceptance_id",
          `Task ${task.id} repeats ${id}`,
        ),
    );
    checkUnique(
      task.notes?.map((n) => n.id),
      (j, id) =>
        add(
          ["tasks", i, "notes", j, "id"],
          "duplicate_note_id",
          `Task ${task.id} repeats note ${id}`,
        ),
    );
    task.notes?.forEach((note, j) => {
      if (note.evidence !== undefined) {
        if (note.kind !== "summary")
          add(
            ["tasks", i, "notes", j, "evidence"],
            "evidence_not_summary",
            `Note ${note.id} of ${task.id} has evidence, but only summaries can`,
          );
        checkUnique(
          note.evidence.map((e) => e.ac),
          (k, ac) =>
            add(
              ["tasks", i, "notes", j, "evidence", k, "ac"],
              "duplicate_evidence",
              `Summary ${note.id} of ${task.id} gives evidence for ${ac} twice`,
            ),
        );
      }
      if (note.options === undefined) return;
      if (note.kind !== "question")
        add(
          ["tasks", i, "notes", j, "options"],
          "options_not_question",
          `Note ${note.id} of ${task.id} has options, but only questions can`,
        );
      checkUnique(
        note.options.map((option) => option.trim()),
        (k, option) =>
          add(
            ["tasks", i, "notes", j, "options", k],
            "duplicate_option",
            `Question ${note.id} of ${task.id} repeats option "${option}"`,
          ),
      );
    });
  });

  checkUnique(doc.archived, (j, id) =>
    add(["archived", j], "duplicate_archived", `Task ${id} is listed as archived twice`),
  );
  doc.archived?.forEach((id, j) => {
    if (indexById.has(id)) {
      add(
        ["archived", j],
        "duplicate_id",
        `Task id ${id} is both in the plan and archived; ids must be unique`,
      );
    }
    const prefix = id.slice(0, id.lastIndexOf("-"));
    if (!groups.has(prefix)) {
      add(
        ["archived", j],
        "unknown_id_prefix",
        `Archived task id ${id} uses prefix ${prefix}, which is not a group`,
      );
    } else {
      maxNumber.set(prefix, Math.max(maxNumber.get(prefix) ?? 0, taskNumber(id)));
    }
  });
  const archived = new Set(doc.archived);

  for (const [group, max] of maxNumber) {
    const seq = doc.seq[group];
    if (seq === undefined) {
      add(
        ["seq"],
        "seq_missing",
        `seq has no entry for group ${group}, whose highest task number is ${max}`,
      );
    } else if (seq < max) {
      add(
        ["seq", group],
        "seq_behind",
        `seq.${group} is ${seq} but task ${group}-${pad(max)} exists; it must be ≥ ${max} so ids are never reused`,
      );
    }
  }

  doc.tasks.forEach((task, i) => {
    (task.deps ?? []).forEach((dep, j) => {
      if (dep === task.id) {
        add(["tasks", i, "deps", j], "self_dependency", `Task ${task.id} depends on itself`);
      } else if (!indexById.has(dep) && !archived.has(dep)) {
        add(
          ["tasks", i, "deps", j],
          "unknown_dependency",
          `Task ${task.id} depends on ${dep}, which does not exist`,
        );
      }
    });
  });

  for (const cycle of findCycles(doc.tasks, indexById)) {
    const first = cycle[0] as string;
    add(
      ["tasks", indexById.get(first) as number, "deps"],
      "cycle",
      `Dependency cycle: ${[...cycle, first].join(" → ")}`,
    );
  }

  return issues;
}

/** Largest `.konsora/archive.json` Konsora reads (it is not loaded by agents, so it may grow). */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export type ArchiveValidation =
  | { ok: true; archive: ArchiveDocument }
  | { ok: false; issues: SchemaIssue[] };

/** Validates `.konsora/archive.json`: its shape, unique ids and only done tasks. */
export function parseArchiveFile(input: string | Uint8Array): ArchiveValidation {
  const json = parseJsonText(input, MAX_ARCHIVE_BYTES);
  if (!json.ok) return json;
  const parsed = ArchiveSchema.safeParse(json.value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: toPointer(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  parsed.data.tasks.forEach((task, i) => {
    if (seen.has(task.id))
      issues.push({
        path: toPointer(["tasks", i, "id"]),
        code: "duplicate_id",
        message: `Task ${task.id} is archived twice`,
      });
    seen.add(task.id);
    if (task.state !== "done")
      issues.push({
        path: toPointer(["tasks", i, "state"]),
        code: "archived_not_done",
        message: `Archived task ${task.id} is ${task.state}; only done tasks are archived`,
      });
  });
  return issues.length ? { ok: false, issues } : { ok: true, archive: parsed.data };
}

/** Structure + semantics for an already-parsed JSON value. */
export function validateDocument(value: unknown): ValidationResult {
  const structure = validateStructure(value);
  if (!structure.ok) return structure;
  const issues = validateSemantics(structure.document);
  return issues.length === 0 ? { ok: true, document: structure.document } : { ok: false, issues };
}

/** Full pipeline for file contents: size, UTF-8, JSON, duplicate keys, structure, semantics. */
export function parseTasksFile(input: string | Uint8Array): ValidationResult {
  const json = parseJsonText(input);
  return json.ok ? validateDocument(json.value) : json;
}

function checkUnique(
  values: readonly string[] | undefined,
  onDuplicate: (index: number, value: string) => void,
) {
  const seen = new Set<string>();
  values?.forEach((value, index) => {
    if (seen.has(value)) onDuplicate(index, value);
    seen.add(value);
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Kahn's algorithm (iterative, so long chains cannot overflow the stack) finds tasks left in
 * cycles; then each cycle is extracted once by walking dependencies inside that leftover set.
 * Unknown and self dependencies are ignored here (reported separately).
 */
export function findCycles(
  tasks: readonly Task[],
  indexById: ReadonlyMap<string, number>,
): string[][] {
  const deps = new Map<string, string[]>();
  for (const task of tasks) {
    if (!deps.has(task.id)) {
      deps.set(
        task.id,
        [...new Set(task.deps ?? [])].filter((d) => d !== task.id && indexById.has(d)),
      );
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, list] of deps) {
    indegree.set(id, list.length);
    for (const dep of list) {
      const children = dependents.get(dep);
      if (children) children.push(id);
      else dependents.set(dep, [id]);
    }
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const child of dependents.get(id) ?? []) {
      const n = (indegree.get(child) as number) - 1;
      indegree.set(child, n);
      if (n === 0) queue.push(child);
    }
  }
  const remaining = new Set([...indegree].filter(([, n]) => n > 0).map(([id]) => id));

  const cycles: string[][] = [];
  const reported = new Set<string>();
  for (const start of [...remaining].sort()) {
    if (reported.has(start)) continue;
    // Walk dependencies inside `remaining`; every node there lies on or leads into a cycle.
    const order: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !position.has(current)) {
      position.set(current, order.length);
      order.push(current);
      current = (deps.get(current) ?? []).find((d) => remaining.has(d));
    }
    // `current` is the first repeated node (the cycle entry); undefined means no cycle closed.
    if (current === undefined) continue;
    const cycle = order.slice(position.get(current));
    if (cycle.some((id) => reported.has(id))) continue;
    for (const id of cycle) reported.add(id);
    cycles.push(cycle);
  }
  return cycles;
}
