import {
  deriveFlags,
  type Task,
  type TaskFilter,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state,
  group: id.split("-")[0] as string,
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 2, FE: 1 },
  tasks: [
    task("BE-01", "todo", { title: "Cache de previsiones", labels: ["perf"] }),
    task("BE-02", "todo", { title: "Proxy", desc: "Sirve la **cache** al cliente." }),
    task("FE-01", "proposed", { title: "Mostrar la edad", labels: ["perf", "ui"] }),
  ],
};

function boardOf(plan: TasksDocument): BoardOk {
  const flags = deriveFlags(plan);
  const { tasks, ...rest } = plan;
  return {
    status: "ok",
    project: { id: "p-000000000000", name: "P", path: "/p", added_at: at },
    hash: "sha256:x",
    external: [],
    plan: rest,
    tasks: tasks.map((t) => ({
      ...t,
      ...(flags.get(t.id) as NonNullable<ReturnType<typeof flags.get>>),
      hash: taskHash(t),
    })),
  };
}

const render = (filter?: TaskFilter) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ProjectView
            board={boardOf(doc)}
            live="live"
            view="board"
            openId={null}
            filter={filter}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const cards = (html: string) =>
  [...html.matchAll(/id="task-([A-Z]+-\d+)-title"/g)].map((m) => m[1]);

describe("task filter on the board (UI-10)", () => {
  it("without a filter every task is shown and nothing is reported hidden", () => {
    const html = render();
    expect(cards(html)).toEqual(["BE-01", "BE-02", "FE-01"]);
    expect(html).toContain("Buscar por id, título o descripción");
    expect(html).not.toContain("Quitar filtro");
  });

  it("text leaves only the tasks whose id, title or description contain it (ac1)", () => {
    const html = render({ text: "cache" });
    expect(cards(html)).toEqual(["BE-01", "BE-02"]);
    expect(html).toContain("1 tarea oculta por el filtro");
    expect(html).toContain("Quitar filtro");
  });

  it("filters by group and by label, with the hidden count (ac2, ac3)", () => {
    expect(cards(render({ group: "FE" }))).toEqual(["FE-01"]);
    const html = render({ label: "perf" });
    expect(cards(html)).toEqual(["BE-01", "FE-01"]);
    expect(html).toContain("1 tarea oculta por el filtro");
    expect(render({ label: "perf", group: "BE" })).toContain("2 tareas ocultas por el filtro");
  });

  it("says so when nothing matches, and still offers to remove the filter", () => {
    const html = render({ text: "nada de esto" });
    expect(cards(html)).toEqual([]);
    expect(html).toContain("Ninguna tarea coincide con el filtro.");
    expect(html).toContain("3 tareas ocultas por el filtro");
    expect(html).toContain("Quitar filtro");
  });

  it("offers the plan's groups and labels as choices", () => {
    const html = render();
    expect(html).toContain("BE · Backend");
    expect(html).toContain('<option value="perf">perf</option>');
    expect(html).toContain('<option value="ui">ui</option>');
  });
});
