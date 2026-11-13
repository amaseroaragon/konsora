import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { TaskCard, ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state: "todo",
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
  seq: { BE: 2 },
  tasks: [task("BE-01", { labels: ["auditoria", "ux"] }), task("BE-02")],
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
  };
}
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const view = (openId: string) =>
  wrap(<ProjectView board={boardOf(doc)} live="live" view="board" openId={openId} />);

describe("labels in the UI (UI-11)", () => {
  it("the card shows each label as a chip, and nothing without labels", () => {
    const html = wrap(<TaskCard id="BE-01" title="X" state="todo" labels={["auditoria", "ux"]} />);
    expect(html).toContain('<ul class="k-labels k-card__labels" aria-label="Etiquetas">');
    expect(html.match(/k-labels__chip">(\w+)</g)).toEqual([
      'k-labels__chip">auditoria<',
      'k-labels__chip">ux<',
    ]);
    expect(wrap(<TaskCard id="BE-02" title="X" state="todo" />)).not.toContain("k-labels");
    expect(wrap(<TaskCard id="BE-02" title="X" state="todo" labels={[]} />)).not.toContain(
      "k-labels",
    );
  });

  it("the board card and the task panel's header show them", () => {
    const html = view("BE-01");
    expect(html).toContain("k-card__labels");
    expect(html).toMatch(/a-detail__title">[^<]*<\/h2><ul class="k-labels a-detail__labels"/);
  });

  it("a task without labels leaves no gap in the panel", () => {
    const html = view("BE-02");
    expect(html).not.toContain("a-detail__labels");
    expect(html.match(/k-card__labels/g)).toHaveLength(1);
  });
});
