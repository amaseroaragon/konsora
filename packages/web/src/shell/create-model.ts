/**
 * Creating a task from the UI, as a pure model: the draft the form holds and the `propose` op it
 * turns into. The human creates approved work directly (`state: "todo"`), or a proposal.
 */
import type { Difficulty, Template } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { type DraftCriterion, parseLabels } from "./edit-model.ts";

export type CreateDraft = {
  title: string;
  desc: string;
  group: string;
  acceptance: DraftCriterion[];
  /** Comma-separated, as typed. */
  labels: string;
  /** Comma-separated task ids, as typed. */
  deps: string;
  /** A template id, or empty for none. */
  template: string;
  /** Approved work (`todo`) or a proposal to approve later. */
  state: "todo" | "proposed";
  /** A level, or empty for none (CORE-22). */
  difficulty: Difficulty | "";
};

export function emptyDraft(group: string): CreateDraft {
  return {
    title: "",
    desc: "",
    group,
    acceptance: [],
    labels: "",
    deps: "",
    template: "",
    state: "todo",
    difficulty: "",
  };
}

export type CreateField = "title" | "desc" | "group" | "acceptance" | "deps" | "template";

export type CreateOp = {
  op: "propose";
  state: "todo" | "proposed";
  title: string;
  group: string;
  desc?: string;
  acceptance?: string[];
  labels?: string[];
  deps?: string[];
  template?: string;
  difficulty?: Difficulty;
};

/** Validates the draft (the mistakes people make first, in Spanish) and builds the op. */
export function createOp(
  draft: CreateDraft,
  ctx: {
    groups: readonly { id: string }[];
    tasks: readonly { id: string }[];
    templates?: readonly Template[] | undefined;
  },
): { ok: true; op: CreateOp } | { ok: false; field: CreateField; message: string } {
  const title = draft.title.trim();
  if (!title) return { ok: false, field: "title", message: t("edit.error.title.empty") };
  if (title.length > 120) return { ok: false, field: "title", message: t("edit.error.title.long") };
  if (draft.desc.length > 32_768)
    return { ok: false, field: "desc", message: t("edit.error.desc.long") };
  if (!ctx.groups.some((group) => group.id === draft.group))
    return { ok: false, field: "group", message: t("edit.error.group", { group: draft.group }) };
  const criteria = draft.acceptance.map((row) => row.text.trim()).filter(Boolean);
  if (criteria.some((text) => text.length > 500))
    return { ok: false, field: "acceptance", message: t("edit.error.criterion.long") };
  const deps = [...new Set(parseLabels(draft.deps).map((id) => id.toUpperCase()))];
  const unknown = deps.find((id) => !ctx.tasks.some((task) => task.id === id));
  if (unknown) return { ok: false, field: "deps", message: t("create.error.dep", { id: unknown }) };
  if (draft.template && !ctx.templates?.some((template) => template.id === draft.template))
    return { ok: false, field: "template", message: t("create.error.template") };
  const desc = draft.desc.trim();
  const labels = parseLabels(draft.labels);
  return {
    ok: true,
    op: {
      op: "propose",
      state: draft.state,
      title,
      group: draft.group,
      ...(desc ? { desc } : {}),
      ...(criteria.length > 0 ? { acceptance: criteria } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(deps.length > 0 ? { deps } : {}),
      ...(draft.template ? { template: draft.template } : {}),
      ...(draft.difficulty ? { difficulty: draft.difficulty } : {}),
    },
  };
}
