import type { AgentCatalogEntry, AgentSpec, Effort, Provider } from "@konsora/core";
import { useId } from "react";
import { t } from "../i18n/index.ts";
import {
  agentProblem,
  changeAgent,
  effortOptions,
  modelOptions,
  providerOptions,
} from "./agent-model.ts";

/**
 * Provider, model, effort and permission profile for a run, offering only what each adapter
 * declares (`GET /api/agents`). Providers that are not installed are listed, disabled, with why.
 */
export function AgentPicker({
  agent,
  catalog,
  onChange,
  disabled = false,
  label = t("agent.label"),
}: {
  agent: AgentSpec | undefined;
  catalog: readonly AgentCatalogEntry[];
  onChange: (agent: AgentSpec) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const entry = catalog.find((e) => e.provider === agent?.provider);
  const problem = agentProblem(agent, catalog);
  const models = modelOptions(entry, agent?.model);
  const efforts = agent ? effortOptions(entry, agent.model) : [];
  const set = (change: Parameters<typeof changeAgent>[1]) => {
    if (agent) onChange(changeAgent(agent, change, catalog));
  };
  return (
    <fieldset
      className="b-agent"
      disabled={disabled}
      aria-describedby={problem ? `${id}-problem` : undefined}
    >
      <legend className="k-label">{label}</legend>
      <div className="b-agent__fields">
        <label className="k-field">
          <span className="k-field__label">{t("agent.provider")}</span>
          <select
            className="k-field__control"
            value={agent?.provider ?? ""}
            onChange={(event) => {
              const provider = event.target.value as Provider;
              if (agent) set({ field: "provider", value: provider });
              else {
                const first = catalog.find((e) => e.provider === provider);
                onChange({
                  provider,
                  model: first?.models[0]?.id ?? "",
                  permissions: first?.profiles[0] ?? "default",
                });
              }
            }}
          >
            {!agent && <option value="">—</option>}
            {providerOptions(catalog).map((option) => (
              <option key={option.provider} value={option.provider} disabled={option.disabled}>
                {option.reason ? `${option.provider} (${option.reason})` : option.provider}
              </option>
            ))}
          </select>
        </label>
        <label className="k-field">
          <span className="k-field__label">{t("agent.model")}</span>
          <select
            className="k-field__control k-field__control--mono"
            value={agent?.model ?? ""}
            disabled={!agent || models.length === 0}
            onChange={(event) => set({ field: "model", value: event.target.value })}
          >
            {models.length === 0 && <option value="">—</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label === model.id ? model.id : `${model.label} · ${model.id}`}
              </option>
            ))}
          </select>
        </label>
        <label className="k-field">
          <span className="k-field__label">{t("agent.effort")}</span>
          <select
            className="k-field__control"
            value={agent?.effort ?? ""}
            disabled={!agent || efforts.length === 0}
            onChange={(event) =>
              set({
                field: "effort",
                value: (event.target.value || undefined) as Effort | undefined,
              })
            }
          >
            <option value="">{t("agent.effort.default")}</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label className="k-field">
          <span className="k-field__label">{t("agent.profile")}</span>
          <select
            className="k-field__control"
            value={agent?.permissions ?? "default"}
            disabled={!agent}
            onChange={(event) => set({ field: "permissions", value: event.target.value })}
          >
            {(entry?.profiles ?? ["default"]).map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entry?.version_matches === false && (
        <p className="s-muted b-agent__warning">
          {t("agent.warning.version", {
            version: entry.version ?? "?",
            expected: entry.expected_version ?? "?",
          })}
        </p>
      )}
      {entry?.transport === "exec" && (
        <p className="s-muted b-agent__warning">{t("agent.warning.exec")}</p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="k-field__error" role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
