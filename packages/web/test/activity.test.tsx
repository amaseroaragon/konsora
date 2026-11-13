import { planActivity, type Task, type TasksDocument } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { HistoryView } from "../src/shell/HistoryView.tsx";
import {
  activityMarkdown,
  activityText,
  filterActivity,
  groupByDay,
  readHistoryMode,
  writeHistoryMode,
} from "../src/shell/history-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const now = new Date("2026-11-12T11:00:00Z");
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "todo",
  group: "BE",
  rank: id.slice(-1),
  created: { at: "2026-11-11T09:00:00Z", by: "human" },
  updated_at: "2026-11-12T10:00:00Z",
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [
    task("BE-01", {
      state: "done",
      events: [
        { at: "2026-11-12T08:00:00Z", by: "agent:claude", type: "start" },
        { at: "2026-11-12T09:00:00Z", by: "agent:claude", type: "edit", fields: ["title", "deps"] },
        { at: "2026-11-12T10:00:00Z", by: "agent:claude", type: "finish" },
      ],
    }),
    task("BE-02"),
  ],
  deleted: [{ id: "BE-03", title: "La que sobraba", at: "2026-11-12T10:30:00Z", by: "human" }],
};
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
afterEach(() => vi.unstubAllGlobals());

describe("every change of the plan in the History (UI-16)", () => {
  it("lists the plan's events by day, with who did what", () => {
    const html = wrap(<HistoryView projectId="p" doc={doc} openId={null} now={now} />);
    expect(html).toContain("Todos los cambios");
    expect(html).toContain("4 cambios"); // today: delete, finish, edit, start
    expect(html).toContain("2 cambios"); // yesterday: two creations
    expect(html).toContain("Editada: título, dependencias");
    expect(html).toContain("Empezada");
    expect(html).toMatch(/Terminada<\/span> · claude/);
    expect(html).toMatch(/Eliminada<\/span> · tú/);
    const order = ["Eliminada", "Terminada", "Editada", "Empezada"].map((x) => html.indexOf(x));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("each change links to its task; a deleted one shows its id and title without a link", () => {
    const html = wrap(<HistoryView projectId="p" doc={doc} openId={null} now={now} />);
    expect(html).toContain('href="#/p/p?view=history&amp;task=BE-01"');
    expect(html).not.toContain("task=BE-03");
    expect(html).toMatch(/b-history__entry--gone[\s\S]*BE-03[\s\S]*La que sobraba/);
  });

  it("the switch keeps only the closures, as before, and is remembered", () => {
    const html = wrap(
      <HistoryView projectId="p" doc={doc} openId={null} now={now} initialMode="done" />,
    );
    expect(html).toContain("1 cierre");
    expect(html).not.toContain("Empezada");
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    expect(readHistoryMode()).toBe("all");
    writeHistoryMode("done");
    expect(readHistoryMode()).toBe("done");
  });

  it("filters the changes by who, group and text, and copies them as Markdown", () => {
    const activity = planActivity(doc);
    const groupOf = () => "BE";
    expect(filterActivity(activity, { by: "human" }, groupOf).map((e) => e.type)).toEqual([
      "delete",
      "create",
      "create",
    ]);
    expect(filterActivity(activity, { text: "sobraba" }, groupOf)).toHaveLength(1);
    expect(filterActivity(activity, { group: "FE" }, groupOf)).toEqual([]);
    const md = activityMarkdown(groupByDay(activity, { now, timeZone: "Europe/Madrid" }));
    expect(md).toContain("## Hoy (4)");
    expect(md).toContain("**BE-01** Tarea BE-01 — Editada: título, dependencias (claude)");
    expect(activityText({ type: "promote" })).toBe("Pasada a Por hacer");
  });
});
