/**
 * Milestone progress (CORE-19): how many of each milestone's tasks are done. Derived from the plan,
 * nothing stored. A milestone is only a goal with its tasks: it never touches git.
 */
import type { Milestone, Task, TasksDocument } from "./schema.ts";

export type MilestoneProgress = Milestone & {
  /** Done tasks of the milestone, archived ones included when given. */
  done: number;
  /** Every task of the milestone, ideas included. */
  total: number;
};

/**
 * Each milestone of the plan, in its order, with its done and total tasks. `archived` (the tasks of
 * `.konsora/archive.json`) adds the done tasks that left the plan; a task in both counts once.
 */
export function milestoneProgress(
  doc: Pick<TasksDocument, "milestones" | "tasks">,
  archived: readonly Task[] = [],
): MilestoneProgress[] {
  const live = new Set(doc.tasks.map((t) => t.id));
  const tasks = [...doc.tasks, ...archived.filter((t) => !live.has(t.id))];
  return (doc.milestones ?? []).map((milestone) => {
    const mine = tasks.filter((t) => t.milestone === milestone.id);
    return {
      ...milestone,
      done: mine.filter((t) => t.state === "done").length,
      total: mine.length,
    };
  });
}
