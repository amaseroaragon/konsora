import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-10T10:00:00Z";
const task: Task = {
  id: "BE-01",
  title: "Cache",
  state: "doing",
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  started: { at, by: "agent:claude" },
  updated_at: at,
};
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [task],
};
const panel = (now: Date) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={
              {
                ...task,
                ...(deriveFlags(doc).get("BE-01") as object),
                hash: taskHash(task),
              } as BoardTask
            }
            doc={doc}
            groupName="Backend"
            external={[]}
            readOnly={false}
            onClose={() => {}}
            onOpen={() => {}}
            now={now}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("abandoned tasks in progress (CORE-10)", () => {
  it("the card of a stale task in progress has a badge", () => {
    expect(renderToStaticMarkup(<TaskCard id="BE-01" state="doing" title="x" stale />)).toContain(
      "k-badge--stale",
    );
    expect(renderToStaticMarkup(<TaskCard id="BE-01" state="doing" title="x" />)).not.toContain(
      "k-badge--stale",
    );
    expect(
      renderToStaticMarkup(<TaskCard id="BE-01" state="todo" title="x" stale />),
    ).not.toContain("k-badge--stale");
  });

  it("the panel explains it after the threshold, and says nothing before", () => {
    const late = panel(new Date("2026-11-12T10:00:00Z"));
    expect(late).toContain("Sin actividad");
    expect(late).toContain("arrástrala a Por hacer");
    expect(panel(new Date("2026-11-10T20:00:00Z"))).not.toContain("Sin actividad");
  });
});
