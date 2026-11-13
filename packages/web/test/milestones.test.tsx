import {
  deriveFlags,
  type Task,
  type TaskFilter,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { changesFrom, draftFrom } from "../src/shell/edit-model.ts";
import { MilestoneSettings, newMilestoneIdError } from "../src/shell/MilestoneSettings.tsx";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { parseRoute, projectHref } from "../src/shell/route.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  milestones: [
    { id: "m11", name: "Giro", criterion: "Pruebas manuales hechas" },
    { id: "m12", name: "Sin aprobación" },
  ],
  seq: { BE: 4 },
  tasks: [
    task("BE-01", "done", { milestone: "m11" }),
    task("BE-02", "todo", { milestone: "m11" }),
    task("BE-03", "todo", { milestone: "m12" }),
    task("BE-04", "todo"),
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
    archive: [task("BE-00", "done", { milestone: "m11" })],
  };
}

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const view = (v: "board" | "graph" | "settings", filter?: TaskFilter) =>
  wrap(<ProjectView board={boardOf(doc)} live="live" view={v} openId={null} filter={filter} />);
const cards = (html: string) =>
  [...html.matchAll(/id="task-([A-Z]+-\d+)-title"/g)].map((m) => m[1]);

describe("milestones in the UI (CORE-19)", () => {
  it("the filter offers each milestone with its progress, archived tasks included", () => {
    const html = view("board");
    expect(html).toContain('<option value="m11">Giro · 2/3</option>');
    expect(html).toContain('<option value="m12">Sin aprobación · 0/1</option>');
    expect(html).toContain('<option value="none">Sin hito</option>');
  });

  it("filters the board by milestone and shows its progress and criterion", () => {
    const html = view("board", { milestone: "m11" });
    expect(cards(html).sort()).toEqual(["BE-01", "BE-02"]);
    expect(html).toContain("2 de 3 hechas");
    expect(html).toContain("Hecho cuando: Pruebas manuales hechas");
    expect(html).toMatch(/<progress[^>]*max="3"[^>]*value="2"/);
    expect(cards(view("board", { milestone: "none" }))).toEqual(["BE-04"]);
  });

  it("filters the graph by milestone too", () => {
    // The graph lays itself out in the browser; here it shows the same filtered tasks as the board.
    const html = view("graph", { milestone: "m12" });
    expect(html).toContain("3 tareas ocultas por el filtro");
    expect(html).toContain("0 de 1 hechas");
  });

  it("keeps the milestone filter in the URL", () => {
    const href = projectHref("p", { view: "graph", filter: { milestone: "m11" } });
    const route = parseRoute(href);
    expect(route.name === "project" && route.filter).toEqual({ milestone: "m11" });
  });

  it("Ajustes lists the milestones with progress, and lets remove only empty ones", () => {
    const html = wrap(
      <MilestoneSettings
        projectId="p"
        milestones={[
          { id: "m11", name: "Giro", criterion: "Hecho", done: 1, total: 2 },
          { id: "m13", name: "Vacío", done: 0, total: 0 },
        ]}
        tasks={[{ milestone: "m11" }, { milestone: "m11" }]}
        readOnly={false}
      />,
    );
    expect(html).toContain("1 de 2 hechas");
    expect(html).toContain('value="Hecho"');
    const removes = [
      ...html.matchAll(/<button[^>]*>✕<span class="k-visually-hidden">Quitar el hito (m\d+)/g),
    ];
    expect(removes.map((m) => [m[1], m[0].includes("disabled")])).toEqual([
      ["m11", true],
      ["m13", false],
    ]);
    expect(html).toContain("Añadir hito");
    expect(view("settings")).toContain("Hitos");
  });

  it("checks a new milestone's id", () => {
    expect(newMilestoneIdError("m15", ["m11"])).toBeUndefined();
    expect(newMilestoneIdError("m11", ["m11"])).toBe("milestones.error.id.twice");
    expect(newMilestoneIdError("M 1", [])).toBe("milestones.error.id");
  });

  it("the task editor moves a task into a milestone or out of it", () => {
    const base = task("BE-04", "todo");
    const into = changesFrom({ ...draftFrom(base), milestone: "m11" }, base, doc.groups);
    expect(into.ok && into.changes).toEqual({ milestone: "m11" });
    const inside = task("BE-02", "todo", { milestone: "m11" });
    const out = changesFrom({ ...draftFrom(inside), milestone: "" }, inside, doc.groups);
    expect(out.ok && out.changes).toEqual({ milestone: null });
  });
});
