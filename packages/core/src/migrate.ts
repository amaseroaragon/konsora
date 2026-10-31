/**
 * Migration from the v0 format (`schema_version: 1`) to `konsora/2` (docs/esquema-tareas.md §7).
 * Pure: the CLI decides whether to write (dry-run by default).
 */
import { z } from "zod";
import { rankAfterAll } from "./rank.ts";
import type { Acceptance, Note, Task, TaskState, TasksDocument } from "./schema.ts";
import { GroupIdSchema, TaskIdSchema } from "./schema.ts";
import { validateDocument } from "./semantics.ts";
import { compareTaskIds } from "./serialize.ts";

const V1Task = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(""),
  acceptance_criteria: z.string().optional().default(""),
  sort_order: z.number().int().optional().default(0),
  status: z.enum(["proposal", "pending", "in_progress", "in_review", "done"]),
  version: z.number().int().optional(),
  dependencies: z.array(z.string()).optional().default([]),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

export const V1DocumentSchema = z.looseObject({
  schema_version: z.literal(1),
  tasks: z.array(V1Task),
  attempts: z.array(z.unknown()).optional().default([]),
  activity: z.array(z.unknown()).optional().default([]),
  reviews: z.array(z.unknown()).optional().default([]),
});

export function isV1(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema_version?: unknown }).schema_version === 1
  );
}

const STATE: Record<z.infer<typeof V1Task>["status"], TaskState> = {
  proposal: "proposed",
  pending: "todo",
  in_progress: "todo", // no v1 run is alive after migrating
  in_review: "review",
  done: "done",
};

export type MigrationOptions = { name: string; baseBranch: string; at: string };

export type MigrationReport = {
  tasks: number;
  states: Record<string, { from: string; to: TaskState; count: number }>;
  groups: string[];
  renumbered: { from: string; to: string }[];
  criteriaInDescription: string[];
  history: { attempts: number; activity: number; reviews: number };
};

export type MigrationResult =
  | { ok: true; document: TasksDocument; history: Record<string, unknown>; report: MigrationReport }
  | { ok: false; message: string };

/** Splits free-text criteria into items: bullet lines if any, otherwise paragraphs. */
export function splitCriteria(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.split("\n");
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
  if (lines.some((l) => bullet.test(l))) {
    const items: string[] = [];
    for (const line of lines) {
      if (bullet.test(line)) items.push(line.replace(bullet, "").trim());
      else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`;
      else if (line.trim()) items.push(line.trim());
    }
    return items.filter(Boolean);
  }
  return trimmed
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

function toUtcSeconds(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function migrateV1(value: unknown, options: MigrationOptions): MigrationResult {
  const parsed = V1DocumentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `Not a valid v1 plan at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    };
  }
  const v1 = parsed.data;
  const ordered = v1.tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => a.task.sort_order - b.task.sort_order || a.index - b.index);

  // Ids: keep GROUP-NN ids (a group per prefix); renumber the rest into group T.
  const idMap = new Map<string, string>();
  const groups = new Map<string, number>();
  const renumbered: { from: string; to: string }[] = [];
  for (const { task } of ordered) {
    if (TaskIdSchema.safeParse(task.id).success) {
      const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
      const n = Number(task.id.slice(task.id.lastIndexOf("-") + 1));
      groups.set(prefix, Math.max(groups.get(prefix) ?? 0, n));
      idMap.set(task.id, task.id);
    }
  }
  const fallback = groups.has("T") ? "MIG" : "T";
  for (const { task } of ordered) {
    if (idMap.has(task.id)) continue;
    const n = (groups.get(fallback) ?? 0) + 1;
    groups.set(fallback, n);
    const id = `${fallback}-${String(n).padStart(2, "0")}`;
    idMap.set(task.id, id);
    renumbered.push({ from: task.id, to: id });
  }
  for (const prefix of groups.keys()) {
    if (!GroupIdSchema.safeParse(prefix).success)
      return { ok: false, message: `Group prefix ${prefix} is not a valid v2 group id` };
  }

  const states: MigrationReport["states"] = {};
  const criteriaInDescription: string[] = [];
  const ranks: string[] = [];
  const tasks: Task[] = ordered.map(({ task }) => {
    const id = idMap.get(task.id) as string;
    const notes: Note[] = [];
    const note = (text: string) =>
      notes.push({ id: `n${notes.length + 1}`, at: options.at, by: "konsora", kind: "note", text });
    const state = STATE[task.status];
    const key = `${task.status}→${state}`;
    states[key] = { from: task.status, to: state, count: (states[key]?.count ?? 0) + 1 };

    const title =
      task.title
        .replace(new RegExp(`^${task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[—–:-]\\s*`), "")
        .trim() || task.title;
    let desc = task.description.trim();
    let acceptance: Acceptance[] | undefined;
    const items = splitCriteria(task.acceptance_criteria);
    if (items.some((item) => item.length > 500)) {
      // Too long for v2 criteria: keep the text, losslessly, in the description.
      desc = `${desc}${desc ? "\n\n" : ""}## Acceptance criteria (v1)\n\n${task.acceptance_criteria.trim()}`;
      criteriaInDescription.push(id);
    } else if (items.length) {
      acceptance = items.map((text, i) => ({ id: `ac${i + 1}`, text }));
    }

    if (task.status === "in_progress")
      note("Migrated from v1 as todo: it was in_progress, but no v1 run survives the migration.");
    if (id !== task.id) note(`Migrated from v1 id ${task.id}.`);
    if (criteriaInDescription.includes(id))
      note("Acceptance criteria were longer than 500 characters; kept in the description.");

    const rank = rankAfterAll(ranks);
    ranks.push(rank);
    const created = toUtcSeconds(task.created_at) ?? options.at;
    const v2: Task = {
      id,
      title: title.slice(0, 120),
      state,
      group: id.slice(0, id.lastIndexOf("-")),
      rank,
      created: { at: created, by: "konsora" },
      updated_at: toUtcSeconds(task.updated_at) ?? created,
    };
    const deps = task.dependencies.map((d) => idMap.get(d) ?? d);
    if (deps.length) v2.deps = deps;
    if (desc) v2.desc = desc;
    if (acceptance) v2.acceptance = acceptance;
    if (notes.length) v2.notes = notes;
    return v2;
  });

  const groupIds = [...groups.keys()].sort();
  const document: TasksDocument = {
    schema: "konsora/2",
    project: { name: options.name, base_branch: options.baseBranch },
    groups: groupIds.map((id) => ({ id, name: id })),
    seq: Object.fromEntries(groupIds.map((id) => [id, groups.get(id) ?? 0])),
    tasks: tasks.sort((a, b) => compareTaskIds(a.id, b.id)),
  };
  const valid = validateDocument(document);
  if (!valid.ok)
    return {
      ok: false,
      message: `Migration produced an invalid plan: ${valid.issues[0]?.path} ${valid.issues[0]?.message}`,
    };

  const history = {
    migrated_at: options.at,
    from: "schema_version 1",
    attempts: v1.attempts,
    activity: v1.activity,
    reviews: v1.reviews,
  };
  return {
    ok: true,
    document: valid.document,
    history,
    report: {
      tasks: tasks.length,
      states,
      groups: groupIds,
      renumbered,
      criteriaInDescription,
      history: {
        attempts: v1.attempts.length,
        activity: v1.activity.length,
        reviews: v1.reviews.length,
      },
    },
  };
}
