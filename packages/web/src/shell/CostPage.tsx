import { groupCost, type Run, type TasksDocument, usageTotals } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { CostSummaryView } from "./CostSummary.tsx";

/**
 * The project's accumulated usage and cost (UI-23): the total and each group's, with the
 * breakdown per provider and model. Computed from the runs in the cache, which `run.state`
 * keeps live, so closing a run updates it without reloading.
 */
export function CostPage({
  plan,
  tasks,
  runs,
}: {
  plan: Pick<TasksDocument, "groups">;
  tasks: TasksDocument["tasks"];
  /** The project's runs; undefined while loading. */
  runs: readonly Run[] | undefined;
}) {
  if (!runs) return <p className="s-text s-muted">{t("action.loading")}</p>;
  return (
    <div className="s-stack b-settings">
      <div>
        <h2 className="s-limits__title">{t("cost.page.title")}</h2>
        <p className="s-text s-muted">{t("cost.page.text")}</p>
      </div>
      <Panel title={t("cost.total")}>
        <CostSummaryView summary={usageTotals(runs)} />
      </Panel>
      {plan.groups.map((group) => {
        const summary = groupCost(runs, { tasks }, group.id);
        if (summary.runs === 0) return null;
        return (
          <Panel key={group.id} title={t("cost.group", { name: group.name })} eyebrow={group.id}>
            <CostSummaryView summary={summary} />
          </Panel>
        );
      })}
    </div>
  );
}
