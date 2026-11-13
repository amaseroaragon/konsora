import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { Board } from "../src/shell/Board.tsx";
import { CELL_LIMIT, cellView, readBoardSet, writeBoardSet } from "../src/shell/board-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (n: number, group = "BE"): Task => ({
  id: `${group}-${String(n).padStart(2, "0")}`,
  title: `Tarea ${group}-${n}`,
  state: "todo",
  group,
  rank: `a${String(n).padStart(2, "0")}`,
  created: { at, by: "human" },
  updated_at: at,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 12, FE: 2 },
  tasks: [...Array.from({ length: 12 }, (_, i) => task(i + 1)), task(1, "FE"), task(2, "FE")],
};
function boardOf(plan: TasksDocument): BoardOk {
  const flags = deriveFlags(plan);
  const { tasks, ...rest } = plan;
  return {
    status: "ok",
    project: { id: "p-1", name: "P", path: "/p", added_at: at },
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
const render = (options: { openId?: string; selected?: string[] } = {}) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <Board
            board={boardOf(doc)}
            swimlanes
            onOpen={() => {}}
            selection={{ selected: new Set(options.selected ?? []), onToggle: () => {} }}
            openId={options.openId ?? null}
          />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const cards = (html: string) =>
  [...html.matchAll(/id="task-([A-Z]+-\d+)-title"/g)].map((m) => m[1]);

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
afterEach(() => vi.unstubAllGlobals());

describe("long cells and folded lanes on the board (UI-32)", () => {
  it("a cell with more than 8 cards shows the first 8 by rank and «Ver N más»", () => {
    expect(CELL_LIMIT).toBe(8);
    const html = render();
    expect(cards(html).filter((id) => id?.startsWith("BE"))).toEqual(
      Array.from({ length: 8 }, (_, i) => `BE-0${i + 1}`),
    );
    expect(html).toContain(">Ver 4 más</button>");
    // A short cell shows everything, with no button.
    expect(cards(html)).toContain("FE-02");
    expect(html.match(/b-cell-more/g)).toHaveLength(1);
  });

  it("an expanded cell shows every card and offers «Ver menos», remembered per project", () => {
    stubStorage({ "konsora.board.expanded.p-1": JSON.stringify(["BE:todo"]) });
    const html = render();
    expect(cards(html)).toContain("BE-12");
    expect(html).toContain(">Ver menos</button>");
    expect(html).not.toContain("Ver 4 más");
  });

  it("the open or a selected task among the hidden ones unfolds its cell by itself", () => {
    for (const html of [render({ openId: "BE-11" }), render({ selected: ["BE-12"] })]) {
      expect(cards(html)).toContain("BE-12");
      expect(html).not.toContain("Ver 4 más");
      // Unfolded because of that task: nothing to fold back while it stays open or selected.
      expect(html).not.toContain("Ver menos");
    }
  });

  it("a lane folds to its head with the count of each state, remembered per project", () => {
    expect(render()).toContain('aria-label="Plegar el carril Backend"');
    stubStorage({ "konsora.board.lanes.p-1": JSON.stringify(["BE"]) });
    const html = render();
    expect(html).toContain('aria-label="Desplegar el carril Backend"');
    expect(cards(html).some((id) => id?.startsWith("BE"))).toBe(false);
    expect(cards(html)).toContain("FE-01");
    expect(html).toContain('<span class="k-matrix__folded-count">12</span>');
  });

  it("works without localStorage", () => {
    vi.stubGlobal("window", {});
    expect(readBoardSet("lanes", "p-1")).toEqual(new Set());
    expect(() => writeBoardSet("lanes", "p-1", new Set(["BE"]))).not.toThrow();
    expect(render()).toContain("Ver 4 más");
  });

  it("the cell model keeps rank order and only hides what is past the limit", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}` }));
    expect(cellView(list, false).shown.map((x) => x.id)).toEqual(list.slice(0, 8).map((x) => x.id));
    expect(cellView(list, false).hidden).toBe(2);
    expect(cellView(list, true)).toMatchObject({ hidden: 0, canCollapse: true });
    expect(cellView(list.slice(0, 8), false)).toMatchObject({ hidden: 0, canCollapse: false });
  });
});
