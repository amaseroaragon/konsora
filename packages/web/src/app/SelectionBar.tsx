import type { Dispatch } from "react";
import { t } from "../i18n/index.ts";
import { Button, Menu, useToast } from "../ui/index.ts";
import type { AgentSpec } from "./model.ts";
import type { Action, AppState } from "./state.ts";

const agents: Record<string, AgentSpec> = {
  "claude-opus-alto": { provider: "claude", model: "opus", effort: "alto" },
  "claude-sonnet-medio": { provider: "claude", model: "sonnet", effort: "medio" },
  "codex-gpt-5.5-medio": { provider: "codex", model: "gpt-5.5", effort: "medio" },
  "codex-gpt-5.5-alto": { provider: "codex", model: "gpt-5.5", effort: "alto" },
};
const keyOf = (a: AgentSpec) => `${a.provider}-${a.model}-${a.effort}`;
const labelOf = (a: AgentSpec) =>
  `${a.provider === "claude" ? "Claude" : "Codex"} · ${a.model} · ${a.effort}`;

export function SelectionBar({ state, dispatch }: { state: AppState; dispatch: Dispatch<Action> }) {
  const toast = useToast();
  const ids = [...state.selected].sort();
  const empty = ids.length === 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar-like region; <section> needs a heading here.
    <div className="a-selection" role="region" aria-label={t("app.selection")}>
      <div className="a-selection__count">
        <span className="a-selection__badge">{ids.length}</span>
        <span>
          {empty ? t("app.selection.none") : t("app.selection.some")}{" "}
          {!empty && <span className="k-mono a-selection__ids">{ids.join(", ")}</span>}
        </span>
        {!empty && (
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "clearSelection" })}>
            {t("app.selection.clear")}
          </Button>
        )}
      </div>
      <div className="a-selection__controls">
        <Menu
          caption={t("app.selection.agent")}
          value={keyOf(state.agent)}
          options={Object.entries(agents).map(([value, agent]) => ({
            value,
            label: labelOf(agent),
          }))}
          onChange={(value) => {
            const agent = agents[value];
            if (agent) dispatch({ type: "agent", agent });
          }}
        />
        <Menu
          caption={t("app.selection.permissions")}
          value={state.permissions}
          options={[
            { value: "default", label: "default" },
            { value: "readonly", label: "readonly" },
            { value: "trusted", label: "trusted" },
          ]}
          onChange={(value) => dispatch({ type: "permissions", value })}
        />
        <Menu
          caption={t("app.selection.parallel")}
          value={String(state.parallel)}
          options={[1, 2, 3, 4].map((n) => ({
            value: String(n),
            label: t("app.selection.parallel.n", { n }),
          }))}
          onChange={(value) => dispatch({ type: "parallel", value: Number(value) })}
        />
        <Button
          variant="primary"
          className="a-selection__run"
          disabled={empty}
          onClick={() => {
            dispatch({ type: "runSelection", at: new Date().toISOString() });
            toast.show(
              t("app.toast.launched", { n: ids.length, agent: labelOf(state.agent) }),
              "info",
            );
          }}
        >
          {t("app.selection.run")} →
        </Button>
      </div>
    </div>
  );
}
