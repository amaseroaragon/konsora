import type { CostSummary } from "@konsora/core";
import { t } from "../i18n/index.ts";
import { costText, unknownCostNote } from "./cost-model.ts";
import { providerName } from "./limits-model.ts";
import { formatTokens } from "./run-model.ts";

/**
 * Accumulated usage (UI-23): runs, tokens, cost (or why it is unknown) and the breakdown per
 * provider and model.
 */
export function CostSummaryView({ summary }: { summary: CostSummary }) {
  if (summary.runs === 0) return <p className="s-muted">{t("cost.none")}</p>;
  const note = unknownCostNote(summary);
  const cache = summary.cache_read_tokens + summary.cache_write_tokens;
  return (
    <div className="a-stack b-cost">
      <dl className="a-stats">
        <div>
          <dt className="k-label">{t("cost.runs")}</dt>
          <dd className="k-mono">{summary.runs}</dd>
        </div>
        <div>
          <dt className="k-label">{t("run.tokens")}</dt>
          <dd className="k-mono">
            {formatTokens(summary.input_tokens)} / {formatTokens(summary.output_tokens)}
          </dd>
        </div>
        {cache > 0 && (
          <div>
            <dt className="k-label">{t("run.cache")}</dt>
            <dd className="k-mono">
              {t("run.cache.value", {
                read: formatTokens(summary.cache_read_tokens),
                write: formatTokens(summary.cache_write_tokens),
              })}
            </dd>
          </div>
        )}
        {summary.reasoning_tokens > 0 && (
          <div>
            <dt className="k-label">{t("run.reasoning")}</dt>
            <dd className="k-mono">{formatTokens(summary.reasoning_tokens)}</dd>
          </div>
        )}
        <div>
          <dt className="k-label">{t("run.cost")}</dt>
          <dd className="k-mono">{costText(summary)}</dd>
        </div>
      </dl>
      {note && <p className="s-muted">{note}</p>}
      {summary.by_agent.length > 0 && (
        <table className="s-limits">
          <caption className="k-label">{t("cost.by_agent")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("cost.col.agent")}</th>
              <th scope="col">{t("cost.runs")}</th>
              <th scope="col">{t("run.tokens")}</th>
              <th scope="col">{t("run.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {summary.by_agent.map((row) => (
              <tr key={`${row.provider}:${row.model}`}>
                <th scope="row">
                  {providerName(row.provider)} · <span className="k-mono">{row.model}</span>
                </th>
                <td className="k-mono">{row.runs}</td>
                <td className="k-mono">
                  {formatTokens(row.input_tokens)} / {formatTokens(row.output_tokens)}
                </td>
                <td className="k-mono">
                  {row.cost_usd === null ? t("cost.unknown.provider") : costText(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
