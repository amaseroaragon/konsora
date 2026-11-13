/**
 * The project's name and groups in Ajustes (CORE-13): pure helpers for the form. The rules
 * themselves are core's (`rename-group`, `reorder-groups`, `remove-group`, `rename-project`); the
 * form only checks what it can say before sending.
 */
import { GroupIdSchema, type TasksDocument } from "@konsora/core";
import type { MessageKey } from "../i18n/index.ts";

/**
 * How many tasks keep a group in use: those in it and those whose id has its prefix, in the plan
 * or archived. A group in use cannot be removed.
 */
export function groupUse(plan: Pick<TasksDocument, "tasks" | "archived">, id: string): number {
  const prefix = `${id}-`;
  const live = plan.tasks.filter((t) => t.group === id || t.id.startsWith(prefix)).length;
  return live + (plan.archived ?? []).filter((x) => x.startsWith(prefix)).length;
}

/** The group ids with the one at `index` moved by one place; unchanged at either end. */
export function moveGroup(ids: readonly string[], index: number, by: -1 | 1): string[] {
  const to = index + by;
  if (to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[to]] = [next[to] as string, next[index] as string];
  return next;
}

/** What is wrong with a new group's id, if anything. */
export function newGroupIdError(id: string, existing: readonly string[]): MessageKey | undefined {
  if (!GroupIdSchema.safeParse(id).success) return "groups.error.id";
  if (existing.includes(id)) return "groups.error.id.twice";
  return undefined;
}
