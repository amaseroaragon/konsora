import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "doing",
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

function panel(t: Task) {
  const doc: TasksDocument = {
    schema: "konsora/5",
    project: { name: "P" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 9 },
    tasks: [t],
  };
  const board = { ...t, ...(deriveFlags(doc).get(t.id) as object), hash: taskHash(t) } as BoardTask;
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={board}
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
}

describe("who has a task in progress (CORE-09)", () => {
  it("the card of a task in progress names the agent that has it", () => {
    const html = renderToStaticMarkup(
      <TaskCard id="BE-01" state="doing" title="x" startedBy="claude" />,
    );
    expect(html).toContain("Con claude");
    // Only while it is in progress.
    expect(
      renderToStaticMarkup(<TaskCard id="BE-01" state="done" title="x" startedBy="claude" />),
    ).not.toContain("Con claude");
  });

  it("the panel says who has it and since when", () => {
    const html = panel(task("BE-01", { started: { at, by: "agent:codex" } }));
    expect(html).toMatch(/La tiene codex desde el /);
  });

  it("falls back to the last start event, and says nothing without one", () => {
    expect(panel(task("BE-02", { events: [{ at, by: "agent:claude", type: "start" }] }))).toContain(
      "La tiene claude desde el",
    );
    expect(panel(task("BE-03"))).not.toContain("La tiene");
  });
});
