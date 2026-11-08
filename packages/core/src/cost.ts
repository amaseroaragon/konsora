/**
 * Accumulated usage and cost of a task or a group (CORE-11): the sum over every run of the task
 * (its retries, rebases, variants and reviews are all runs of the same task), with a breakdown
 * per provider and model. Pure: it reads runs and the plan, and writes nothing.
 *
 * A cost the provider does not give (Codex reports tokens only) is unknown, never zero: the runs
 * without one are counted apart in `cost_unknown_runs`, and `cost_usd` is `null` when no run
 * gave one. Runs without any usage yet (still running, or failed before the agent answered) are
 * counted in `runs` and in `no_usage_runs`, and add nothing else.
 */
import type { Run } from "./run.ts";
import type { Provider, TasksDocument } from "./schema.ts";

export type UsageTotals = {
  runs: number;
  /** Runs that have no usage (yet). */
  no_usage_runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** Sum of the known costs, or `null` when no run has one. */
  cost_usd: number | null;
  /** Runs whose cost is unknown (no usage, or usage without a cost): not part of `cost_usd`. */
  cost_unknown_runs: number;
};

export type AgentUsageTotals = UsageTotals & { provider: Provider; model: string };

export type CostSummary = UsageTotals & {
  /** One entry per provider and model, ordered by provider and then model. */
  by_agent: AgentUsageTotals[];
};

function emptyTotals(): UsageTotals {
  return {
    runs: 0,
    no_usage_runs: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: null,
    cost_unknown_runs: 0,
  };
}

function add(totals: UsageTotals, run: Run): void {
  totals.runs += 1;
  const usage = run.usage;
  if (!usage) {
    totals.no_usage_runs += 1;
    totals.cost_unknown_runs += 1;
    return;
  }
  totals.input_tokens += usage.input_tokens;
  totals.output_tokens += usage.output_tokens;
  totals.cache_read_tokens += usage.cache_read_tokens ?? 0;
  totals.cache_write_tokens += usage.cache_write_tokens ?? 0;
  totals.reasoning_tokens += usage.reasoning_tokens ?? 0;
  if (usage.cost_usd === null) totals.cost_unknown_runs += 1;
  else totals.cost_usd = (totals.cost_usd ?? 0) + usage.cost_usd;
}

/** Sums the usage of `runs`, with the breakdown per provider and model. */
export function usageTotals(runs: readonly Run[]): CostSummary {
  const totals = emptyTotals();
  const byAgent = new Map<string, AgentUsageTotals>();
  for (const run of runs) {
    add(totals, run);
    const key = `${run.agent.provider}\u0000${run.agent.model}`;
    let entry = byAgent.get(key);
    if (!entry) {
      entry = { provider: run.agent.provider, model: run.agent.model, ...emptyTotals() };
      byAgent.set(key, entry);
    }
    add(entry, run);
  }
  const by_agent = [...byAgent.values()].sort(
    (a, b) =>
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
  return { ...totals, by_agent };
}

/** The accumulated usage of every run of `task`. */
export function taskCost(runs: readonly Run[], task: string): CostSummary {
  return usageTotals(runs.filter((run) => run.task === task));
}

/**
 * The accumulated usage of every run of the tasks in `group`. A task belongs to the group it is
 * in now (`edit` can move it); a run whose task is no longer in the plan counts for the group in
 * its id.
 */
export function groupCost(
  runs: readonly Run[],
  doc: Pick<TasksDocument, "tasks">,
  group: string,
): CostSummary {
  const groupOf = new Map(doc.tasks.map((t) => [t.id, t.group]));
  return usageTotals(
    runs.filter(
      (run) => (groupOf.get(run.task) ?? run.task.slice(0, run.task.lastIndexOf("-"))) === group,
    ),
  );
}
