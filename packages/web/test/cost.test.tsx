import { deriveFlags, type Run, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk, BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { applyRunMessage, runsKey } from "../src/api/runs.ts";
import { costLine, costText } from "../src/shell/cost-model.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { parseRoute } from "../src/shell/route.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-10T10:00:00Z";
const task = (id: string, group: string, state: Task["state"] = "todo"): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group,
  rank: id.toLowerCase(),
  created: { at, by: "human" },
  updated_at: at,
});
const doc: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 2, FE: 1 },
  tasks: [task("BE-01", "BE", "review"), task("BE-02", "BE", "doing"), task("FE-01", "FE")],
};
const flags = deriveFlags(doc);
const boardTasks = doc.tasks.map(
  (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
);
const { tasks: _tasks, ...plan } = doc;
const board: BoardOk = {
  status: "ok",
  project: { id: "p-cost0000001", name: "P", path: "/p", added_at: at },
  hash: "sha256:x",
  external: [],
  plan,
  tasks: boardTasks,
};

let n = 0;
const run = (
  task: string,
  provider: "claude" | "codex",
  usage: Run["usage"],
  state: Run["state"] = "succeeded",
): Run => {
  n += 1;
  return {
    id: `r-01JC8Z3K2QX7M4V9T0B6N5R8${String(n).padStart(2, "0")}`,
    task,
    task_hash: `sha256:${"a".repeat(64)}`,
    agent: { provider, model: provider === "claude" ? "opus" : "gpt-6-luna" },
    state,
    ...(usage ? { usage } : {}),
  };
};
const claude1 = run("BE-01", "claude", {
  input_tokens: 10_000,
  output_tokens: 2000,
  cost_usd: 1.5,
});
const codex1 = run("BE-01", "codex", { input_tokens: 4000, output_tokens: 1000, cost_usd: null });
const live = run("BE-02", "claude", undefined, "running");
const runs = [claude1, codex1, live];

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
}
const withRuns = (list: Run[]) => {
  const client = new QueryClient();
  client.setQueryData(runsKey(board.project.id), list);
  return client;
};
const view = (client: QueryClient, name: "board" | "cost") =>
  render(<ProjectView board={board} live="live" view={name} openId={null} />, client);

describe("accumulated usage and cost (UI-23 ac1)", () => {
  it("the task panel sums all its runs and says what has no cost", () => {
    const html = render(
      <TaskPanel
        projectId={board.project.id}
        task={boardTasks[0] as BoardTask}
        doc={doc}
        groupName="Backend"
        external={[]}
        readOnly={false}
        runs={runs}
        onClose={() => {}}
        onOpen={() => {}}
      />,
      withRuns(runs),
    );
    expect(html).toContain("Uso acumulado");
    expect(html).toContain("14k / 3k");
    expect(html).toContain("$1.50 + 1 sin coste");
    expect(html).toContain(
      "1 runs sin coste conocido: 1 con tokens de un proveedor que no da el coste",
    );
    expect(html).toContain('Codex · <span class="k-mono">gpt-6-luna</span>');
    expect(html).toContain(">no lo da<");
  });

  it("each group's header on the board shows its tokens and cost", () => {
    const html = view(withRuns(runs), "board");
    expect(html).toContain(
      '<div class="k-matrix__lane-meta">17k tokens · $1.50 + 2 sin coste</div>',
    );
    // A group without runs shows nothing.
    expect(html.match(/k-matrix__lane-meta/g)).toHaveLength(1);
  });

  it("the project's cost view shows the total and each group, with the breakdown", () => {
    expect(parseRoute("#/p/p-1?view=cost")).toMatchObject({ view: "cost" });
    const html = view(withRuns(runs), "cost");
    expect(html).toContain("Uso y coste del proyecto");
    expect(html).toContain("Total del proyecto");
    expect(html).toContain("Grupo Backend");
    expect(html).not.toContain("Grupo Frontend");
    expect(html).toContain("Por proveedor y modelo");
    expect(html).toContain('Claude Code · <span class="k-mono">opus</span>');
  });

  it("an unknown cost is never shown as zero", () => {
    const only = [codex1];
    const totals = {
      runs: 1,
      no_usage_runs: 0,
      input_tokens: 4000,
      output_tokens: 1000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: null,
      cost_unknown_runs: 1,
    };
    expect(costText(totals)).toBe("desconocido");
    expect(costLine(totals)).toBe("5k tokens · desconocido");
    expect(view(withRuns(only), "cost")).not.toContain("$0.00");
  });
});

describe("live sums (UI-23 ac2)", () => {
  it("closing a run updates the sums without reloading", () => {
    const client = withRuns(runs);
    expect(view(client, "board")).toContain("17k tokens · $1.50 + 2 sin coste");
    applyRunMessage(client, board.project.id, {
      type: "run.state",
      run: {
        ...live,
        state: "succeeded",
        usage: { input_tokens: 3000, output_tokens: 500, cost_usd: 0.5 },
      },
    });
    const after = view(client, "board");
    expect(after).toContain("20.5k tokens · $2.00 + 1 sin coste");
  });
});
