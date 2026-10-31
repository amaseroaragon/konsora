import type { Dispatch } from "react";
import { t } from "../i18n/index.ts";
import { otherProjects, usage } from "../mock/data.ts";
import { Menu, Segmented } from "../ui/index.ts";
import type { Action, AppState, View } from "./state.ts";

export function Header({ state, dispatch }: { state: AppState; dispatch: Dispatch<Action> }) {
  const projects = [{ id: state.project.id, name: state.project.name }, ...otherProjects];
  const running = state.project.runs.filter((run) => run.state === "running").length;
  return (
    <header className="a-header">
      <div className="a-header__brand">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
          <rect x="14" y="3" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
          <rect x="8.5" y="14" width="7" height="7" stroke="var(--k-accent)" strokeWidth="1.75" />
          <path d="M6.5 10v2h11v-2M12 12v2" stroke="var(--k-accent)" strokeWidth="1.75" />
        </svg>
        <span className="a-header__name">KONSORA</span>
      </div>
      <div className="a-header__cell">
        <Menu
          caption={t("app.project")}
          value={state.project.id}
          onChange={() => undefined}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      </div>
      <div className="a-header__cell">
        <Segmented
          label={t("app.views")}
          value={state.view}
          onChange={(view) => dispatch({ type: "view", view: view as View })}
          options={[
            { value: "board", label: t("app.view.board") },
            { value: "graph", label: t("app.view.graph") },
            {
              value: "runs",
              label: running ? `${t("app.view.runs")} · ${running}` : t("app.view.runs"),
            },
          ]}
        />
      </div>
      <label className="a-header__search">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <span className="k-visually-hidden">{t("app.search")}</span>
        <input
          type="search"
          value={state.query}
          placeholder={t("app.search.placeholder")}
          onChange={(event) => dispatch({ type: "query", query: event.target.value })}
        />
      </label>
      <dl className="a-header__usage" aria-label={t("app.usage")}>
        <div>
          <dt>{t("app.usage.claude")}</dt>
          <dd>{usage.claude}%</dd>
        </div>
        <div>
          <dt>{t("app.usage.codex")}</dt>
          <dd>{usage.codex}%</dd>
        </div>
      </dl>
    </header>
  );
}
