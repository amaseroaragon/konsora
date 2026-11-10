/**
 * The project's task templates form (UI-22) as a pure model: the draft it holds, its validation
 * (core's `TemplateSchema` and the plan's uniqueness rules, explained in Spanish and by field),
 * the `set-templates` op it turns into and where the daemon's errors belong.
 */
import { type Difficulty, type Template, TemplateSchema } from "@konsora/core";
import { t } from "../i18n/index.ts";
import type { FieldErrors } from "./settings-model.ts";

/** `key` identifies a row while it is edited, for React. */
export type DraftCriterion = { key: string; text: string; check: string };
export type DraftTemplate = {
  key: string;
  id: string;
  name: string;
  desc: string;
  criteria: DraftCriterion[];
  /** As typed: labels separated by commas or spaces. */
  labels: string;
  difficulty: "" | Difficulty;
};

export const TEMPLATE_LIMITS = {
  templates: 100,
  criteria: 50,
  name: 60,
  desc: 32_768,
  text: 500,
  check: 1000,
} as const;

const SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function templatesFrom(templates: readonly Template[] | undefined): DraftTemplate[] {
  return (templates ?? []).map((template, i) => ({
    key: `saved-${i}`,
    id: template.id,
    name: template.name,
    desc: template.desc ?? "",
    criteria: (template.acceptance ?? []).map((ac, j) => ({
      key: `saved-${i}-${j}`,
      text: ac.text,
      check: ac.check ?? "",
    })),
    labels: (template.labels ?? []).join(", "),
    difficulty: template.difficulty ?? "",
  }));
}

/** The labels typed in the field, in order. */
export function parseLabels(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** The template a draft saves, with only the fields that have a value. */
function templateOf(draft: DraftTemplate): Template {
  const desc = draft.desc.trim();
  const labels = parseLabels(draft.labels);
  const acceptance = draft.criteria.map((row) => {
    const check = row.check.trim();
    return { text: row.text.trim(), ...(check ? { check } : {}) };
  });
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(desc ? { desc } : {}),
    ...(acceptance.length > 0 ? { acceptance } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(draft.difficulty ? { difficulty: draft.difficulty } : {}),
  };
}

/** The Spanish message for a field, by its last segment (what the form shows next to it). */
function fieldText(field: string): string {
  const leaf = field.split(".").at(-1);
  switch (leaf) {
    case "id":
      return t("templates.error.id");
    case "name":
      return t("templates.error.name", { max: TEMPLATE_LIMITS.name });
    case "desc":
      return t("templates.error.desc", { max: TEMPLATE_LIMITS.desc });
    case "text":
      return t("templates.error.criterion", { max: TEMPLATE_LIMITS.text });
    case "check":
      return t("templates.error.check", { max: TEMPLATE_LIMITS.check });
    case "labels":
      return t("templates.error.labels");
    case "difficulty":
      return t("templates.error.difficulty");
    default:
      return t("templates.error.invalid");
  }
}

/**
 * The form field a path inside one template points at (`["acceptance", 1, "text"]` →
 * `templates.<i>.criteria.1.text`), or the template's own key when it points at none.
 */
function templateField(index: number, path: readonly PropertyKey[]): string {
  const [head, j, leaf] = path.map(String);
  const at = `templates.${index}`;
  if (
    head === "acceptance" &&
    j !== undefined &&
    /^\d+$/.test(j) &&
    (leaf === "text" || leaf === "check")
  )
    return `${at}.criteria.${j}.${leaf}`;
  if (head === "acceptance") return `${at}.criteria`;
  if (
    head === "id" ||
    head === "name" ||
    head === "desc" ||
    head === "labels" ||
    head === "difficulty"
  )
    return `${at}.${head}`;
  return at;
}

export type TemplatesOp = { op: "set-templates"; templates: Template[] };

/**
 * Validates the drafts with the same rules as core and builds the `set-templates` op with the
 * whole list. `op` is null when nothing changed with respect to `base`.
 */
export function templatesOp(
  drafts: readonly DraftTemplate[],
  base: readonly Template[] | undefined,
): { ok: true; op: TemplatesOp | null } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const set = (field: string, message = fieldText(field)) => {
    errors[field] ??= message;
  };
  if (drafts.length > TEMPLATE_LIMITS.templates) {
    errors.templates = t("templates.error.many", { max: TEMPLATE_LIMITS.templates });
  }
  const seen = new Set<string>();
  const templates = drafts.map((draft, i) => {
    const template = templateOf(draft);
    const at = `templates.${i}`;
    // The checks people trip over first, with their own wording.
    if (!SLUG.test(template.id)) set(`${at}.id`);
    else if (seen.has(template.id))
      set(`${at}.id`, t("templates.error.id.twice", { id: template.id }));
    seen.add(template.id);
    if (!template.name || template.name.length > TEMPLATE_LIMITS.name) set(`${at}.name`);
    if (draft.criteria.length > TEMPLATE_LIMITS.criteria) {
      set(`${at}.criteria`, t("templates.error.criteria.many", { max: TEMPLATE_LIMITS.criteria }));
    }
    draft.criteria.forEach((row, j) => {
      const text = row.text.trim();
      if (!text || text.length > TEMPLATE_LIMITS.text) set(`${at}.criteria.${j}.text`);
      if (row.check.trim().length > TEMPLATE_LIMITS.check) set(`${at}.criteria.${j}.check`);
    });
    const labels = template.labels ?? [];
    const bad = labels.find((label) => !LABEL.test(label));
    const twice = labels.find((label, k) => labels.indexOf(label) !== k);
    if (bad) set(`${at}.labels`, t("templates.error.label", { label: bad }));
    else if (twice) set(`${at}.labels`, t("templates.error.label.twice", { label: twice }));
    // Whatever else core's schema refuses, on the field it points at.
    const parsed = TemplateSchema.safeParse(template);
    if (!parsed.success) for (const issue of parsed.error.issues) set(templateField(i, issue.path));
    return template;
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const same = JSON.stringify(templates) === JSON.stringify(base ?? []);
  return { ok: true, op: same ? null : { op: "set-templates", templates } };
}

/** Moves the row at `from` one place up (-1) or down (+1). */
export function moveRow<T>(rows: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * Where the daemon's refusal belongs: an issue's JSON Pointer (`/project/templates/1/id`) or a
 * bad request's path (`templates.1.name`) becomes a field, with its Spanish message; anything
 * else goes to the form.
 */
export function templatesServerErrors(error: {
  code: string;
  message: string;
  issues?: { path: string; code?: string; message: string }[] | undefined;
}): { fields: FieldErrors; form: string | null } {
  const fields: FieldErrors = {};
  const place = (path: string[], code: string | undefined): boolean => {
    const [head, index, ...rest] = path;
    if (head !== "templates" || index === undefined || !/^\d+$/.test(index)) return false;
    const field = templateField(Number(index), rest);
    if (field in fields) return true;
    if (code === "duplicate_template_id") {
      fields[field] = t("templates.error.id.twice.server");
    } else if (code === "duplicate_label") {
      fields[field] = t("templates.error.label.twice.server");
    } else {
      fields[field] = fieldText(field);
    }
    return true;
  };
  let placed = false;
  for (const issue of error.issues ?? []) {
    const path = issue.path.split("/").filter(Boolean);
    if (path[0] === "project") placed = place(path.slice(1), issue.code) || placed;
  }
  const bad = /^Invalid op at ([\w.]+): /.exec(error.message);
  if (error.code === "bad_request" && bad?.[1]) {
    placed = place(bad[1].split("."), undefined) || placed;
  }
  if (placed) return { fields, form: null };
  return {
    fields,
    form:
      error.code === "forbidden"
        ? t("settings.error.forbidden")
        : error.code.startsWith("plan_")
          ? t("move.plan_unavailable")
          : t("templates.error.other", { message: error.message }),
  };
}
