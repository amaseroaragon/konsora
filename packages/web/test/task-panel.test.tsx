import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { PanelSection } from "../src/shell/PanelSection.tsx";
import { readSectionOpen, writeSectionOpen } from "../src/shell/panel-model.ts";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "agent:claude" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 2 },
  tasks: [
    task("BE-01", "done"),
    task("BE-02", "done", {
      desc: "Cachear la previsión.",
      deps: ["BE-01"],
      acceptance: [
        { id: "ac1", text: "Una petición repetida no llama al proveedor" },
        { id: "ac2", text: "La caché caduca a los 10 min" },
      ],
      notes: [
        { id: "n1", at, by: "agent:claude", kind: "note", text: "Empiezo por la LRU" },
        { id: "n2", at, by: "agent:claude", kind: "summary", text: "Hecho con **LRU**" },
      ],
    }),
  ],
};
const flags = deriveFlags(doc);
const board = doc.tasks.map(
  (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
);

const panel = (id: string) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <TaskPanel
            projectId="p"
            task={board.find((t) => t.id === id) as BoardTask}
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

/** A localStorage for the node test environment. */
function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task panel sections (UI-09)", () => {
  it("reads by priority: summary, actions, description, criteria, dependencies, notes", () => {
    const html = panel("BE-02");
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at('aria-label="Resumen de cierre"'),
      at(">Reabrir</button>"),
      at('data-section="desc"'),
      at('data-section="criteria"'),
      at('data-section="deps"'),
      at('data-section="notes"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("folds each section under its title, open by default, with how many items it holds", () => {
    const html = panel("BE-02");
    for (const section of ["desc", "criteria", "deps", "notes"])
      expect(html).toContain(`<details class="b-fold" data-section="${section}" open="">`);
    expect(html).toMatch(
      /<summary class="b-fold__head b-fold__title k-label">Descripción<\/summary>/,
    );
    expect(html).toMatch(/Criterios de aceptación<span class="b-fold__count">· 2<\/span>/);
    expect(html).toMatch(/Depende de<span class="b-fold__count">· 1<\/span>/);
    expect(html).toMatch(/Notas<span class="b-fold__count">· 2<\/span>/);
  });

  it("leaves out the sections a task does not have", () => {
    const html = panel("BE-01");
    expect(html).not.toContain("<details");
  });

  it("opens folded sections folded, for every task", () => {
    stubStorage({ "konsora.panel.notes": "closed", "konsora.panel.criteria": "closed" });
    const html = panel("BE-02");
    expect(html).toContain('<details class="b-fold" data-section="notes">');
    expect(html).toContain('<details class="b-fold" data-section="criteria">');
    expect(html).toContain('<details class="b-fold" data-section="desc" open="">');
    expect(html).toContain('<details class="b-fold" data-section="deps" open="">');
  });

  it("remembers each section's state on its own", () => {
    const store = stubStorage();
    expect(readSectionOpen("notes")).toBe(true);
    writeSectionOpen("notes", false);
    expect(readSectionOpen("notes")).toBe(false);
    expect(readSectionOpen("deps")).toBe(true);
    writeSectionOpen("notes", true);
    expect(readSectionOpen("notes")).toBe(true);
    expect(store.get("konsora.panel.notes")).toBe("open");
  });

  it("still folds, unremembered, when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readSectionOpen("desc")).toBe(true);
    expect(() => writeSectionOpen("desc", false)).not.toThrow();
  });

  it("does not fold a section that holds a form", () => {
    stubStorage({ "konsora.panel.deps": "closed" });
    const html = renderToStaticMarkup(
      <PanelSection section="deps" title="Depende de" foldable={false}>
        <form />
      </PanelSection>,
    );
    expect(html).not.toContain("<details");
    expect(html).toContain('<section class="b-fold" data-section="deps">');
    expect(html).toContain("<form>");
  });
});
