import type { Run } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { applyQueueMessage, parallelKey, type QueueView, queueKey } from "../src/api/queue.ts";
import { ProjectQueueView, QueueLink } from "../src/shell/QueuePage.tsx";
import {
  activeRuns,
  awaitingApproval,
  entryWaitText,
  limitsDraft,
  parseLimitsDraft,
  queueableSelection,
  waitText,
} from "../src/shell/queue-model.ts";
import { parseRoute } from "../src/shell/route.ts";
import { SelectionBar } from "../src/shell/SelectionBar.tsx";
import { Shell } from "../src/shell/Shell.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-08T10:00:00Z";
const claude = { provider: "claude", model: "sonnet" } as const;
const codex = { provider: "codex", model: "gpt-5", effort: "high" } as const;

function render(node: React.ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("t".repeat(64))}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

const run = (task: string, state: Run["state"]): Run => ({
  id: `r-01JC8Z3K2QX7M4V9T0B6N5R8${task.slice(-2)}`,
  task,
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { ...claude, permissions: "default" },
  state,
});

const view: QueueView = {
  queue: {
    version: 1,
    state: "running",
    entries: [
      { task: "BE-01", agent: claude, added_at: at, run: "r-01JC8Z3K2QX7M4V9T0B6N5R801" },
      { task: "BE-02", agent: codex, added_at: at },
      { task: "BE-03", agent: claude, added_at: at },
      { task: "BE-04", agent: claude, added_at: at },
    ],
  },
  status: [
    { task: "BE-01", wait: { kind: "running", run: "r-01JC8Z3K2QX7M4V9T0B6N5R801" } },
    { task: "BE-02", wait: { kind: "slot", limit: "provider" } },
    { task: "BE-03", wait: { kind: "slot", limit: "global" } },
    { task: "BE-04", wait: { kind: "blocked", deps: ["BE-01"] } },
  ],
  limits: { max_parallel: 2, per_provider: { codex: 1 } },
  usage: { total: 2, per_provider: { claude: 1, codex: 1 } },
};

describe("the queue view (UI-18)", () => {
  it("is a view outside the board, linked from the header", () => {
    expect(parseRoute("#/cola")).toEqual({ name: "queue" });
    const html = render(
      <Shell nav={<QueueLink current />}>
        <p>page</p>
      </Shell>,
    );
    expect(html).toContain('href="#/cola"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">Cola<");
  });

  it("shows each entry with its agent and why it waits, the active runs and the slots in use", () => {
    const html = render(
      <ProjectQueueView
        project={{ id: "p-1", name: "demo" }}
        view={view}
        runs={activeRuns([run("BE-01", "running"), run("BE-09", "succeeded")])}
      />,
    );
    expect(html).toContain("En marcha");
    expect(html).toContain("2 de 2 huecos en uso · Claude Code: 1 en uso · Codex: 1/1 en uso");
    expect(html).toContain("En ejecución (r-01JC8Z3K2QX7M4V9T0B6N5R801)");
    expect(html).toContain("Lista; esperando un hueco de Codex");
    expect(html).toContain("Lista; esperando un hueco<");
    expect(html).toContain("Bloqueada por BE-01");
    expect(html).toContain("Codex · gpt-5 · high");
    expect(html).toContain('aria-label="Quitar BE-02 de la cola"');
    expect(html).toContain(">Pausar<");
    expect(html).toContain('href="#/p/p-1?task=BE-04"');
    // Active runs: only the live one.
    expect(html).toContain("Runs activos");
    expect(html).not.toContain("BE-09");
  });

  it("offers Resume on a paused queue and says when there is nothing", () => {
    const paused = render(
      <ProjectQueueView
        project={{ id: "p-1", name: "demo" }}
        view={{
          ...view,
          queue: { ...view.queue, state: "paused", entries: [] },
          status: [],
          usage: { total: 0, per_provider: {} },
        }}
        runs={[]}
      />,
    );
    expect(paused).toContain("En pausa");
    expect(paused).toContain(">Reanudar<");
    expect(paused).toContain("Nada en la cola ni en ejecución.");
  });

  it("words every wait reason", () => {
    expect(waitText({ kind: "paused" })).toBe("Lista; la cola está en pausa");
    expect(waitText({ kind: "busy", state: "review" })).toBe(
      "No se puede lanzar: está en En revisión",
    );
    expect(waitText({ kind: "busy", state: "todo", run: "r-1" })).toBe(
      "Tiene otro run activo (r-1)",
    );
    expect(waitText({ kind: "busy", state: "missing" })).toBe("La tarea ya no existe");
    expect(waitText({ kind: "launch" })).toBe("Lanzándose…");
    expect(entryWaitText({ kind: "slot", limit: "global" }, codex)).toBe(
      "Lista; esperando un hueco",
    );
  });

  it("edits the limits as whole numbers from 1 to 16; an empty provider has no limit", () => {
    const draft = limitsDraft({ max_parallel: 2, per_provider: { codex: 1 } });
    expect(draft).toEqual({ max: "2", claude: "", codex: "1" });
    expect(parseLimitsDraft({ ...draft, max: "4" })).toEqual({
      max_parallel: 4,
      per_provider: { codex: 1 },
    });
    expect(parseLimitsDraft({ ...draft, max: "0" })).toBeNull();
    expect(parseLimitsDraft({ ...draft, max: "17" })).toBeNull();
    expect(parseLimitsDraft({ ...draft, claude: "1.5" })).toBeNull();
    expect(parseLimitsDraft({ max: " 3 ", claude: "", codex: "" })).toEqual({
      max_parallel: 3,
      per_provider: {},
    });
  });

  it("applies queue.* messages live", () => {
    const client = new QueryClient();
    client.setQueryData(queueKey("p-1"), view);
    applyQueueMessage(client, {
      type: "queue.limits",
      limits: { max_parallel: 4, per_provider: {} },
    });
    expect(client.getQueryData(parallelKey)).toEqual({ max_parallel: 4, per_provider: {} });
    expect(client.getQueryState(queueKey("p-1"))?.isInvalidated).toBe(true);
    const other = new QueryClient();
    other.setQueryData(queueKey("p-1"), view);
    other.setQueryData(queueKey("p-2"), view);
    applyQueueMessage(other, { type: "queue.updated", project: "p-1" });
    expect(other.getQueryState(queueKey("p-1"))?.isInvalidated).toBe(true);
    expect(other.getQueryState(queueKey("p-2"))?.isInvalidated).toBe(false);
  });
});

describe("queueing from the selection bar (UI-18 ac1)", () => {
  const tasks = [
    { id: "BE-01", state: "todo" },
    { id: "BE-02", state: "proposed" },
    { id: "BE-03", state: "review" },
    { id: "BE-04", state: "todo" },
  ];

  it("queues the approved tasks still to do, blocked ones included", () => {
    expect(queueableSelection(["BE-04", "BE-02", "BE-03", "BE-01"], tasks, false)).toEqual([
      "BE-04",
      "BE-01",
    ]);
    expect(queueableSelection(["BE-01"], tasks, true)).toEqual([]);
  });

  it("offers Queue next to Run, with a hint", () => {
    const bar = (queueable: string[]) =>
      render(
        <SelectionBar
          ids={["BE-01", "BE-04"]}
          runnable={["BE-01"]}
          readOnly={false}
          onRun={() => {}}
          onClear={() => {}}
          queueable={queueable}
          onQueue={() => {}}
        />,
      );
    const html = bar(["BE-01", "BE-04"]);
    expect(html).toContain(">Encolar<");
    expect(html).toContain("Se encolarán 2: BE-01, BE-04.");
    expect(bar([])).toContain("Solo se pueden encolar tareas aprobadas en Por hacer.");
    expect(bar([])).toMatch(/disabled=""[^>]*>Encolar/);
  });
});

describe("runs that wait for an approval stand out (RUN-26)", () => {
  it("in the queue view: the entry and the active run say so, with a link to the task", () => {
    const asking = { ...run("BE-01", "waiting_approval"), id: "r-01JC8Z3K2QX7M4V9T0B6N5R801" };
    expect(entryWaitText({ kind: "running", run: asking.id }, claude, [asking])).toBe(
      `Espera tu aprobación (${asking.id})`,
    );
    const html = render(
      <ProjectQueueView project={{ id: "p-1", name: "demo" }} view={view} runs={[asking]} />,
    );
    expect(html).toContain(`Espera tu aprobación (${asking.id})`);
    expect(html).toContain("k-badge--approval");
    expect(html).toContain('href="#/p/p-1?task=BE-01">abre la tarea para decidir');
  });

  it("on the board: the card of a task whose run asks for approval is marked", () => {
    expect(
      [
        ...awaitingApproval(
          [run("BE-01", "waiting_approval"), run("BE-02", "running")],
          [{ task: "BE-03" }],
        ),
      ].sort(),
    ).toEqual(["BE-01", "BE-03"]);
    const card = render(
      <TaskCard id="BE-01" title="Caché" state="doing" awaitingApproval onOpen={() => {}} />,
    );
    expect(card).toContain("k-card--approval");
    expect(card).toContain("Espera tu aprobación");
    expect(render(<TaskCard id="BE-02" title="x" state="doing" />)).not.toContain(
      "k-card--approval",
    );
  });
});
