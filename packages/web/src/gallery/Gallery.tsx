import { type ReactNode, useEffect, useState } from "react";
import { type MessageKey, t } from "../i18n/index.ts";
import { applyTheme, initialThemeChoice, type ThemeChoice } from "../theme/apply.ts";
import { colorNames, dark, light } from "../theme/tokens.ts";
import {
  Button,
  Field,
  Matrix,
  Menu,
  Panel,
  Segmented,
  StateBadge,
  Tabs,
  TaskCard,
  taskStates,
  useToast,
} from "../ui/index.ts";

function useThemeChoice(): [ThemeChoice, (value: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(initialThemeChoice);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}

function Section({ title, children }: { title: MessageKey; children: ReactNode }) {
  return (
    <section className="g-section" aria-labelledby={`g-${title}`}>
      <h2 id={`g-${title}`} className="k-label g-section__title">
        {t(title)}
      </h2>
      {children}
    </section>
  );
}

const agents = [
  { value: "claude-opus-high", label: "Claude · Opus · alto" },
  { value: "claude-sonnet-medium", label: "Claude · Sonnet · medio" },
  { value: "codex-gpt-medium", label: "Codex · gpt-5.5 · medio" },
];

export function Gallery() {
  const [theme, setTheme] = useThemeChoice();
  const [agent, setAgent] = useState("claude-opus-high");
  const [tab, setTab] = useState("review");
  const [view, setView] = useState("board");
  const [selected, setSelected] = useState(new Set(["DMN-02"]));
  const toast = useToast();

  const toggle = (id: string) => (value: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <main className="g-page">
      <header className="g-header">
        <div>
          <h1 className="g-title">{t("gallery.title")}</h1>
          <p className="g-intro">{t("gallery.intro")}</p>
        </div>
        <Segmented
          label={t("gallery.theme")}
          value={theme}
          onChange={(value) => setTheme(value as ThemeChoice)}
          options={[
            { value: "system", label: t("gallery.theme.system") },
            { value: "light", label: t("gallery.theme.light") },
            { value: "dark", label: t("gallery.theme.dark") },
          ]}
        />
      </header>

      <Section title="gallery.colors">
        <div className="g-swatches">
          {colorNames.map((name) => (
            <figure key={name} className="g-swatch">
              <span className="g-swatch__chip" style={{ background: `var(--k-${name})` }} />
              <figcaption>
                <span className="k-mono">{name}</span>
                <span className="k-mono g-swatch__hex">
                  {light[name]} · {dark[name]}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section title="gallery.type">
        <div className="g-type">
          <p style={{ fontSize: "var(--k-text-2xl)", fontWeight: 600, margin: 0 }}>Konsora</p>
          <p style={{ fontSize: "var(--k-text-xl)", fontWeight: 600, margin: 0 }}>
            Daemon: loopback, token, Host/Origin checks
          </p>
          <p style={{ margin: 0 }}>{t("gallery.sample.text")}</p>
          <p className="k-mono" style={{ margin: 0, fontSize: "var(--k-text-sm)" }}>
            r-01JC8Z · codex/gpt-5.5/medio · 6m48s · 41.2k↑ 5.3k↓
          </p>
          <p className="k-label" style={{ margin: 0 }}>
            CRITERIOS DE ACEPTACIÓN
          </p>
        </div>
      </Section>

      <Section title="gallery.buttons">
        <div className="g-row">
          <Button variant="primary">{t("gallery.primary")}</Button>
          <Button>{t("gallery.secondary")}</Button>
          <Button variant="ghost">{t("gallery.ghost")}</Button>
          <Button variant="danger">{t("gallery.danger")}</Button>
          <Button variant="primary" disabled>
            {t("gallery.disabled")}
          </Button>
          <Button variant="primary" busy>
            {t("gallery.busy")}
          </Button>
          <Button size="sm">{t("gallery.small")}</Button>
        </div>
      </Section>

      <Section title="gallery.badges">
        <div className="g-row">
          {taskStates.map((state) => (
            <StateBadge key={state} kind={state} />
          ))}
          <StateBadge kind="ready" />
          <StateBadge kind="blocked" />
          <StateBadge kind="waiting" />
          <StateBadge kind="running" label="4:12" />
        </div>
      </Section>

      <Section title="gallery.cards">
        <div className="g-cards">
          <TaskCard
            id="CORE-01"
            state="doing"
            title="Define schema v2 with zod and generate JSON Schema"
            running="4:12"
            agent="claude/opus/alto"
          />
          <TaskCard
            id="DMN-02"
            state="todo"
            title="Ops endpoint, approvals ledger and external-change detection"
            agent="codex/medio"
            selected={selected.has("DMN-02")}
            onSelectedChange={toggle("DMN-02")}
            onOpen={() => undefined}
          />
          <TaskCard
            id="CORE-02"
            state="todo"
            title="Semantic validation with JSON Pointer errors"
            blockedBy={["CORE-01"]}
            onSelectedChange={toggle("CORE-02")}
          />
          <TaskCard
            id="CLI-05"
            state="proposed"
            title="Export the board as a read-only HTML snapshot"
            proposedBy="claude"
          />
          <TaskCard
            id="DMN-01"
            state="review"
            title="Daemon: loopback, token, Host/Origin checks and project registry"
            agent="codex/gpt-5.5"
          />
          <TaskCard id="UI-04" state="doing" title="Visual direction and design system" waiting />
        </div>
      </Section>

      <Section title="gallery.matrix">
        <div className="g-scroll">
          <Matrix
            label={t("gallery.matrix")}
            columns={taskStates.map((state) => ({ state, count: state === "todo" ? 2 : 1 }))}
            lanes={[
              {
                id: "CORE",
                name: "Núcleo",
                cells: [
                  null,
                  <TaskCard
                    key="c2"
                    id="CORE-02"
                    state="todo"
                    title="Semantic validation"
                    blockedBy={["CORE-01"]}
                  />,
                  <TaskCard key="c1" id="CORE-01" state="doing" title="Schema v2" running="4:12" />,
                  null,
                  null,
                ],
              },
              {
                id: "DMN",
                name: "Daemon",
                cells: [
                  <TaskCard
                    key="p"
                    id="DMN-04"
                    state="proposed"
                    title="Rate limits endpoint"
                    proposedBy="codex"
                  />,
                  <TaskCard key="d2" id="DMN-02" state="todo" title="Ops endpoint" />,
                  null,
                  <TaskCard key="d1" id="DMN-01" state="review" title="Loopback daemon" />,
                  <TaskCard key="r" id="REP-01" state="done" title="Monorepo restart" />,
                ],
              },
            ]}
          />
        </div>
      </Section>

      <Section title="gallery.fields">
        <div className="g-fields">
          <Field
            label={t("gallery.field.title")}
            hint={t("gallery.field.title.hint")}
            defaultValue="Semantic validation"
          />
          <Field
            label={t("gallery.field.search")}
            hideLabel
            mono
            type="search"
            placeholder={t("gallery.field.search.placeholder")}
          />
          <Field
            label={t("gallery.field.feedback")}
            multiline
            error={t("gallery.field.feedback.error")}
            required
          />
          <Field label={t("gallery.field.disabled")} defaultValue="main" disabled mono />
        </div>
      </Section>

      <Section title="gallery.menu">
        <div className="g-row">
          <Menu
            caption={t("gallery.menu.agent")}
            options={agents}
            value={agent}
            onChange={setAgent}
          />
          <span>
            {t("gallery.menu.chosen", {
              value: agents.find((a) => a.value === agent)?.label ?? "",
            })}
          </span>
        </div>
      </Section>

      <Section title="gallery.tabs">
        <div className="g-stack">
          <Segmented
            label={t("gallery.views.label")}
            value={view}
            onChange={setView}
            options={[
              { value: "board", label: t("gallery.views.board") },
              { value: "graph", label: t("gallery.views.graph") },
              { value: "runs", label: t("gallery.views.runs") },
            ]}
          />
          <Tabs
            label={t("gallery.tabs")}
            selected={tab}
            onSelect={setTab}
            tabs={(["detail", "run", "review"] as const).map((id) => {
              const label = t(`gallery.tabs.${id}`);
              return {
                id,
                label,
                content: <p style={{ margin: 0 }}>{t("gallery.tabs.content", { tab: label })}</p>,
              };
            })}
          />
        </div>
      </Section>

      <Section title="gallery.panel">
        <Panel
          eyebrow={t("gallery.panel.eyebrow")}
          title="DMN-01"
          actions={
            <>
              <Button size="sm">{t("gallery.secondary")}</Button>
              <Button size="sm" variant="primary">
                {t("gallery.primary")}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{t("gallery.panel.body")}</p>
        </Panel>
      </Section>

      <Section title="gallery.toast">
        <div className="g-row">
          <Button onClick={() => toast.show(t("gallery.toast.success"), "success")}>
            {t("gallery.toast.show.success")}
          </Button>
          <Button onClick={() => toast.show(t("gallery.toast.info"), "info")}>
            {t("gallery.toast.show.info")}
          </Button>
          <Button variant="danger" onClick={() => toast.show(t("gallery.toast.error"), "error")}>
            {t("gallery.toast.show.error")}
          </Button>
        </div>
      </Section>
    </main>
  );
}
