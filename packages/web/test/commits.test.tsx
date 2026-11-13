import { completionLog, deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { HistoryView } from "../src/shell/HistoryView.tsx";
import { groupByDay, historyMarkdown } from "../src/shell/history-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-10T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "done",
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  notes: [{ id: "n1", at, by: "agent:claude", kind: "summary", text: "Hecho" }],
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 2 },
  tasks: [
    task("BE-01", { commits: ["24476d1", "8b8e7df0123456789abcdef0123456789abcdef0"] }),
    task("BE-02"),
  ],
};
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const panel = (id: string) => {
  const t = doc.tasks.find((x) => x.id === id) as Task;
  return wrap(
    <TaskPanel
      projectId="p"
      task={{ ...t, ...(deriveFlags(doc).get(id) as object), hash: taskHash(t) } as BoardTask}
      doc={doc}
      groupName="Backend"
      external={[]}
      readOnly={false}
      onClose={() => {}}
      onOpen={() => {}}
    />,
  );
};

describe("commits of a done task (CORE-14)", () => {
  it("the panel lists them with a button that copies them", () => {
    const html = panel("BE-01");
    expect(html).toContain('data-section="commits"');
    expect(html).toContain("24476d1");
    expect(html).toContain("8b8e7df0123456789abcdef0123456789abcdef0");
    expect(html).toContain("Copiar commits");
    expect(panel("BE-02")).not.toContain('data-section="commits"');
  });

  it("the History shows their short hashes and copies them in its Markdown", () => {
    const html = wrap(
      <HistoryView
        initialMode="done"
        projectId="p"
        doc={doc}
        openId={null}
        now={new Date("2026-11-10T12:00:00Z")}
      />,
    );
    expect(html).toContain('<span class="b-history__commits k-mono">24476d1 8b8e7df</span>');
    const md = historyMarkdown(
      groupByDay(completionLog(doc), { now: new Date("2026-11-10T12:00:00Z") }),
    );
    expect(md).toContain("(`24476d1`, `8b8e7df`)");
  });
});
