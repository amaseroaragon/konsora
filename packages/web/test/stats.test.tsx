import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import {
  ActivityView,
  chartSeries,
  daySegments,
  durationText,
  OTHER,
} from "../src/shell/ActivityView.tsx";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { parseRoute, projectHref } from "../src/shell/route.ts";
import { ToastProvider } from "../src/ui/index.ts";

const now = new Date("2026-11-12T20:00:00Z");
const task = (id: string, by: string, start: string, finish: string): Task => ({
  id,
  title: id,
  state: "done",
  group: "BE",
  rank: "a",
  created: { at: "2026-10-01T09:00:00Z", by: "human" },
  updated_at: finish,
  events: [
    { at: start, by, type: "start" },
    { at: finish, by, type: "finish" },
  ],
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [
    task("BE-01", "agent:claude", "2026-11-12T08:00:00Z", "2026-11-12T10:00:00Z"),
    task("BE-02", "agent:codex", "2026-11-12T08:00:00Z", "2026-11-12T12:00:00Z"),
    task("BE-03", "agent:claude", "2026-11-05T08:00:00Z", "2026-11-05T09:00:00Z"),
  ],
};
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("activity view (UI-18)", () => {
  it("shows closures, the average time in progress and the reopened tasks", () => {
    const html = wrap(<ActivityView doc={doc} now={now} />);
    expect(html).toMatch(/Cierres<\/div><div class="b-stat__value">3</);
    expect(html).toContain("2 h 20 min"); // (2 + 4 + 1) / 3 h
    expect(html).toContain("sobre 3 cierres");
    expect(html).toMatch(/Reabiertas<\/div><div class="b-stat__value">0</);
  });

  it("draws 28 days of closures stacked by who closed them, with a legend and a table", () => {
    const html = wrap(<ActivityView doc={doc} now={now} />);
    expect(html.match(/class="b-stats__day"/g)).toHaveLength(28);
    expect(html).toContain('aria-label="12 nov: 2 cierre(s)"');
    expect(html).toMatch(/b-stats__legend[^>]*>.*claude.*codex/);
    expect(html).toContain("Ver como tabla");
    expect(html).toMatch(/<td class="k-mono">2026-11-12<\/td><td>1<\/td><td>1<\/td><td>2<\/td>/);
  });

  it("says so when there are no closures in the window", () => {
    const html = wrap(<ActivityView doc={doc} now={new Date("2027-03-01T00:00:00Z")} />);
    expect(html).toContain("Aún no hay cierres en estas semanas.");
    expect(html).toContain("Sin datos");
  });

  it("keeps each person's color by name, and folds the eighth and beyond into «Otros»", () => {
    expect(chartSeries(["agent:b", "agent:a"])).toEqual(["agent:a", "agent:b"]);
    const many = Array.from({ length: 9 }, (_, i) => `agent:${String.fromCharCode(97 + i)}`);
    const series = chartSeries(many);
    expect(series).toHaveLength(7);
    expect(series.at(-1)).toBe(OTHER);
    expect(
      daySegments(
        { day: "x", total: 4, byActor: { "agent:a": 1, "agent:h": 2, "agent:i": 1 } },
        series,
      ),
    ).toEqual([1, 0, 0, 0, 0, 0, 3]);
  });

  it("formats durations", () => {
    expect(durationText(45 * 60_000)).toBe("45 min");
    expect(durationText(200 * 60_000)).toBe("3 h 20 min");
    expect(durationText(52 * 3_600_000)).toBe("2 d 4 h");
  });

  it("is a view of the project, reachable by URL", () => {
    const route = parseRoute(projectHref("p-1", { view: "activity" }));
    expect(route.name === "project" && route.view).toBe("activity");
    const flags = deriveFlags(doc);
    const { tasks, ...plan } = doc;
    const board: BoardOk = {
      status: "ok",
      project: { id: "p-1", name: "P", path: "/p", added_at: now.toISOString() },
      hash: "sha256:x",
      external: [],
      plan,
      tasks: tasks.map(
        (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as never,
      ),
    };
    const html = wrap(<ProjectView board={board} live="live" view="activity" openId={null} />);
    expect(html).toContain("b-stats__tiles");
    expect(html).toContain(">Actividad<");
  });
});
