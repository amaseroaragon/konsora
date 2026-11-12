import { completionLog, deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { HistoryView } from "../src/shell/HistoryView.tsx";
import { groupByDay, summaryLine } from "../src/shell/history-model.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { parseRoute, projectHref } from "../src/shell/route.ts";
import { ToastProvider } from "../src/ui/index.ts";

const created = { at: "2026-11-01T09:00:00Z", by: "human" };
const summary = (at: string, text: string, by = "agent:claude") => ({
  notes: [{ id: "n1", at, by, kind: "summary" as const, text }],
});
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created,
  updated_at: created.at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/4",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  blocks: [
    {
      id: "cache",
      name: "Caché",
      branch: "konsora/cache",
      base: "main",
      created,
      merged: {
        at: "2026-11-12T09:30:00Z",
        by: "human",
        commit: "0123456789abcdef0123456789abcdef01234567",
        strategy: "squash",
      },
    },
  ],
  tasks: [
    task("BE-01", "done", summary("2026-11-10T08:15:00Z", "Primera **hecha**")),
    // 23:30 UTC on the 11th is 00:30 on the 12th in Madrid: it belongs to "today".
    task("BE-02", "done", { block: "cache", ...summary("2026-11-11T23:30:00Z", "Con caché") }),
    task("BE-03", "done", {
      block: "cache",
      ...summary("2026-11-11T10:05:00Z", "## Resumen\n\n- Añadido `LRU` y [docs](https://x.y)"),
    }),
    task("BE-04", "doing"),
    task("BE-05", "done", { updated_at: "2026-11-12T08:00:00Z" }),
  ],
};
const now = new Date("2026-11-12T11:00:00Z");
const timeZone = "Europe/Madrid";

function boardOf(plan: TasksDocument): BoardOk {
  const flags = deriveFlags(plan);
  const { tasks, ...rest } = plan;
  return {
    status: "ok",
    project: { id: "p-1", name: "P", path: "/p", added_at: created.at },
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

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("history model", () => {
  it("groups the log by local day, newest first, with today, yesterday and full dates (ac1)", () => {
    const days = groupByDay(completionLog(doc), { now, timeZone });
    expect(days.map((day) => [day.key, day.label])).toEqual([
      ["2026-11-12", "Hoy"],
      ["2026-11-11", "Ayer"],
      ["2026-11-10", "martes, 10 de noviembre de 2026"],
    ]);
    expect(
      days.map((day) => day.entries.map(({ entry, time }) => `${time} ${entry.kind}:${entry.id}`)),
    ).toEqual([
      ["10:30 block:cache", "09:00 task:BE-05", "00:30 task:BE-02"],
      ["11:05 task:BE-03"],
      ["09:15 task:BE-01"],
    ]);
  });

  it("reduces a summary to its first line as plain text, shortened", () => {
    expect(summaryLine("## Resumen\n\n- Añadido `LRU` y [docs](https://x.y)")).toBe("Resumen");
    expect(summaryLine("\n- Añadido `LRU` y [docs](https://x.y)\n- otra")).toBe(
      "Añadido LRU y docs",
    );
    expect(summaryLine("Primera **hecha**")).toBe("Primera hecha");
    expect(summaryLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("History view", () => {
  it("lists entries with time, who finished them and their summary line (ac1)", () => {
    const html = wrap(<HistoryView projectId="p-1" doc={doc} openId={null} now={now} />);
    expect(html).toContain("Historial");
    expect(html).toContain("Ayer");
    expect(html).toContain("Terminada por claude");
    expect(html).toContain("Primera hecha");
    expect(html).toContain("Sin resumen de cierre");
    expect(html).toContain("Bloque Caché integrado en main");
    expect(html).toContain("0123456789ab");
    expect(html).not.toContain("BE-04");
    const order = ["BE-05", "BE-02", "BE-03", "BE-01"].map((id) => html.indexOf(`>${id}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("links each task to its panel in the History view and a block to Blocks (ac2)", () => {
    const html = wrap(<HistoryView projectId="p-1" doc={doc} openId="BE-03" now={now} />);
    const href = projectHref("p-1", { view: "history", task: "BE-03" });
    expect(html).toContain(`href="${href.replace("&", "&amp;")}"`);
    expect(parseRoute(href)).toEqual({
      name: "project",
      id: "p-1",
      view: "history",
      task: "BE-03",
    });
    expect(html).toContain(`href="${projectHref("p-1", { view: "blocks" })}"`);
    expect(html).toMatch(/b-history__entry--open"[^>]*aria-current="true"/);
  });

  it("opens the task panel with the closing summary beside the history (ac2)", () => {
    const html = wrap(
      <ProjectView board={boardOf(doc)} live="live" view="history" openId="BE-01" />,
    );
    expect(html).toContain('aria-pressed="true" class="k-segmented__item">Historial');
    expect(html).toContain("b-history");
    expect(html).toContain('aria-label="Resumen de cierre"');
    expect(html).toContain("<strong>hecha</strong>");
  });

  it("explains an empty history in Spanish (ac3)", () => {
    const empty = { ...doc, blocks: [], tasks: [task("BE-01", "todo")] };
    const html = wrap(<HistoryView projectId="p-1" doc={empty} openId={null} />);
    expect(html).toContain("Todavía no hay tareas hechas.");
    expect(html).not.toContain("b-history__day");
  });
});
