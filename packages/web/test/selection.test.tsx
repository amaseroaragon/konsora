import {
  deriveFlags,
  pendingSubgraph,
  type Task,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import type { ProjectViewName } from "../src/shell/route.ts";
import {
  createSelectionStore,
  selectionReducer,
  selectionStore,
  visibleSelection,
} from "../src/shell/selection.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], deps: string[] = []): Task => ({
  id,
  title: `Título ${id}`,
  state,
  group: "BE",
  ...(deps.length ? { deps } : {}),
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});

const doc: TasksDocument = {
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  tasks: [
    task("BE-01", "done"),
    task("BE-02", "todo", ["BE-01"]),
    task("BE-03", "review"),
    task("BE-04", "todo", ["BE-02", "BE-03"]),
    task("BE-05", "todo"),
  ],
};

function boardOf(plan: TasksDocument, id: string): BoardOk {
  const flags = deriveFlags(plan);
  const { tasks, ...rest } = plan;
  return {
    status: "ok",
    project: { id, name: "P", path: "/p", added_at: at },
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

describe("selection state", () => {
  it("toggles, adds and clears without touching unrelated ids", () => {
    let s = selectionReducer(new Set(), { type: "toggle", id: "A" });
    expect([...s]).toEqual(["A"]);
    s = selectionReducer(s, { type: "add", ids: ["B", "C"] });
    expect([...s]).toEqual(["A", "B", "C"]);
    expect(selectionReducer(s, { type: "add", ids: ["A"] })).toBe(s);
    s = selectionReducer(s, { type: "toggle", id: "A" });
    expect([...s]).toEqual(["B", "C"]);
    expect([...selectionReducer(s, { type: "clear" })]).toEqual([]);
  });

  it("shows only tasks that still exist and are not done, in plan order", () => {
    const stored = new Set(["BE-04", "BE-01", "GONE", "BE-02"]);
    expect(visibleSelection(stored, doc.tasks)).toEqual(["BE-02", "BE-04"]);
  });

  it("keeps one selection per project and notifies on change only", () => {
    const store = createSelectionStore();
    const calls: number[] = [];
    store.subscribe(() => calls.push(1));
    store.dispatch("p1", { type: "toggle", id: "A" });
    store.dispatch("p1", { type: "add", ids: ["A"] });
    expect([...store.get("p1")]).toEqual(["A"]);
    expect([...store.get("p2")]).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("selection shared by graph and board (UI-07)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const render = (board: BoardOk, view: ProjectViewName) =>
    renderToStaticMarkup(
      <ApiContext.Provider value={createApi("ab".repeat(32))}>
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <ProjectView board={board} live="live" view={view} openId={null} />
          </ToastProvider>
        </QueryClientProvider>
      </ApiContext.Provider>,
    );

  it("a subgraph selected in the graph survives going to the board and back (ac1, ac2)", () => {
    const board = boardOf(doc, "p-sel000000001");
    const ids = pendingSubgraph("BE-04", doc);
    expect(ids).toEqual(["BE-02", "BE-03", "BE-04"]);
    // What «Seleccionar con dependencias» does from the graph.
    selectionStore.dispatch(board.project.id, { type: "add", ids });

    const graph = render(board, "graph");
    expect(graph).toContain("3 tareas seleccionadas:");
    expect(graph).toContain("BE-02, BE-03, BE-04");

    const onBoard = render(board, "board");
    expect(onBoard).toContain("3 tareas seleccionadas:");
    const box = (id: string) =>
      onBoard.match(new RegExp(`<input[^>]*"Seleccionar ${id}"[^>]*>`))?.[0];
    for (const id of ids) expect(box(id)).toContain('checked=""');
    expect(box("BE-05")).not.toContain('checked=""');

    expect(render(board, "graph")).toContain("BE-02, BE-03, BE-04");
  });

  it("selecting and clearing never call the daemon, so the plan is not written (ac3)", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const project = "p-sel000000002";
    selectionStore.dispatch(project, { type: "toggle", id: "BE-05" });
    selectionStore.dispatch(project, { type: "add", ids: pendingSubgraph("BE-04", doc) });
    render(boardOf(doc, project), "board");
    selectionStore.dispatch(project, { type: "clear" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Run disabled until the runs are known, so it never launches a task twice (UI-10)", () => {
    const board = boardOf(doc, "p-sel000000003");
    selectionStore.dispatch(board.project.id, { type: "toggle", id: "BE-05" });
    const html = render(board, "board");
    expect(html).toContain("1 tarea seleccionada:");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ejecutar/);
    expect(html).toContain("Ninguna de las seleccionadas está lista para ejecutarse.");
  });
});
