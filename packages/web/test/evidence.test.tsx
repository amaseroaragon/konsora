import { deriveFlags, type Note, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { HistoryView } from "../src/shell/HistoryView.tsx";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-10T10:00:00Z";
const criteria = [
  { id: "ac1", text: "Una petición repetida no llama al proveedor" },
  { id: "ac2", text: "La caché caduca a los 10 min" },
  { id: "ac3", text: "Hay métricas" },
];
const summary = (evidence?: Note["evidence"]): Note => ({
  id: "n1",
  at,
  by: "agent:claude",
  kind: "summary",
  text: "LRU con TTL",
  ...(evidence ? { evidence } : {}),
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "done",
  group: "BE",
  rank: id.slice(-1),
  acceptance: criteria,
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [
    task("BE-01", {
      notes: [
        summary([
          { ac: "ac1", met: true, text: "`cache.test.ts` pasa" },
          { ac: "ac2", met: false, text: "Queda para BE-07" },
        ]),
      ],
    }),
    task("BE-02", {
      notes: [
        summary([
          { ac: "ac1", met: true, text: "a" },
          { ac: "ac2", met: true, text: "b" },
          { ac: "ac3", met: true, text: "c" },
        ]),
      ],
    }),
    task("BE-03", { notes: [summary()] }),
  ],
};
const flags = deriveFlags(doc);
const board = (id: string) => {
  const t = doc.tasks.find((x) => x.id === id) as Task;
  return { ...t, ...(flags.get(id) as object), hash: taskHash(t) } as BoardTask;
};
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
      task={board(id)}
      doc={doc}
      groupName="Backend"
      external={[]}
      readOnly={false}
      onClose={() => {}}
      onOpen={() => {}}
    />,
  );

describe("evidence per criterion (CORE-15)", () => {
  it("the panel of a done task shows each criterion with its evidence, reason or none", () => {
    const html = panel("BE-01");
    const row = (ac: string) => html.slice(html.indexOf(`>${ac}</td>`)).split("</tr>")[0] ?? "";
    expect(row("ac1")).toContain("a-evidence--met");
    expect(row("ac1")).toContain("Cumplido");
    expect(row("ac1")).toContain("<code>cache.test.ts</code> pasa");
    expect(row("ac2")).toContain("No cumplido");
    expect(row("ac2")).toContain("Queda para BE-07");
    expect(row("ac3")).toContain("Sin evidencia");
  });

  it("a closure without evidence marks every criterion as without evidence", () => {
    const html = panel("BE-03");
    expect(html.match(/Sin evidencia/g)).toHaveLength(3);
  });

  it("the History tells closures with criteria lacking evidence or not met", () => {
    const html = wrap(
      <HistoryView projectId="p" doc={doc} openId={null} now={new Date("2026-11-10T12:00:00Z")} />,
    );
    const entry = (id: string) => html.slice(html.indexOf(`>${id}<`)).split("</a>")[0] ?? "";
    expect(entry("BE-01")).toContain("1 criterio no cumplido");
    expect(entry("BE-01")).toContain("1 criterio sin evidencia");
    expect(entry("BE-02")).not.toContain("b-history__flag");
    expect(entry("BE-03")).toContain("3 criterios sin evidencia");
  });
});
