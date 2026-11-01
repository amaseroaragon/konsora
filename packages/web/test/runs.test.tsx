import { deriveFlags, type Run, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import {
  applyRunMessage,
  cancelRunRequest,
  runEventsKey,
  runsKey,
  startRunRequest,
} from "../src/api/runs.ts";
import {
  agentForRun,
  appendEvent,
  canRun,
  DEFAULT_AGENT,
  logRows,
  type RunEventRecord,
  runnableSelection,
  runUsage,
  touchedFiles,
  upsertRun,
} from "../src/shell/run-model.ts";
import { SelectionBar } from "../src/shell/SelectionBar.tsx";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state: "todo",
  group: "BE",
  rank: id.toLowerCase().replace("-", ""),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [task("BE-01"), task("BE-02", { deps: ["BE-01"] }), task("BE-03", { state: "doing" })],
};
const flags = deriveFlags(doc);
const board = (id: string, extra: Partial<Task> = {}): BoardTask => {
  const t = { ...(doc.tasks.find((x) => x.id === id) as Task), ...extra };
  return { ...t, ...(flags.get(id) as object), hash: taskHash(t) } as BoardTask;
};

const run = (extra: Partial<Run> = {}): Run => ({
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-01",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "sonnet", permissions: "default" },
  state: "running",
  started_at: "2026-11-02T10:00:00Z",
  ...extra,
});
const ev = (t: string, extra: Record<string, unknown> = {}): RunEventRecord => ({
  at: "2026-11-02T10:00:05Z",
  t,
  ...extra,
});

function render(node: ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}

const panel = (t: BoardTask, runs: Run[] | undefined, readOnly = false) => (
  <TaskPanel
    projectId="p"
    task={t}
    doc={doc}
    groupName="Backend"
    external={[]}
    readOnly={readOnly}
    runs={runs}
    onClose={() => {}}
    onOpen={() => {}}
  />
);

/** A fetch that records requests and answers with `reply`. */
function recorder(reply: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, api: createApi("ab".repeat(32), { fetch }) };
}

describe("run model (UI-10)", () => {
  const events: RunEventRecord[] = [
    ev("started", { model: "sonnet", session: "s-1" }),
    ev("tool", { phase: "start", id: "1", name: "Read", summary: "src/app.ts" }),
    ev("tool", { phase: "end", id: "1", name: "Read", summary: "ok", ok: true }),
    ev("tool", { phase: "start", id: "2", name: "Write", summary: "src/cache.ts" }),
    ev("file", { path: "src/cache.ts", change: "add" }),
    ev("file", { path: "src/app.ts", change: "modify" }),
    ev("file", { path: "src/cache.ts", change: "modify" }),
    ev("tool", { phase: "start", id: "3", name: "Bash", summary: "npm test" }),
    ev("tool", { phase: "end", id: "3", name: "Bash", summary: "1 failing", ok: false }),
    ev("usage", { input_tokens: 1200, output_tokens: 300, cost_usd: 0.05 }),
    ev("message", { text: "Hecho.", final: true }),
    ev("turn_end", { ok: true }),
    ev("finished", { ok: true }),
  ];

  it("turns events into log rows, leaving out noise", () => {
    expect(logRows(events).map((row) => [row.kind, row.text])).toEqual([
      ["start", "Empieza con sonnet"],
      ["read", "Read · src/app.ts"],
      ["edit", "Write · src/cache.ts"],
      ["bash", "Bash · npm test"],
      ["error", "Bash · 1 failing"],
      ["message", "Hecho."],
      ["end", "El agente terminó"],
    ]);
  });

  it("lists touched files once with their latest change, and sums live usage", () => {
    expect(touchedFiles(events)).toEqual([
      { path: "src/app.ts", change: "modify" },
      { path: "src/cache.ts", change: "modify" },
    ]);
    expect(runUsage(run(), events)).toEqual({ input: 1200, output: 300, cost: 0.05 });
    expect(
      runUsage(run({ usage: { input_tokens: 9, output_tokens: 8, cost_usd: null } }), events),
    ).toEqual({ input: 9, output: 8, cost: null });
  });

  it("keeps runs in order and drops an event that arrives twice", () => {
    const a = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PA" });
    const b = run({ id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PB" });
    expect(upsertRun(upsertRun([b], a), { ...b, state: "failed" })).toEqual([
      a,
      { ...b, state: "failed" },
    ]);
    const once = appendEvent([events[0] as RunEventRecord], events[1] as RunEventRecord);
    expect(appendEvent(once, events[1] as RunEventRecord)).toHaveLength(2);
  });

  it("sends Claude with the default profile unless the task or plan names an agent", () => {
    expect(agentForRun({}, {})).toEqual(DEFAULT_AGENT);
    expect(agentForRun({}, { defaults: { provider: "claude", model: "opus" } })).toBeUndefined();
    expect(agentForRun({ agent: { provider: "claude", model: "haiku" } }, {})).toBeUndefined();
  });
});

describe("launching runs (UI-10 ac1)", () => {
  it("posts the task (and the agent) to the daemon", async () => {
    const { calls, api } = recorder({ run: run({ state: "starting" }) });
    const started = await startRunRequest(api, "p 1", { task: "BE-01", agent: DEFAULT_AGENT });
    expect(started.state).toBe("starting");
    expect(calls).toEqual([
      {
        url: "/api/projects/p%201/runs",
        method: "POST",
        body: { task: "BE-01", agent: DEFAULT_AGENT },
      },
    ]);
  });

  it("offers Run on a ready task and shows the run's log, which grows live without reloading", () => {
    const client = new QueryClient();
    expect(render(panel(board("BE-01"), []), client)).toContain("Ejecutar →");

    const live = run();
    client.setQueryData(runsKey("p"), [live]);
    client.setQueryData(runEventsKey("p", live.id), [ev("started", { model: "sonnet" })]);
    const first = render(panel(board("BE-01", { state: "doing" }), [live]), client);
    expect(first).toContain("En ejecución");
    expect(first).toContain("Empieza con sonnet");
    expect(first).not.toContain("Ejecutar →");

    // WebSocket messages update the cache in place.
    applyRunMessage(client, "p", {
      type: "run.event",
      run: live.id,
      event: ev("tool", { phase: "start", name: "Edit", summary: "src/app.ts" }),
    });
    applyRunMessage(client, "p", {
      type: "run.event",
      run: live.id,
      event: ev("file", { path: "src/app.ts", change: "modify" }),
    });
    applyRunMessage(client, "p", {
      type: "run.state",
      run: { ...live, state: "waiting_approval" },
    });
    const runs = client.getQueryData<Run[]>(runsKey("p"));
    const second = render(panel(board("BE-01", { state: "doing" }), runs), client);
    expect(second).toContain("Edit · src/app.ts");
    expect(second).toContain("Esperando aprobación");
    expect(second).toMatch(/src\/app\.ts<\/span> <span class="s-muted">modificado/);
    expect(second).toContain("Cancelar run");
  });
});

describe("cancelling (UI-10 ac2)", () => {
  it("posts the cancel and shows the run cancelled, without Cancel, once the task is back in todo", async () => {
    const { calls, api } = recorder({ run: run({ state: "cancelled" }) });
    const cancelled = await cancelRunRequest(api, "p", run().id);
    expect(calls[0]).toMatchObject({
      url: `/api/projects/p/runs/${run().id}/cancel`,
      method: "POST",
    });

    const client = new QueryClient();
    client.setQueryData(runsKey("p"), [run()]);
    applyRunMessage(client, "p", { type: "run.state", run: cancelled });
    client.setQueryData(runEventsKey("p", cancelled.id), [ev("cancel"), ev("cancelled")]);
    const out = render(panel(board("BE-01"), client.getQueryData<Run[]>(runsKey("p"))), client);
    expect(out).toContain("Cancelado");
    expect(out).toContain("Run cancelado");
    expect(out).not.toContain("Cancelar run");
    expect(out).toContain("Por hacer");
    // The task is ready again: it can be run anew.
    expect(out).toContain("Ejecutar →");
  });
});

describe("where Run is not available (UI-10 ac3)", () => {
  it("is not offered on tasks that are not ready, or in read-only mode", () => {
    expect(render(panel(board("BE-02"), []))).not.toContain("Ejecutar →"); // blocked
    expect(render(panel(board("BE-03"), []))).not.toContain("Ejecutar →"); // doing
    expect(render(panel(board("BE-01"), [], true))).not.toContain("Ejecutar →"); // read-only
    expect(render(panel(board("BE-01"), undefined))).not.toContain("Ejecutar →"); // runs loading
    expect(
      canRun(board("BE-01"), {
        readOnly: false,
        runs: [run({ state: "interrupted" })],
        id: "BE-01",
      }),
    ).toBe(false);
  });

  it("launches only the ready tasks of a selection, and is disabled otherwise", () => {
    const tasks = [board("BE-01"), board("BE-02"), board("BE-03")];
    expect(
      runnableSelection(["BE-03", "BE-02", "BE-01"], tasks, { readOnly: false, runs: [] }),
    ).toEqual(["BE-01"]);
    expect(runnableSelection(["BE-01"], tasks, { readOnly: true, runs: [] })).toEqual([]);
    expect(runnableSelection(["BE-01"], tasks, { readOnly: false, runs: undefined })).toEqual([]);

    const bar = (runnable: string[], readOnly = false) =>
      render(
        <SelectionBar
          ids={["BE-01", "BE-02"]}
          runnable={runnable}
          readOnly={readOnly}
          onRun={() => {}}
          onClear={() => {}}
        />,
      );
    const enabled = bar(["BE-01"]);
    expect(enabled).toContain("Se lanzarán las 1 listas: BE-01.");
    expect(enabled).not.toMatch(/a-selection__run"[^>]*disabled/);
    expect(bar([])).toMatch(/disabled=""[^>]*>Ejecutar|a-selection__run[^>]*disabled/);
    expect(bar([])).toContain("Ninguna de las seleccionadas está lista para ejecutarse.");
    expect(bar(["BE-01"], true)).toContain(
      "No se puede ejecutar mientras el plan es de solo lectura.",
    );
  });
});
