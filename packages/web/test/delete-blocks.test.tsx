import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { BlocksView, mergeErrorText } from "../src/shell/BlocksView.tsx";
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
const block = {
  id: "cache",
  name: "Caché de previsión",
  branch: "konsora/cache",
  base: "main",
  created: { at, by: "agent:claude" },
};
const doc: TasksDocument = {
  schema: "konsora/4",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 4 },
  blocks: [block],
  tasks: [
    task("BE-01", "proposed"),
    task("BE-02", "todo", { block: "cache" }),
    task("BE-03", "done", {
      block: "cache",
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

  it("shows a done task's summary first and its block, changeable while the block is open", () => {
    const html = panel("BE-03");
    expect(html).toContain("Resumen de cierre");
    expect(html).toContain("<strong>LRU</strong>");
    expect(html).toContain("Caché de previsión · konsora/cache");
    expect(html).toMatch(/<select[^>]*>[\s\S]*Sin bloque/);
  });
});

describe("blocks view", () => {
  it("lists each block with its branch, progress and tasks; merge only when ready", () => {
    const open = wrap(
      <BlocksView projectId="p" doc={doc} tasks={tasks} readOnly={false} onOpen={() => {}} />,
    );
    expect(open).toContain("konsora/cache → main");
    expect(open).toContain("1 de 2 hechas");
    expect(open).toContain("Abierto");
    expect(open).not.toContain("Hacer merge en main");
    const ready: TasksDocument = {
      ...doc,
      tasks: doc.tasks.map((t) => (t.id === "BE-02" ? { ...t, state: "done" } : t)),
    };
    const html = wrap(
      <BlocksView
        projectId="p"
        doc={ready}
        tasks={boardTasks(ready)}
        readOnly={false}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Listo para merge");
    expect(html).toContain("Hacer merge en main");
    expect(html).toContain("Un solo commit (squash)");
    const readOnly = wrap(
      <BlocksView projectId="p" doc={ready} tasks={tasks} readOnly onOpen={() => {}} />,
    );
    expect(readOnly).not.toContain("Hacer merge");
    expect(readOnly).not.toContain("Nuevo bloque");
  });

  it("explains a refused merge in Spanish", () => {
    expect(mergeErrorText("git_conflict", block, "x")).toBe(
      "konsora/cache choca con main: no se ha cambiado nada. Resuelve el conflicto en la rama y vuelve a intentarlo.",
    );
    expect(mergeErrorText("git_dirty", block, "x")).toContain("Haz commit o stash");
    expect(mergeErrorText("weird", block, "boom")).toBe("No se pudo hacer el merge: boom");
  });
});
