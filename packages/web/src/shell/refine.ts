/**
 * «Afinar con IA» (UI-20): the first message the AI panel gets about a task nobody started, with
 * its id and content, so the planning agent can make its description and criteria concrete or
 * split it (plan mode lets it edit tasks nobody started).
 */
import type { Task } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { difficultyLabel, stateLabel } from "../ui/index.ts";

/** Only ideas and tasks nobody started can be refined, and never in read-only. */
export const canRefine = (task: Pick<Task, "state">, readOnly: boolean) =>
  !readOnly && (task.state === "proposed" || task.state === "todo");

export function refineMessage(task: Task, groupName: string): string {
  const criteria = (task.acceptance ?? []).map((ac) => `- ${ac.id}: ${ac.text}`);
  return [
    t("refine.ask", { id: task.id, title: task.title }),
    "",
    `**${t("refine.state")}**: ${stateLabel(task.state)} · **${t("refine.group")}**: ${task.group} (${groupName})`,
    ...(task.difficulty
      ? [`**${t("refine.difficulty")}**: ${difficultyLabel(task.difficulty)}`]
      : []),
    ...(task.labels?.length ? [`**${t("refine.labels")}**: ${task.labels.join(", ")}`] : []),
    ...(task.deps?.length ? [`**${t("refine.deps")}**: ${task.deps.join(", ")}`] : []),
    "",
    `**${t("refine.desc")}**:`,
    task.desc?.trim() || t("refine.none"),
    "",
    `**${t("refine.criteria")}**:`,
    ...(criteria.length ? criteria : [t("refine.none")]),
  ].join("\n");
}
