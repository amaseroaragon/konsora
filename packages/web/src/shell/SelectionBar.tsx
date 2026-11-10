import type { AgentCatalogEntry, AgentSpec } from "@konsora/core";
import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { agentProblem, agentReason, sharedAgent, type TaskAgent } from "./agent-model.ts";

/**
 * How many tasks are selected, which ones, and Run: it launches the selected tasks that are ready
 * (each in its own run). Tasks that are not ready are left out, and the hint says which run.
 */
export function SelectionBar({
  ids,
  runnable,
  readOnly,
  busy = false,
  agent,
  agents = [],
  catalog,
  onAgent,
  onRun,
  onClear,
  queueable = [],
  queueBusy = false,
  onQueue,
  full = [],
}: {
  ids: readonly string[];
  /** The selected tasks Run would launch. */
  runnable: readonly string[];
  readOnly: boolean;
  busy?: boolean;
  /** The agent the human chose for every launched run; `undefined`: each task uses its own. */
  agent?: AgentSpec | undefined;
  /** The agent each task Run or Queue would launch uses, and why (UI-21). */
  agents?: readonly { id: string; choice: TaskAgent | undefined }[];
  /** `GET /api/agents`; without it there is no selector and each task uses its own agent. */
  catalog?: readonly AgentCatalogEntry[] | undefined;
  onAgent?: (agent: AgentSpec | undefined) => void;
  onRun: (ids: readonly string[]) => void;
  onClear: () => void;
  /** The selected tasks Queue would add (approved, to do; blocked ones too). */
  queueable?: readonly string[];
  queueBusy?: boolean;
  /** Without it there is no Queue button. */
  onQueue?: (ids: readonly string[]) => void;
  /** Selected tasks the daemon refused to run now: max_parallel has no slot for them (DMN-11). */
  full?: readonly string[];
}) {
  const hint = useId();
  const queueHint = useId();
  const problem = !catalog
    ? null
    : agent
      ? agentProblem(agent, catalog)
      : (agents.map((row) => agentProblem(row.choice?.agent, catalog)).find(Boolean) ?? null);
  const disabled = readOnly || runnable.length === 0 || problem !== null;
  return (
    <section className="a-selection b-selection" aria-label={t("app.selection")}>
      <div className="a-selection__count">
        <span className="a-selection__badge">{ids.length}</span>
        <span role="status">
          {t(ids.length === 1 ? "selection.one" : "selection.many", { n: ids.length })}{" "}
          <span className="k-mono a-selection__ids">{ids.join(", ")}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("app.selection.clear")}
        </Button>
      </div>
      {catalog && onAgent && !readOnly && agents.length > 0 && (
        <AgentChoice agent={agent} agents={agents} catalog={catalog} onAgent={onAgent} />
      )}
      {onQueue && !readOnly && full.length > 0 && (
        <p className="a-callout a-callout--warn" role="alert">
          <span className="a-callout__text">
            {t("selection.run.full", { ids: full.join(", ") })}
          </span>
        </p>
      )}
      <div className="a-selection__controls">
        <p id={hint} className="b-selection__hint s-muted">
          {readOnly
            ? t("selection.run.readonly")
            : runnable.length === 0
              ? t("selection.run.none")
              : t("selection.run.ready", { n: runnable.length, ids: runnable.join(", ") })}
        </p>
        {onQueue && (
          <>
            <p id={queueHint} className="b-selection__hint s-muted">
              {readOnly
                ? t("selection.run.readonly")
                : queueable.length === 0
                  ? t("selection.queue.none")
                  : t("selection.queue.ready", { n: queueable.length, ids: queueable.join(", ") })}
            </p>
            <Button
              disabled={readOnly || queueable.length === 0 || problem !== null}
              busy={queueBusy}
              aria-describedby={queueHint}
              onClick={() => onQueue(queueable)}
            >
              {t("selection.queue")}
            </Button>
          </>
        )}
        <Button
          variant="primary"
          className="a-selection__run"
          disabled={disabled}
          busy={busy}
          aria-describedby={hint}
          onClick={() => onRun(runnable)}
        >
          {t("app.selection.run")} →
        </Button>
      </div>
    </section>
  );
}

/**
 * With what agent each selected task will run and why; or, once the human chooses one for all,
 * that agent's selector (and the way back to each task's own).
 */
function AgentChoice({
  agent,
  agents,
  catalog,
  onAgent,
}: {
  agent: AgentSpec | undefined;
  agents: readonly { id: string; choice: TaskAgent | undefined }[];
  catalog: readonly AgentCatalogEntry[];
  onAgent: (agent: AgentSpec | undefined) => void;
}) {
  if (agent) {
    return (
      <div className="a-stack b-selection__agents">
        <AgentPicker agent={agent} catalog={catalog} onChange={onAgent} />
        <div>
          <Button size="sm" variant="ghost" onClick={() => onAgent(undefined)}>
            {t("selection.agents.each")}
          </Button>
        </div>
      </div>
    );
  }
  const choices = agents.map((row) => row.choice);
  const start = sharedAgent(choices) ?? choices.find(Boolean)?.agent;
  return (
    <div className="a-stack b-selection__agents">
      <div className="k-label">{t("selection.agents")}</div>
      <ul className="b-selection__agent-list">
        {agents.map(({ id, choice }) => {
          const problem = agentProblem(choice?.agent, catalog);
          return (
            <li key={id}>
              <span className="k-mono">{id}</span>{" "}
              <span className="s-muted">{choice ? agentReason(choice) : t("agent.none")}</span>
              {choice && problem && (
                <span className="k-field__error" role="alert">
                  {" "}
                  {problem}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="sm" variant="ghost" disabled={!start} onClick={() => onAgent(start)}>
          {t("selection.agents.one")}
        </Button>
      </div>
    </div>
  );
}
