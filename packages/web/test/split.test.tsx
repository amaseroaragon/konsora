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
const task = (id: string, state: Task["state"]): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
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
const panel = (id: string, readOnly = false) => {
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
            readOnly={readOnly}
            onClose={() => {}}
            onOpen={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
};

describe("split from the task panel (CORE-20)", () => {
  it("offers it for ideas and todo tasks only, and never on a read-only plan", () => {
    expect(panel("BE-01")).toContain("Dividir en varias");
    expect(panel("BE-02")).toContain("Dividir en varias");
    expect(panel("BE-03")).not.toContain("Dividir en varias");
    expect(panel("BE-04")).not.toContain("Dividir en varias");
    expect(panel("BE-02", true)).not.toContain("Dividir en varias");
  });
});
