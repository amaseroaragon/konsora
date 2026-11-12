import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask, moveBody } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
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
    task("BE-03", "doing"),
    task("BE-04", "done"),
  ],
};

function boardTasks(plan: TasksDocument): BoardTask[] {
  const flags = deriveFlags(plan);
  return plan.tasks.map(
    (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
  );
}

const panel = (id: string, plan: TasksDocument = doc, readOnly = false) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={boardTasks(plan).find((t) => t.id === id) as BoardTask}
            doc={plan}
            groupName="Backend"
            external={[]}
            readOnly={readOnly}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)/g)].map((m) => m[1]);

describe("back to the ideas (CORE-12)", () => {
  it("offers it on a todo task only, next to deleting", () => {
    expect(buttons(panel("BE-02"))).toContain("Devolver a Ideas");
    for (const id of ["BE-01", "BE-03", "BE-04"])
      expect(buttons(panel(id))).not.toContain("Devolver a Ideas");
    expect(buttons(panel("BE-02", doc, true))).not.toContain("Devolver a Ideas");
  });

  it("is one op, from the panel or by dragging to the Ideas column", () => {
    const todo = boardTasks(doc).find((t) => t.id === "BE-02") as BoardTask;
    const expected = { op: "demote", task: "BE-02", expect: { "BE-02": todo.hash } };
    expect(actionBody({ task: todo, action: "demote" })).toEqual(expected);
    expect(moveBody({ task: todo, op: "demote", to: "proposed" })).toEqual(expected);
  });
});
