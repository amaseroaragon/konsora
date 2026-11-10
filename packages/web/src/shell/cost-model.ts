/**
 * Accumulated usage as the UI words it (UI-23), over core's `taskCost`, `groupCost` and
 * `usageTotals`: an unknown cost is said as such, never shown as zero.
 */
import type { UsageTotals } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { formatTokens } from "./run-model.ts";

/** Dollars with cents; under ten cents with one more digit, so small runs do not read as $0.01. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;
}

/** The cost cell: the known sum, "unknown" when no run gave one, or "—" without runs. */
export function costText(totals: UsageTotals): string {
  if (totals.runs === 0) return "—";
  if (totals.cost_usd === null) return t("cost.unknown");
  return totals.cost_unknown_runs > 0
    ? t("cost.partial", { cost: formatCost(totals.cost_usd), n: totals.cost_unknown_runs })
    : formatCost(totals.cost_usd);
}

/** One line for a group's header: tokens and cost; empty when the group has no runs. */
export function costLine(totals: UsageTotals): string {
  if (totals.runs === 0) return "";
  const tokens = formatTokens(totals.input_tokens + totals.output_tokens);
  return t("cost.line", { tokens, cost: costText(totals) });
}

/** Why part of the cost is missing, when it is: those runs' providers give tokens only. */
export function unknownCostNote(totals: UsageTotals): string | null {
  if (totals.cost_unknown_runs === 0) return null;
  const n = totals.cost_unknown_runs;
  const pending = Math.min(totals.no_usage_runs, n);
  if (pending === 0) return t("cost.unknown.note.tokens", { n });
  if (pending === n) return t("cost.unknown.note.pending", { n });
  return t("cost.unknown.note", { n, usage: n - pending, pending });
}
