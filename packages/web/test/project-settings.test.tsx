import { applyOp, OpSchema, type Task, type TasksDocument } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ProjectSettings } from "../src/shell/ProjectSettings.tsx";
import { groupUse, moveGroup, newGroupIdError } from "../src/shell/project-settings-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, group: string): Task => ({
  id,
  title: id,
  state: "todo",
  group,
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});
const plan: TasksDocument = {
  schema: "konsora/5",
  project: { name: "Weather" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
    { id: "OPS", name: "Ops" },
  ],
  seq: { BE: 2, FE: 1, OPS: 0 },
  archived: ["FE-01"],
  tasks: [task("BE-01", "BE"), task("BE-02", "OPS")],
};

const render = (readOnly = false) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ProjectSettings projectId="p" plan={plan} readOnly={readOnly} />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("project name and groups in Ajustes (CORE-13)", () => {
  it("counts what keeps a group in use: its tasks, ids with its prefix and archived ids", () => {
    expect(groupUse(plan, "BE")).toBe(2); // BE-01, and BE-02 moved to OPS
    expect(groupUse(plan, "OPS")).toBe(1);
    expect(groupUse(plan, "FE")).toBe(1); // archived FE-01
    expect(groupUse({ tasks: [] }, "FE")).toBe(0);
  });

  it("moves a group one place, and builds a valid reorder op", () => {
    const ids = plan.groups.map((g) => g.id);
    expect(moveGroup(ids, 2, -1)).toEqual(["BE", "OPS", "FE"]);
    expect(moveGroup(ids, 0, -1)).toEqual(ids);
    expect(moveGroup(ids, 2, 1)).toEqual(ids);
    const op = { op: "reorder-groups" as const, ids: moveGroup(ids, 0, 1) };
    expect(OpSchema.safeParse(op).success).toBe(true);
    const result = applyOp(plan, op, { actor: "human", at });
    expect(result.ok && result.document.groups.map((g) => g.id)).toEqual(["FE", "BE", "OPS"]);
  });

  it("checks a new group's id before sending it", () => {
    expect(newGroupIdError("API", ["BE"])).toBeUndefined();
    expect(newGroupIdError("BE", ["BE"])).toBe("groups.error.id.twice");
    for (const bad of ["", "1A", "TOOLONG", "A-B"])
      expect(newGroupIdError(bad, ["BE"])).toBe("groups.error.id");
  });

  it("shows the project's name and every group, with removal only for unused ones", () => {
    const html = render();
    expect(html).toContain("Proyecto y grupos");
    expect(html).toContain('value="Weather"');
    for (const name of ["Backend", "Frontend", "Ops"]) expect(html).toContain(`value="${name}"`);
    expect(html).toContain("2 tareas");
    // Every group is in use here, so no ✕ is enabled.
    const removes = html.match(/<button[^>]*>✕<span class="k-visually-hidden">Quitar el grupo/g);
    expect(removes).toHaveLength(3);
    for (const button of removes ?? []) expect(button).toContain("disabled");
    expect(html).toContain("Añadir grupo");
  });

  it("disables everything on a read-only plan", () => {
    const html = render(true);
    const input = html.match(/<input[^>]*value="Weather"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('disabled=""');
  });
});
