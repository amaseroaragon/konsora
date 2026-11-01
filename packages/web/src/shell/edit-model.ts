/**
 * Editing approved work from the task panel (UI-09), as a pure model: the draft a form holds, the
 * single `edit` op it turns into, how a draft survives someone else changing the task meanwhile,
 * and the Spanish text for every way the daemon can refuse.
 */
import {
  type Acceptance,
  type AgentSpec,
  indexTasks,
  type Task,
  type TasksDocument,
  transitiveDeps,
} from "@konsora/core";
import { t } from "../i18n/index.ts";

export type DraftCriterion = { id?: string; text: string; check: string };
export type Draft = {
  title: string;
  desc: string;
  /** Comma-separated, as typed. */
  labels: string;
  group: string;
  acceptance: DraftCriterion[];
  /** The task's own agent; `null` while it uses the project's (the edit op can set, not clear). */
  agent: AgentSpec | null;
};
export type DraftField = keyof Draft;
export const draftFields: readonly DraftField[] = [
  "title",
  "desc",
  "labels",
  "group",
  "acceptance",
  "agent",
];

type Editable = Pick<Task, "id" | "title" | "desc" | "labels" | "group" | "acceptance"> &
  Partial<Pick<Task, "agent">>;

export function draftFrom(task: Editable): Draft {
  return {
    title: task.title,
    desc: task.desc ?? "",
    labels: (task.labels ?? []).join(", "),
    group: task.group,
    acceptance: (task.acceptance ?? []).map((ac) => ({
      id: ac.id,
      text: ac.text,
      check: ac.check ?? "",
    })),
    agent: task.agent ?? null,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fields of `draft` the human changed with respect to the version they started from. */
export function touchedFields(draft: Draft, base: Editable): DraftField[] {
  const start = draftFrom(base);
  return draftFields.filter((field) => !same(draft[field], start[field]));
}

export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
}

/** Criteria as stored: kept ids stay, new rows get the next free `acN`, empty rows go away. */
export function criteriaFrom(rows: readonly DraftCriterion[]): Acceptance[] {
  const used = new Set(rows.map((row) => row.id).filter((id): id is string => Boolean(id)));
  let next = Math.max(0, ...[...used].map((id) => Number.parseInt(id.slice(2), 10) || 0)) + 1;
  return rows
    .filter((row) => row.text.trim())
    .map((row) => {
      let id = row.id;
      if (!id) {
        while (used.has(`ac${next}`)) next++;
        id = `ac${next++}`;
      }
      const check = row.check.trim();
      return { id, text: row.text.trim(), ...(check ? { check } : {}) };
    });
}

export type EditChanges = Partial<Pick<Task, "title" | "desc" | "labels" | "group">> & {
  acceptance?: Acceptance[];
  agent?: AgentSpec;
};

export type DraftCheck =
  | { ok: true; changes: EditChanges; empty: boolean }
  | { ok: false; field: DraftField; message: string };

/**
 * The `changes` of one `edit` op: only the fields the human touched, checked first so that the
 * usual mistakes are explained before anything is sent.
 */
export function changesFrom(
  draft: Draft,
  base: Editable,
  groups: readonly { id: string }[],
  /** Why the draft's agent cannot run (`agentProblem`), if it cannot. */
  agentIssue?: string | null,
): DraftCheck {
  const touched = new Set(touchedFields(draft, base));
  const title = draft.title.trim();
  if (!title) return { ok: false, field: "title", message: t("edit.error.title.empty") };
  if (title.length > 120) return { ok: false, field: "title", message: t("edit.error.title.long") };
  if (draft.desc.length > 32_768)
    return { ok: false, field: "desc", message: t("edit.error.desc.long") };
  if (!groups.some((group) => group.id === draft.group))
    return { ok: false, field: "group", message: t("edit.error.group", { group: draft.group }) };
  if (draft.acceptance.some((row) => row.text.trim().length > 500))
    return { ok: false, field: "acceptance", message: t("edit.error.criterion.long") };
  if (draft.acceptance.some((row) => !row.text.trim() && row.check.trim()))
    return { ok: false, field: "acceptance", message: t("edit.error.criterion.empty") };
  const touchedAgent = touched.has("agent") && draft.agent !== null;
  if (touchedAgent && agentIssue) return { ok: false, field: "agent", message: agentIssue };
  const changes: EditChanges = {};
  if (touched.has("title") && title !== base.title) changes.title = title;
  if (touched.has("desc")) changes.desc = draft.desc.trim();
  if (touched.has("labels")) changes.labels = parseLabels(draft.labels);
  if (touched.has("group")) changes.group = draft.group;
  if (touched.has("acceptance")) changes.acceptance = criteriaFrom(draft.acceptance);
  if (touchedAgent && draft.agent) changes.agent = draft.agent;
  // A field typed back to what it was is not a change.
  const stored: Omit<Required<EditChanges>, "agent"> & { agent: AgentSpec | undefined } = {
    agent: base.agent,
    title: base.title,
    desc: base.desc ?? "",
    labels: base.labels ?? [],
    group: base.group,
    acceptance: base.acceptance ?? [],
  };
  for (const key of Object.keys(changes) as (keyof EditChanges)[])
    if (same(changes[key], stored[key])) delete changes[key];
  return { ok: true, changes, empty: Object.keys(changes).length === 0 };
}

/**
 * Someone changed the task while it was being edited. The draft moves onto the current version:
 * fields the human did not touch take the current values (so their change is not undone), and
 * fields they did touch keep the draft. Returns the fields both sides changed, to point them out.
 */
export function rebaseDraft(
  draft: Draft,
  base: Editable,
  current: Editable,
): { draft: Draft; clashes: DraftField[] } {
  const start = draftFrom(base);
  const now = draftFrom(current);
  const touched = new Set(touchedFields(draft, base));
  const next = { ...draft };
  const clashes: DraftField[] = [];
  for (const field of draftFields) {
    const theirs = !same(start[field], now[field]);
    if (!touched.has(field)) Object.assign(next, { [field]: now[field] });
    else if (theirs && !same(draft[field], now[field])) clashes.push(field);
  }
  return { draft: next, clashes };
}

/** Why `on` cannot become a dependency of `task`, in Spanish; null when it can. */
export function dependencyProblem(
  doc: Pick<TasksDocument, "tasks">,
  task: string,
  on: string,
): string | null {
  const index = indexTasks(doc);
  const target = index.get(on);
  if (!on) return t("edit.deps.error.empty");
  if (!target) return t("edit.deps.error.unknown", { on });
  if (on === task) return t("edit.deps.error.self", { id: task });
  if (index.get(task)?.deps?.includes(on)) return t("edit.deps.error.already", { id: task, on });
  if (transitiveDeps(on, index).has(task)) return t("edit.deps.error.cycle", { id: task, on });
  if (index.get(task)?.state === "done") return t("edit.deps.error.done", { id: task });
  return null;
}

/** The daemon's refusal of an edit, depend or undepend, in Spanish. */
export function editErrorText(
  error: { code: string; message: string; issues?: { code: string }[] },
  ctx: { id: string; on?: string },
): string {
  const issue = error.issues?.[0]?.code;
  if (error.code === "conflict") return t("edit.error.conflict", { id: ctx.id });
  if (error.code === "invalid" && /cycle/i.test(error.message))
    return t("edit.deps.error.cycle", { id: ctx.id, on: ctx.on ?? "" });
  if (error.code === "invalid" && issue === "unknown_group")
    return t("edit.error.group.server", { id: ctx.id });
  if (error.code === "invalid" && issue === "duplicate_label") return t("edit.error.labels");
  if (error.code === "invalid_transition") return t("edit.deps.error.done", { id: ctx.id });
  if (error.code === "not_found") return t("edit.error.notFound", { id: ctx.id });
  if (error.code === "forbidden") return t("edit.error.forbidden", { id: ctx.id });
  if (error.code === "bad_request") return t("edit.error.badRequest");
  if (error.code.startsWith("plan_")) return t("move.plan_unavailable");
  return t("edit.error.other", { id: ctx.id, message: error.message });
}
