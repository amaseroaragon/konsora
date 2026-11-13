/**
 * Bulk edits of the selection (UI-26), as a pure model: moving the selected tasks to a group, or
 * adding or removing one label, each turned into the `edit` changes of one task.
 */
import { LabelSchema, type Task } from "@konsora/core";
import { t } from "../i18n/index.ts";

export type BulkChange =
  | { kind: "group"; group: string }
  | { kind: "label-add"; label: string }
  | { kind: "label-remove"; label: string };

/** The `edit` changes that apply `change` to `task`; null when it already has it. */
export function bulkChanges(
  task: Pick<Task, "group" | "labels">,
  change: BulkChange,
): { group: string } | { labels: string[] } | null {
  const labels = task.labels ?? [];
  switch (change.kind) {
    case "group":
      return task.group === change.group ? null : { group: change.group };
    case "label-add":
      return labels.includes(change.label) ? null : { labels: [...labels, change.label] };
    case "label-remove":
      return labels.includes(change.label)
        ? { labels: labels.filter((label) => label !== change.label) }
        : null;
  }
}

/** A label as typed, normalized the way it is stored (trimmed, lower case). */
export const normalizeLabel = (text: string) => text.trim().toLowerCase();

/** Why `label` cannot be a label, in Spanish; null when it can. */
export function labelProblem(label: string): string | null {
  if (!label) return t("bulk.label.error.empty");
  return LabelSchema.safeParse(label).success ? null : t("bulk.label.error.format", { label });
}

export type BulkOutcome = { changed: string[]; refused: { id: string; error: unknown }[] };

/**
 * Sends `change` to each of `ids` in turn through `send` (one conditioned `edit` each). Tasks that
 * already have it are skipped; a refusal does not stop the rest and is returned with its error.
 */
export async function applyBulk(
  tasks: readonly (Pick<Task, "id" | "group" | "labels"> & { hash: string })[],
  ids: readonly string[],
  change: BulkChange,
  send: (
    task: string,
    hash: string,
    changes: { group: string } | { labels: string[] },
  ) => Promise<unknown>,
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { changed: [], refused: [] };
  for (const id of ids) {
    const task = tasks.find((x) => x.id === id);
    const changes = task && bulkChanges(task, change);
    if (!task || !changes) continue;
    try {
      await send(id, task.hash, changes);
      outcome.changed.push(id);
    } catch (error) {
      outcome.refused.push({ id, error });
    }
  }
  return outcome;
}
