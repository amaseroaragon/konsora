import type { Dispatch } from "react";
import { type MessageKey, t } from "../i18n/index.ts";
import { agentLabel, formatDuration, formatTokens, type RunState } from "./model.ts";
import type { Action, AppState } from "./state.ts";

const stateKey: Record<RunState, MessageKey> = {
  running: "run.state.running",
  waiting_approval: "run.state.waiting_approval",
  succeeded: "run.state.succeeded",
  failed: "run.state.failed",
  cancelled: "run.state.cancelled",
};

export function RunsView({
  state,
  dispatch,
  now,
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  now: number;
}) {
  const runs = [...state.project.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="a-runs">
      <table className="a-table">
        <caption className="k-visually-hidden">{t("app.view.runs")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("runs.col.run")}</th>
            <th scope="col">{t("runs.col.task")}</th>
            <th scope="col">{t("runs.col.agent")}</th>
            <th scope="col">{t("runs.col.state")}</th>
            <th scope="col">{t("runs.col.duration")}</th>
            <th scope="col">{t("runs.col.tokens")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const live = run.state === "running";
            const duration = live ? (now - Date.parse(run.startedAt)) / 1000 : (run.durationS ?? 0);
            return (
              <tr key={run.id}>
                <td>
                  <button
                    type="button"
                    className="a-link"
                    onClick={() => dispatch({ type: "open", id: run.task, tab: "run" })}
                  >
                    {run.id}
                  </button>
                </td>
                <td className="k-mono">{run.task}</td>
                <td className="k-mono">{agentLabel(run.agent)}</td>
                <td>
                  <span className={`a-run-state a-run-state--${run.state}`}>
                    {t(stateKey[run.state])}
                    {run.integrated ? ` · ${t("runs.integrated")}` : ""}
                  </span>
                </td>
                <td className="k-mono">{formatDuration(duration)}</td>
                <td className="k-mono">
                  {run.tokens
                    ? `${formatTokens(run.tokens.input)}↑ ${formatTokens(run.tokens.output)}↓`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function runStateLabel(state: RunState): string {
  return t(stateKey[state]);
}
