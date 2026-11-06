/**
 * The project's check settings form (UI-17) as a pure model: the draft it holds, its
 * validation (the same rules as core's schema, explained in Spanish and by field), the
 * `set-checks` op it turns into (only what changed) and where the daemon's errors belong.
 */
import {
  DEFAULT_CHECK_RETRIES,
  DEFAULT_CHECK_TIMEOUT_S,
  MAX_CHECK_RETRIES,
  type Project,
} from "@konsora/core";
import { t } from "../i18n/index.ts";

/** `key` identifies the row while it is edited (ids can be typed over), for React. */
export type DraftCheck = { key: string; id: string; run: string; timeout: string };
export type SettingsDraft = {
  checks: DraftCheck[];
  /** As typed; empty means the default. */
  retries: string;
  setupRun: string;
  setupTimeout: string;
};

/** Field keys: `retries`, `setup.run`, `setup.timeout`, `checks`, `checks.<i>.<id|run|timeout>`. */
export type FieldErrors = Record<string, string>;

const SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_TIMEOUT_S = 86_400;

export function settingsFrom(project: Pick<Project, "checks" | "check_retries" | "setup">) {
  return {
    checks: (project.checks ?? []).map((check, index) => ({
      key: `saved-${index}`,
      id: check.id,
      run: check.run,
      timeout: check.timeout_s !== undefined ? String(check.timeout_s) : "",
    })),
    retries: project.check_retries !== undefined ? String(project.check_retries) : "",
    setupRun: project.setup?.run ?? "",
    setupTimeout: project.setup?.timeout_s !== undefined ? String(project.setup.timeout_s) : "",
  } satisfies SettingsDraft;
}

export const defaults = {
  retries: DEFAULT_CHECK_RETRIES,
  timeout: DEFAULT_CHECK_TIMEOUT_S,
  maxRetries: MAX_CHECK_RETRIES,
};

/** A whole number in [min, max] typed as text; `undefined` if empty, `null` if invalid. */
function whole(text: string, min: number, max: number): number | undefined | null {
  const value = text.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** Moves the check at `from` one place up (-1) or down (+1). */
export function moveCheck(checks: readonly DraftCheck[], from: number, by: -1 | 1): DraftCheck[] {
  const to = from + by;
  if (to < 0 || to >= checks.length) return [...checks];
  const next = [...checks];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

export type SettingsOp = {
  op: "set-checks";
  checks?: { id: string; run: string; timeout_s?: number }[];
  check_retries?: number | null;
  setup?: { run: string; timeout_s?: number } | null;
};

/**
 * Validates the draft and builds the `set-checks` op with only the parts that changed with
 * respect to `base`. `op` is null when nothing changed.
 */
export function settingsOp(
  draft: SettingsDraft,
  base: Pick<Project, "checks" | "check_retries" | "setup">,
): { ok: true; op: SettingsOp | null } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const seen = new Set<string>();
  const checks = draft.checks.map((row, i) => {
    const id = row.id.trim();
    const run = row.run.trim();
    if (!SLUG.test(id)) errors[`checks.${i}.id`] = t("settings.error.id");
    else if (seen.has(id)) errors[`checks.${i}.id`] = t("settings.error.id.twice", { id });
    seen.add(id);
    if (!run) errors[`checks.${i}.run`] = t("settings.error.run.empty");
    else if (run.length > 1000) errors[`checks.${i}.run`] = t("settings.error.run.long");
    const timeout = whole(row.timeout, 1, MAX_TIMEOUT_S);
    if (timeout === null) errors[`checks.${i}.timeout`] = t("settings.error.timeout");
    return { id, run, ...(typeof timeout === "number" ? { timeout_s: timeout } : {}) };
  });
  const retries = whole(draft.retries, 0, MAX_CHECK_RETRIES);
  if (retries === null) errors.retries = t("settings.error.retries", { max: MAX_CHECK_RETRIES });
  const setupRun = draft.setupRun.trim();
  if (setupRun.length > 1000) errors["setup.run"] = t("settings.error.run.long");
  const setupTimeout = whole(draft.setupTimeout, 1, MAX_TIMEOUT_S);
  if (setupTimeout === null) errors["setup.timeout"] = t("settings.error.timeout");
  if (!setupRun && draft.setupTimeout.trim()) errors["setup.run"] = t("settings.error.setup.empty");
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const op: SettingsOp = { op: "set-checks" };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(checks, base.checks ?? [])) op.checks = checks;
  if ((retries ?? undefined) !== base.check_retries) op.check_retries = retries ?? null;
  const setup = setupRun
    ? { run: setupRun, ...(typeof setupTimeout === "number" ? { timeout_s: setupTimeout } : {}) }
    : null;
  if (!same(setup, base.setup ?? null)) op.setup = setup;
  return { ok: true, op: Object.keys(op).length > 1 ? op : null };
}

/**
 * Where the daemon's refusal belongs: an issue's JSON Pointer (`/project/checks/1/id`) or a
 * bad request's path (`checks.1.id`) becomes a field key; anything else goes to the form.
 */
export function serverErrors(error: {
  code: string;
  message: string;
  issues?: { path: string; message: string }[] | undefined;
}): { fields: FieldErrors; form: string | null } {
  const fields: FieldErrors = {};
  /** The field a path points at, or null if it is not one of this form's. */
  const fieldOf = (path: string[]): string | null => {
    const [head, index, leaf] = path;
    if (head === "check_retries") return "retries";
    if (head === "setup") return index === "timeout_s" ? "setup.timeout" : "setup.run";
    if (head !== "checks") return null;
    if (index === undefined || !/^\d+$/.test(index) || !leaf) return "checks";
    return `checks.${index}.${leaf === "timeout_s" ? "timeout" : leaf}`;
  };
  const place = (path: string[], message: string): boolean => {
    const field = fieldOf(path);
    if (field) fields[field] = message;
    return field !== null;
  };
  let placed = false;
  for (const issue of error.issues ?? []) {
    const path = issue.path.split("/").filter(Boolean);
    if (path[0] === "project") placed = place(path.slice(1), issue.message) || placed;
  }
  const bad = /^Invalid op at ([\w.]+): (.*)$/.exec(error.message);
  if (error.code === "bad_request" && bad?.[1]) {
    placed = place(bad[1].split("."), bad[2] ?? error.message) || placed;
  }
  if (placed) return { fields, form: null };
  return {
    fields,
    form:
      error.code === "forbidden"
        ? t("settings.error.forbidden")
        : error.code.startsWith("plan_")
          ? t("move.plan_unavailable")
          : t("settings.error.other", { message: error.message }),
  };
}
