import {
  type AgentCatalogEntry,
  type AgentSpec,
  applyOp,
  type Op,
  OpSchema,
  type Task,
  type TasksDocument,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentsKey } from "../src/api/agents.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { useEnqueue } from "../src/api/queue.ts";
import { startRunRequest } from "../src/api/runs.ts";
import { agentReason, difficultyText, launchItems, taskAgent } from "../src/shell/agent-model.ts";
import { changesFrom, draftFrom } from "../src/shell/edit-model.ts";
import { RecommendedSettings } from "../src/shell/RecommendedSettings.tsx";
import { recommendedFrom, recommendedOp } from "../src/shell/recommended-model.ts";
import { SelectionBar } from "../src/shell/SelectionBar.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const catalog: AgentCatalogEntry[] = [
  {
    provider: "claude",
    installed: true,
    version: "2.1.316",
    models: [
      { id: "opus", label: "Claude Opus", efforts: ["low", "high"] },
      { id: "haiku", label: "Claude Haiku", efforts: ["low"] },
    ],
    open_models: true,
    profiles: ["default"],
  },
  {
    provider: "codex",
    installed: true,
    version: "0.166.0",
    models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["high"] }],
    open_models: false,
    profiles: ["default"],
  },
];

const hard: AgentSpec = { provider: "claude", model: "opus", effort: "high" };
const easy: AgentSpec = { provider: "claude", model: "haiku" };
const own: AgentSpec = { provider: "codex", model: "gpt-6-luna", effort: "high" };
const fallback: AgentSpec = { provider: "claude", model: "opus" };
const project = { defaults: fallback, recommended: { high: hard, low: easy } };

const at = "2026-11-10T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "todo",
  group: "BE",
  rank: id.toLowerCase(),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const tasks = [
  task("BE-01", { difficulty: "high" }),
  task("BE-02", { difficulty: "low" }),
  task("BE-03", { agent: own, difficulty: "high" }),
  task("BE-04"),
];
const rows = tasks.map((t) => ({ id: t.id, choice: taskAgent(t, project, catalog) }));

function wrap(node: React.ReactNode, client = new QueryClient(), fetch?: typeof globalThis.fetch) {
  return (
    <ApiContext.Provider value={createApi("ab".repeat(32), fetch ? { fetch } : {})}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

const bar = (agent: AgentSpec | undefined) =>
  renderToStaticMarkup(
    <SelectionBar
      ids={tasks.map((t) => t.id)}
      runnable={tasks.map((t) => t.id)}
      readOnly={false}
      agent={agent}
      agents={rows}
      catalog={catalog}
      onAgent={() => {}}
      onRun={() => {}}
      onClear={() => {}}
    />,
  );

describe("the agent each selected task runs with (UI-21 ac1)", () => {
  it("says the agent of each task and why", () => {
    expect(rows.map((r) => r.choice && agentReason(r.choice))).toEqual([
      "Recomendado para dificultad alta: claude · opus · high",
      "Recomendado para dificultad baja: claude · haiku",
      "Agente de la tarea: codex · gpt-6-luna · high",
      "Agente por defecto del proyecto: claude · opus",
    ]);
    const html = bar(undefined);
    expect(html).toContain("Con qué agente se ejecuta cada una");
    expect(html).toContain("Recomendado para dificultad alta: claude · opus · high");
    expect(html).toContain("Agente de la tarea: codex · gpt-6-luna · high");
    expect(html).toContain(">Elegir un agente para todas<");
    expect(html).not.toContain("Agente del run");
  });

  it("shows one selector for all once the human chooses, with the way back", () => {
    const html = bar(hard);
    expect(html).toContain("Agente del run");
    expect(html).toContain(">Usar el de cada tarea<");
    expect(html).not.toContain("Recomendado para dificultad");
  });

  it("falls back to the first available agent when the project sets none", () => {
    const choice = taskAgent(task("BE-09"), {}, catalog);
    expect(choice?.source).toBe("first");
    expect(choice && agentReason(choice)).toBe("Primer agente disponible: claude · opus");
  });
});

describe("Run and Queue use each task's recommended agent (UI-21 ac2)", () => {
  const withProfile = (agent: AgentSpec) => ({ ...agent, permissions: "default" });

  it("Run sends each task's own agent, unless the human chose one for all", async () => {
    const bodies: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ run: {} }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    for (const item of launchItems(["BE-01", "BE-02", "BE-03"], rows, undefined)) {
      await startRunRequest(api, "p", item);
    }
    expect(bodies).toEqual([
      { task: "BE-01", agent: withProfile(hard) },
      { task: "BE-02", agent: withProfile(easy) },
      { task: "BE-03", agent: withProfile(own) },
    ]);
    bodies.length = 0;
    for (const item of launchItems(["BE-01", "BE-03"], rows, withProfile(easy))) {
      await startRunRequest(api, "p", item);
    }
    expect(bodies).toEqual([
      { task: "BE-01", agent: withProfile(easy) },
      { task: "BE-03", agent: withProfile(easy) },
    ]);
    // Without the catalog nothing is sent: the daemon applies the same order.
    expect(launchItems(["BE-01"], undefined, undefined)).toEqual([
      { task: "BE-01", agent: undefined },
    ]);
  });

  it("Queue sends each task's own agent too", async () => {
    const bodies: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          queue: { version: 1, state: "paused", entries: [] },
          status: [],
          limits: { max_parallel: 2, per_provider: {} },
          usage: { total: 0, per_provider: {} },
          added: [],
          already: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    let mutate: ((items: ReturnType<typeof launchItems>) => Promise<unknown>) | undefined;
    function Probe() {
      mutate = useEnqueue("p").mutateAsync;
      return null;
    }
    renderToStaticMarkup(wrap(<Probe />, new QueryClient(), fetch));
    await mutate?.(launchItems(["BE-02", "BE-04"], rows, undefined));
    expect(bodies).toEqual([
      {
        items: [
          { task: "BE-02", agent: withProfile(easy) },
          { task: "BE-04", agent: withProfile(fallback) },
        ],
      },
    ]);
  });
});

describe("difficulty and recommendations are edited from the UI (UI-21 ac3)", () => {
  it("cards show the difficulty", () => {
    const html = renderToStaticMarkup(
      <TaskCard id="BE-01" title="Algo" state="todo" difficulty={difficultyText("high")} />,
    );
    expect(html).toContain("Dificultad alta");
  });

  it("the editor sets, changes and removes it in the edit op", () => {
    const base = { ...task("BE-01"), difficulty: "low" as const };
    const groups = [{ id: "BE" }];
    const change = changesFrom({ ...draftFrom(base), difficulty: "high" }, base, groups);
    expect(change).toEqual({ ok: true, changes: { difficulty: "high" }, empty: false });
    const removed = changesFrom({ ...draftFrom(base), difficulty: "" }, base, groups);
    expect(removed).toEqual({ ok: true, changes: { difficulty: null }, empty: false });
    expect(changesFrom(draftFrom(base), base, groups)).toMatchObject({ empty: true });

    // The daemon takes `null` and removes it.
    const doc: TasksDocument = {
      schema: "konsora/2",
      project: { name: "P", base_branch: "main" },
      groups: [{ id: "BE", name: "BE" }],
      seq: { BE: 1 },
      tasks: [base],
    };
    const op = OpSchema.parse({
      op: "edit",
      task: "BE-01",
      changes: removed.ok ? removed.changes : {},
    }) as Op;
    const result = applyOp(doc, op, { actor: "human", at });
    expect(result.ok && result.document.tasks[0]).not.toHaveProperty("difficulty");
  });

  it("the settings set the recommended agent of each difficulty with set-recommended", () => {
    const base = { high: hard };
    expect(recommendedOp(recommendedFrom(base), base, catalog)).toEqual({ ok: true, op: null });
    expect(recommendedOp({ high: hard, low: easy }, base, catalog)).toEqual({
      ok: true,
      op: { op: "set-recommended", recommended: { low: easy, high: hard } },
    });
    expect(recommendedOp({}, base, catalog)).toEqual({
      ok: true,
      op: { op: "set-recommended", recommended: null },
    });
    const bad = recommendedOp({ medium: { provider: "codex", model: "nope" } }, base, catalog);
    expect(bad.ok ? {} : bad.errors).toHaveProperty("medium");
    expect(bad.ok ? "" : bad.errors.medium).toMatch(/codex/);
  });

  it("the settings list each difficulty with its agent or none", () => {
    const client = new QueryClient();
    client.setQueryData(agentsKey, catalog);
    const html = renderToStaticMarkup(
      wrap(
        <RecommendedSettings
          projectId="p"
          recommended={{ high: hard }}
          defaults={fallback}
          readOnly={false}
        />,
        client,
      ),
    );
    expect(html).toContain("Agente recomendado por dificultad");
    expect(html).toContain("Dificultad baja");
    expect(html).toContain("Agente para dificultad alta");
    expect(html.match(/Sin recomendado: usa el agente por defecto\./g)).toHaveLength(2);
    expect(html).toContain(">Guardar recomendaciones<");
  });
});
