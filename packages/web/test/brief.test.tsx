import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-10T10:00:00Z";
const task = (id: string, state: Task["state"], deps?: string[]): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  ...(deps ? { deps } : {}),
  created: { at, by: "human" },
  updated_at: at,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  tasks: [
    task("BE-01", "todo"),
    task("BE-02", "doing"),
    task("BE-03", "todo", ["BE-02"]),
    task("BE-04", "proposed"),
    task("BE-05", "done"),
  ],
};
const panel = (id: string) => {
  const t = doc.tasks.find((x) => x.id === id) as Task;
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={{ ...t, ...(deriveFlags(doc).get(id) as object), hash: taskHash(t) } as BoardTask}
            doc={doc}
            groupName="Backend"
            external={[]}
            readOnly={false}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
};

describe("copy a brief for an agent (UI-28)", () => {
  it("is offered on ready and in-progress tasks, with the id", () => {
    for (const id of ["BE-01", "BE-02"]) {
      expect(panel(id)).toContain("Copiar encargo para un agente");
      expect(panel(id)).toContain("Copiar id");
    }
  });

  it("is not offered on blocked tasks, ideas or finished work", () => {
    for (const id of ["BE-03", "BE-04", "BE-05"]) expect(panel(id)).not.toContain("Copiar encargo");
  });
});
