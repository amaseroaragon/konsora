/**
 * What an unapproved external change did (UI-22), as a pure model: the fields that differ between
 * the version the daemon kept (what «Revertir» restores) and the current one, or, for a deleted
 * task, the content that would be lost. Values are plain text for the UI to show.
 */
import type { Task, TaskState } from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";
import { difficultyLabel, stateLabel } from "../ui/index.ts";

export const EXTERNAL_FIELDS = [
  "state",
  "title",
  "desc",
  "acceptance",
  "labels",
  "group",
  "deps",
  "difficulty",
  "notes",
] as const;
export type ExternalField = (typeof EXTERNAL_FIELDS)[number];

export const FIELD_LABEL: Record<ExternalField, MessageKey> = {
  state: "external.field.state",
  title: "external.field.title",
  desc: "external.field.desc",
  acceptance: "external.field.acceptance",
  labels: "external.field.labels",
  group: "external.field.group",
  deps: "external.field.deps",
  difficulty: "external.field.difficulty",
  notes: "external.field.notes",
};

/** A field as text: empty when the task does not have it. */
export function fieldText(task: Task, field: ExternalField): string {
  switch (field) {
    case "state":
      return stateLabel(task.state as TaskState);
    case "title":
      return task.title;
    case "desc":
      return task.desc ?? "";
    case "acceptance":
      return (task.acceptance ?? []).map((ac) => `${ac.id} ${ac.text}`).join("\n");
    case "labels":
      return (task.labels ?? []).join(", ");
    case "group":
      return task.group;
    case "deps":
      return (task.deps ?? []).join(", ");
    case "difficulty":
      return task.difficulty ? difficultyLabel(task.difficulty) : "";
    case "notes":
      return (task.notes ?? [])
        .map(
          (note) =>
            `${note.id} · ${note.by === "human" ? t("detail.you") : note.by.replace(/^agent:/, "")} · ${t(`note.${note.kind}`)}: ${note.text}`,
        )
        .join("\n");
  }
}

export type FieldDiff = { field: ExternalField; before: string; after: string };

/** The fields that differ, both values as text; `previous` null means it was created outside. */
export function externalDiff(previous: Task | null, current: Task | undefined): FieldDiff[] {
  return EXTERNAL_FIELDS.flatMap((field) => {
    const before = previous ? fieldText(previous, field) : "";
    const after = current ? fieldText(current, field) : "";
    return before === after ? [] : [{ field, before, after }];
  });
}

/** What a deleted task had, field by field, leaving out what is empty. */
export function lostContent(previous: Task): { field: ExternalField; value: string }[] {
  return EXTERNAL_FIELDS.map((field) => ({ field, value: fieldText(previous, field) })).filter(
    (row) => row.value !== "",
  );
}

/** Text longer than this, or on several lines, is shown cut, with the rest a click away. */
export const CLIP_AT = 120;

/** The visible part of a long text, or null when it fits whole. */
export function clipped(text: string, max = CLIP_AT): string | null {
  const first = text.split("\n")[0] ?? "";
  if (text.length <= max && !text.includes("\n")) return null;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : `${first}…`;
}
