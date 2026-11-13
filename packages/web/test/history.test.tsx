import { completionLog, deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { HistoryView } from "../src/shell/HistoryView.tsx";
import {
  closers,
  filterLog,
  groupByDay,
  historyMarkdown,
  summaryLine,
} from "../src/shell/history-model.ts";
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
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  tasks: [
    task("BE-01", "done", summary("2026-11-10T08:15:00Z", "Primera **hecha**")),
    // 23:30 UTC on the 11th is 00:30 on the 12th in Madrid: it belongs to "today".
    task("BE-02", "done", summary("2026-11-11T23:30:00Z", "Con caché")),
    task("BE-03", "done", {
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
    expect(days.map((day) => day.entries.map(({ entry, time }) => `${time} ${entry.id}`))).toEqual([
      ["09:00 BE-05", "00:30 BE-02"],
      ["11:05 BE-03"],
      ["09:15 BE-01"],
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
    const html = wrap(
      <HistoryView initialMode="done" projectId="p-1" doc={doc} openId={null} now={now} />,
    );
    expect(html).toContain("Historial");
    expect(html).toContain("Ayer");
    expect(html).toContain("Terminada por claude");
    expect(html).toContain("Primera hecha");
    expect(html).toContain("Sin resumen de cierre");
    expect(html).not.toContain("BE-04");
    const order = ["BE-05", "BE-02", "BE-03", "BE-01"].map((id) => html.indexOf(`>${id}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("links each task to its panel in the History view (ac2)", () => {
    const html = wrap(
      <HistoryView initialMode="done" projectId="p-1" doc={doc} openId="BE-03" now={now} />,
    );
    const href = projectHref("p-1", { view: "history", task: "BE-03" });
    expect(html).toContain(`href="${href.replace("&", "&amp;")}"`);
    expect(parseRoute(href)).toEqual({
      name: "project",
      id: "p-1",
      view: "history",
      task: "BE-03",
    });
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
    const empty = { ...doc, tasks: [task("BE-01", "todo")] };
    const html = wrap(<HistoryView initialMode="done" projectId="p-1" doc={empty} openId={null} />);
    expect(html).toContain("Todavía no hay tareas hechas.");
    expect(html).not.toContain("b-history__day");
  });
});

describe("archived tasks (CORE-18)", () => {
  const old = task("BE-06", "done", summary("2026-10-01T08:00:00Z", "Archivada hace tiempo"));
  const archivedDoc: TasksDocument = { ...doc, seq: { BE: 6 }, archived: ["BE-06"] };
  const board = (): BoardOk => ({ ...boardOf(archivedDoc), archive: [old] });

  it("the History lists them too, marked as archived", () => {
    const html = wrap(
      <HistoryView
        initialMode="done"
        projectId="p-1"
        doc={doc}
        archive={[old]}
        openId={null}
        now={now}
      />,
    );
    expect(html).toContain(">BE-06<");
    expect(html).toContain("Terminada por claude · Archivada");
    expect(html.indexOf(">BE-06<")).toBeGreaterThan(html.indexOf(">BE-01<")); // the oldest
  });

  it("an archived task opens read-only from the History, marked as such", () => {
    const html = wrap(<ProjectView board={board()} live="live" view="history" openId="BE-06" />);
    expect(html).toContain('aria-label="Detalle de BE-06"');
    expect(html).toContain("Esta tarea está archivada");
    expect(html).toContain("Archivada hace tiempo");
    expect(html).not.toContain(">Editar<");
    expect(html).not.toContain(">Reabrir<");
  });

  it("says when the archive cannot be read", () => {
    const html = wrap(
      <HistoryView
        projectId="p-1"
        doc={doc}
        archiveError="archive.json is invalid"
        openId={null}
        now={now}
      />,
    );
    expect(html).toContain("No se pudo leer el archivo de tareas archivadas");
  });
});

describe("history filters and summary (UI-17)", () => {
  const plan: TasksDocument = {
    ...doc,
    groups: [
      { id: "BE", name: "Backend" },
      { id: "FE", name: "Frontend" },
    ],
    seq: { BE: 5, FE: 1 },
    tasks: [
      ...doc.tasks,
      task("FE-01", "done", {
        group: "FE",
        title: "Pantalla",
        ...summary("2026-11-12T09:00:00Z", "Hecha por mí", "human"),
      }),
    ],
  };
  const log = completionLog(plan);

  it("filters by who closed, by group and by text in the title or summary (ac1)", () => {
    expect(closers(log)).toEqual(["agent:claude", "human"]);
    expect(filterLog(log, { by: "human" }).map((e) => e.id)).toEqual(["FE-01"]);
    expect(filterLog(log, { group: "FE" }).map((e) => e.id)).toEqual(["FE-01"]);
    // Text in the summary, without accents or case.
    expect(filterLog(log, { text: "CACHE" }).map((e) => e.id)).toEqual(["BE-02"]);
    // Text in the title.
    expect(filterLog(log, { text: "pantalla" }).map((e) => e.id)).toEqual(["FE-01"]);
    expect(filterLog(log, { by: "agent:claude", group: "FE" })).toEqual([]);
    expect(filterLog(log, {})).toHaveLength(log.length);
  });

  it("counts each day's closures and copies the visible ones as Markdown (ac2, ac3)", () => {
    const days = groupByDay(filterLog(log, { by: "agent:claude" }), { now, timeZone });
    const html = wrap(
      <HistoryView initialMode="done" projectId="p-1" doc={plan} openId={null} now={now} />,
    );
    expect(html).toMatch(/Hoy<span class="b-history__count">\d+ cierres?<\/span>/);
    expect(html).toContain("Copiar como Markdown");
    const md = historyMarkdown(days);
    expect(md).toContain("## Hoy (1)");
    expect(md).toContain("- 00:30 **BE-02** Tarea BE-02 — claude: Con caché");
    expect(md).not.toContain("FE-01");
  });
});
