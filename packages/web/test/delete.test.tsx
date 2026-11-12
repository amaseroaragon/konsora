import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { confirmDelete } from "../src/shell/board-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "agent:claude" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 4 },
  tasks: [
    task("BE-01", "proposed"),
    task("BE-02", "todo"),
    task("BE-03", "done", {
      notes: [{ id: "n1", at, by: "agent:claude", kind: "summary", text: "Hecho con **LRU**" }],
    }),
    task("BE-04", "todo", { deps: ["BE-02"] }),
  ],
};
const boardTasks = (plan: TasksDocument): BoardTask[] => {
  const flags = deriveFlags(plan);
  return plan.tasks.map(
    (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
  );
};
const tasks = boardTasks(doc);

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

const panel = (id: string) =>
  wrap(
    <TaskPanel
      projectId="p"
      task={tasks.find((t) => t.id === id) as BoardTask}
      doc={doc}
      groupName="Backend"
      external={[]}
      readOnly={false}
      onClose={() => {}}
      onOpen={() => {}}
    />,
  );

describe("deleting and promoting from the panel", () => {
  it("sends delete and promote conditioned on the version the panel showed", () => {
    const first = tasks[0] as BoardTask;
    expect(actionBody({ task: first, action: "delete" })).toEqual({
      op: "delete",
      task: "BE-01",
      expect: { "BE-01": first.hash },
    });
    expect(actionBody({ task: first, action: "promote" }).op).toBe("promote");
  });

  it("offers promote on ideas, reopen on done work and delete on every task", () => {
    expect(panel("BE-01")).toMatch(/Pasar a Por hacer[\s\S]*Eliminar/);
    expect(panel("BE-02")).not.toContain("Pasar a Por hacer");
    expect(panel("BE-02")).toContain(">Eliminar<");
    expect(panel("BE-03")).toContain("Reabrir");
  });

  it("asks before deleting, naming the tasks that lose the dependency", () => {
    const asked: string[] = [];
    const ask = (question: string) => {
      asked.push(question);
      return false;
    };
    expect(confirmDelete(["BE-02"], ["BE-04"], ask)).toBe(false);
    expect(confirmDelete(["BE-01"], [], ask)).toBe(false);
    expect(confirmDelete(["BE-01", "BE-03"], [], ask)).toBe(false);
    expect(confirmDelete(["BE-01", "BE-02"], ["BE-04", "BE-05"], ask)).toBe(false);
    expect(asked).toEqual([
      "¿Eliminar BE-02? Se borrará del plan y dejará de ser una dependencia de BE-04.",
      "¿Eliminar BE-01? Se borrará del plan y su id no se reutilizará.",
      "¿Eliminar BE-01, BE-03? Se borrarán del plan y sus ids no se reutilizarán.",
      "¿Eliminar BE-01, BE-02? Se borrarán del plan y dejarán de ser dependencias de BE-04, BE-05.",
    ]);
  });

  it("shows a done task's summary first, and no block field", () => {
    const html = panel("BE-03");
    expect(html).toContain("Resumen de cierre");
    expect(html).toContain("<strong>LRU</strong>");
    expect(html).not.toContain("Bloque");
  });
});
