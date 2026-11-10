import {
  type AgentCatalogEntry,
  type AgentSpec,
  deriveFlags,
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
import { enqueueRequest, type QueueView, queueKey } from "../src/api/queue.ts";
import { canQueueTask, queueableSelection, queuePlace } from "../src/shell/queue-model.ts";
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
const task = (id: string, state: Task["state"], deps: string[] = []): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id,
  created: { at, by: "human" },
  updated_at: at,
  ...(deps.length ? { deps } : {}),
});
const docOf = (tasks: Task[]): TasksDocument => ({
  schema: "konsora/2",
  project: { name: "P", base_branch: "main", defaults: claude },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: tasks.length },
  tasks,
});
const boardTask = (tasks: Task[], id: string): BoardTask => {
  const current = tasks.find((x) => x.id === id) as Task;
  const flags = deriveFlags(docOf(tasks));
  return { ...current, ...(flags.get(id) as object), hash: taskHash(current) } as BoardTask;
};

/** The queue view with these tasks queued in this order, each waiting for a free slot. */
const queued = (ids: string[]): QueueView => ({
  queue: {
    version: 1,
    state: "running",
    entries: ids.map((id) => ({ task: id, agent: claude, added_at: at })),
  },
  status: ids.map((id) => ({ task: id, wait: { kind: "slot", limit: "global" } })),
  limits: { max_parallel: 2, per_provider: {} },
  usage: { total: 0, per_provider: {} },
});

function panel(
  tasks: Task[],
  id: string,
  options: { readOnly?: boolean; queue?: QueueView } = {},
): string {
  const client = new QueryClient();
  client.setQueryData(agentsKey, catalog);
  if (options.queue) client.setQueryData(queueKey("p"), options.queue);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={boardTask(tasks, id)}
            doc={docOf(tasks)}
            groupName="Backend"
            external={[]}
            readOnly={options.readOnly ?? false}
            runs={[]}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

describe("queueing from the task panel (UI-42)", () => {
  it("offers Encolar next to Ejecutar on an approved task in Por hacer", () => {
    const html = panel([task("BE-01", "todo")], "BE-01");
    expect(html).toContain(">Encolar<");
    expect(html).toContain("Ejecutar");
    expect(html.indexOf("Ejecutar")).toBeLessThan(html.indexOf(">Encolar<"));
    expect(html).not.toContain("En la cola");
  });

  it("sends the task with the agent of the selector to the queue", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ...queued(["BE-01"]), added: ["BE-01"], already: [] }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;
    // The panel's Encolar sends the agent its picker shows, here one the human chose.
    await enqueueRequest(createApi("ab".repeat(32), { fetch }), "p", [
      { task: "BE-01", agent: codex },
    ]);
    expect(calls).toEqual([
      {
        url: "/api/projects/p/queue",
        body: { items: [{ task: "BE-01", agent: codex }] },
      },
    ]);
  });

  it("offers Encolar on a blocked task, without Ejecutar", () => {
    const tasks = [task("BE-00", "todo"), task("BE-01", "todo", ["BE-00"])];
    const html = panel(tasks, "BE-01");
    expect(html).toContain(">Encolar<");
    expect(html).not.toContain("Ejecutar");
  });

  it("does not offer Encolar on a proposed, running, reviewed or finished task", () => {
    for (const state of ["proposed", "doing", "review", "done"] as const) {
      expect(panel([task("BE-01", state)], "BE-01")).not.toContain(">Encolar<");
    }
    expect(canQueueTask({ state: "proposed" }, false)).toBe(false);
    expect(canQueueTask({ state: "done" }, false)).toBe(false);
  });

  it("does not offer Encolar in read-only mode", () => {
    expect(panel([task("BE-01", "todo")], "BE-01", { readOnly: true })).not.toContain(">Encolar<");
    expect(canQueueTask({ state: "todo" }, true)).toBe(false);
  });

  it("keeps the selection bar's rule: approved and still to do, blocked ones included", () => {
    const tasks = [
      { id: "BE-01", state: "todo" },
      { id: "BE-02", state: "proposed" },
      { id: "BE-03", state: "todo" },
    ];
    expect(queueableSelection(["BE-01", "BE-02", "BE-03"], tasks, false)).toEqual([
      "BE-01",
      "BE-03",
    ]);
  });

  it("says where a queued task is and offers to take it out instead of Encolar", () => {
    const tasks = [task("BE-01", "todo"), task("BE-02", "todo")];
    const html = panel(tasks, "BE-02", { queue: queued(["BE-01", "BE-02"]) });
    expect(html).toContain("En la cola, posición 2 de 2.");
    expect(html).toContain(">Quitar de la cola<");
    expect(html).not.toContain(">Encolar<");
  });

  it("gives the place in launch order, and none for a task that is not queued", () => {
    const view = queued(["BE-03", "BE-01"]);
    expect(queuePlace(view.status, "BE-03")).toBe(1);
    expect(queuePlace(view.status, "BE-01")).toBe(2);
    expect(queuePlace(view.status, "BE-02")).toBeUndefined();
    expect(queuePlace(undefined, "BE-01")).toBeUndefined();
  });
});
