import {
  type AgentCatalogEntry,
  type AgentSpec,
  deriveFlags,
  type Note,
  type Run,
  type Task,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentsKey } from "../src/api/agents.ts";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import {
  chooseVariantRequest,
  runDiffKey,
  runEventsKey,
  runsKey,
  useStartVariants,
} from "../src/api/runs.ts";
import { variantStart, variantsProblem } from "../src/shell/agent-model.ts";
import { integrationErrorText } from "../src/shell/review-model.ts";
import { reviewRun, taskVariants, variantsToChoose } from "../src/shell/run-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const catalog: AgentCatalogEntry[] = [
  {
    provider: "claude",
    installed: true,
    version: "2.1.316",
    models: [{ id: "opus", label: "Claude Opus", efforts: ["low", "high"] }],
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
const claude: AgentSpec = { provider: "claude", model: "opus", permissions: "default" };
const codex: AgentSpec = { provider: "codex", model: "gpt-6-luna", permissions: "default" };

const at = "2026-11-10T10:00:00Z";
const task = (state: Task["state"], notes: Note[] = []): Task => ({
  id: "BE-01",
  title: "Algo",
  state,
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...(notes.length ? { notes } : {}),
});
const docOf = (t: Task): TasksDocument => ({
  schema: "konsora/2",
  project: { name: "P", base_branch: "main", defaults: claude },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [t],
});
const boardTask = (t: Task): BoardTask => {
  const flags = deriveFlags(docOf(t));
  return { ...t, ...(flags.get(t.id) as object), hash: taskHash(t) } as BoardTask;
};

const A = "r-01JC8Z3K2QX7M4V9T0B6N5R8VA";
const B = "r-01JC8Z3K2QX7M4V9T0B6N5R8VB";
const variant = (id: string, agent: AgentSpec, extra: Partial<Run> = {}): Run => ({
  id,
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent,
  state: "succeeded",
  variant_of: A,
  ...extra,
});
const a = variant(A, claude, {
  usage: { input_tokens: 12_000, output_tokens: 3000, cost_usd: 0.8 },
  checks: [{ id: "test", source: "project", exit_code: 0, duration_ms: 1200 }],
});
const b = variant(B, codex, {
  usage: { input_tokens: 9000, output_tokens: 2000, cost_usd: null },
  checks: [{ id: "test", source: "project", exit_code: 1, duration_ms: 900 }],
});
const summary = (run: string, text: string, id: string): Note => ({
  id,
  at,
  by: "agent:x",
  kind: "summary",
  text,
  run,
});
const patch = (file: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

function render(node: React.ReactNode, client: QueryClient, fetch?: typeof globalThis.fetch) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32), fetch ? { fetch } : {})}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}
function panel(t: Task, runs: Run[], client = new QueryClient()) {
  client.setQueryData(agentsKey, catalog);
  client.setQueryData(runsKey("p"), runs);
  for (const run of runs) {
    client.setQueryData(runEventsKey("p", run.id), []);
    client.setQueryData(runDiffKey("p", run.id), patch(run.id === A ? "src/a.ts" : "src/b.ts"));
  }
  return render(
    <TaskPanel
      projectId="p"
      task={boardTask(t)}
      doc={docOf(t)}
      groupName="Backend"
      external={[]}
      readOnly={false}
      runs={runs}
      onClose={() => {}}
      onOpen={() => {}}
    />,
    client,
  );
}

describe("launching variants (UI-24 ac1)", () => {
  it("starts from the task's agent and a different one, and refuses the same agent twice", () => {
    expect(variantStart(claude, catalog)).toEqual([claude, codex]);
    expect(variantsProblem([claude, codex], catalog)).toBeNull();
    expect(variantsProblem([claude, { ...claude }], catalog)).toBe(
      "Elige agentes distintos para cada variante.",
    );
    expect(variantsProblem([claude, { ...claude, effort: "high" }], catalog)).toBeNull();
  });

  it("the panel of a ready task offers to run it with several agents", () => {
    expect(panel(task("todo"), [])).toContain(">Ejecutar con varios agentes<");
  });

  it("posts the variants with their agents and lists their runs", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          runs: [
            variant(A, claude, { state: "starting" }),
            variant(B, codex, { state: "starting" }),
          ],
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new QueryClient();
    client.setQueryData(runsKey("p"), []);
    let mutate: ((input: { task: string; agents: AgentSpec[] }) => Promise<Run[]>) | undefined;
    function Probe() {
      mutate = useStartVariants("p").mutateAsync;
      return null;
    }
    render(<Probe />, client, fetch);
    await mutate?.({ task: "BE-01", agents: [claude, codex] });
    expect(calls).toEqual([
      { url: "/api/projects/p/runs", body: { task: "BE-01", agents: [claude, codex] } },
    ]);
    const runs = client.getQueryData<Run[]>(runsKey("p")) ?? [];
    expect(taskVariants(runs, "BE-01").map((r) => r.id)).toEqual([A, B]);
  });

  it("shows each live variant while the task is doing", () => {
    const html = panel(task("doing"), [
      variant(A, claude, { state: "running" }),
      variant(B, codex, { state: "running" }),
    ]);
    expect(html).toContain("Variantes en marcha");
    expect(html).toContain(`aria-label="Run ${A}"`);
    expect(html).toContain(`aria-label="Run ${B}"`);
  });
});

describe("comparing variants in review (UI-24 ac2)", () => {
  const notes = [summary(A, "Hecho con **Claude**.", "n1"), summary(B, "Hecho con Codex.", "n2")];

  it("waits for every variant before asking to choose", () => {
    expect(variantsToChoose([a, { ...b, state: "running" }], "BE-01")).toEqual([]);
    expect(variantsToChoose([a, b], "BE-01").map((r) => r.id)).toEqual([A, B]);
    expect(variantsToChoose([a, { ...b, state: "failed" }], "BE-01")).toEqual([]);
  });

  it("shows each variant's agent, checks, usage and cost, summary and diff, side by side", () => {
    const html = panel(task("review", notes), [a, b]);
    expect(html).toContain("Compara las variantes");
    expect(html).toContain('aria-label="Variante 1"');
    expect(html).toContain('aria-label="Variante 2"');
    expect(html).toContain("claude · opus");
    expect(html).toContain("codex · gpt-6-luna");
    expect(html).toContain("12k / 3k · $0.80");
    expect(html).toContain("9k / 2k · desconocido");
    expect(html).toMatch(/b-checks__ok">✓ <span class="k-mono">test</);
    expect(html).toMatch(/b-checks__fail">✕ <span class="k-mono">test</);
    expect(html).toContain("<strong>Claude</strong>");
    expect(html).toContain("Hecho con Codex.");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
    expect(html.match(/>Elegir esta</g)).toHaveLength(2);
  });

  it("Choose calls the endpoint, and then the review is the winner's", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ run: { ...b, integration: { state: "pending" } } }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;
    await chooseVariantRequest(createApi("ab".repeat(32), { fetch }), "p", B);
    expect(calls).toEqual([{ url: `/api/projects/p/runs/${B}/choose`, method: "POST" }]);

    const chosen = [
      { ...a, integration: { state: "discarded" as const } },
      { ...b, integration: { state: "pending" as const } },
    ];
    expect(reviewRun(chosen, "BE-01")?.id).toBe(B);
    const html = panel(task("review", notes), chosen);
    expect(html).not.toContain("Compara las variantes");
    expect(html).toContain(`aria-label="Run ${B}"`);
    expect(html).toContain("Resumen del agente");
    expect(html).toContain("Hecho con Codex.");
  });

  it("explains accepting before choosing", () => {
    expect(integrationErrorText("variant_not_chosen", "BE-01")).toBe(
      "BE-01 tiene varias variantes: elige una antes de aceptar.",
    );
  });
});
