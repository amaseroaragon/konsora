import {
  deriveFlags,
  type Task,
  type TaskFilter,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardOk } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { createOp, emptyDraft } from "../src/shell/create-model.ts";
import { changesFrom, draftFrom, rebaseDraft } from "../src/shell/edit-model.ts";
import { ProjectView } from "../src/shell/ProjectView.tsx";
import { parseRoute, projectHref } from "../src/shell/route.ts";
import { TaskEditor } from "../src/shell/TaskEditor.tsx";
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
  seq: { BE: 3 },
  tasks: [
    task("BE-01", { difficulty: "high" }),
    task("BE-02", { difficulty: "low", state: "done" }),
    task("BE-03"),
  ],
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
const view = (props: { openId?: string; filter?: TaskFilter }) =>
  wrap(
    <ProjectView
      board={boardOf(doc)}
      live="live"
      view="board"
      openId={props.openId ?? null}
      filter={props.filter}
    />,
  );
const cards = (html: string) =>
  [...html.matchAll(/id="task-([A-Z]+-\d+)-title"/g)].map((m) => m[1]);

describe("difficulty in the UI (CORE-22)", () => {
  it("the card shows it as bars with the level read out; none shows nothing", () => {
    const html = wrap(<TaskCard id="BE-01" title="X" state="todo" difficulty="medium" />);
    expect(html).toContain("k-difficulty--medium");
    expect(html).toContain("Dificultad media");
    expect(html.match(/k-difficulty__bar--on/g)).toHaveLength(2);
    expect(wrap(<TaskCard id="BE-03" title="X" state="todo" />)).not.toContain("k-difficulty");
  });

  it("the board cards and the open task panel show it", () => {
    const html = view({ openId: "BE-01" });
    expect(html).toContain("k-difficulty--high");
    expect(html).toContain("k-difficulty--low");
    expect(html).toMatch(/k-difficulty__text">Dificultad alta</);
  });

  it("the filter offers the levels in use and narrows the board; it lives in the URL", () => {
    const html = view({});
    expect(html).toContain("Todas las dificultades");
    expect(html).toContain(">Sin dificultad<");
    expect(cards(view({ filter: { difficulty: "high" } }))).toEqual(["BE-01"]);
    expect(cards(view({ filter: { difficulty: "none" } }))).toEqual(["BE-03"]);
    const href = projectHref("p-1", { filter: { difficulty: "low" } });
    expect(href).toBe("#/p/p-1?difficulty=low");
    expect(parseRoute(href)).toMatchObject({ filter: { difficulty: "low" } });
  });

  it("editing sets, changes or removes it as one edit op, done tasks included", () => {
    const done = doc.tasks[1] as Task;
    const groups = doc.groups;
    expect(changesFrom({ ...draftFrom(done), difficulty: "high" }, done, groups)).toMatchObject({
      ok: true,
      changes: { difficulty: "high" },
    });
    expect(changesFrom({ ...draftFrom(done), difficulty: "" }, done, groups)).toMatchObject({
      ok: true,
      changes: { difficulty: null },
    });
    expect(changesFrom(draftFrom(done), done, groups)).toMatchObject({ ok: true, empty: true });
    // A difficulty changed meanwhile by someone else is kept when the human did not touch it.
    const theirs = { ...done, difficulty: "medium" as const };
    expect(rebaseDraft(draftFrom(done), done, theirs).draft.difficulty).toBe("medium");
    const board = boardOf(doc);
    const html = wrap(
      <TaskEditor
        projectId="p"
        task={board.tasks[1] as BoardOk["tasks"][number]}
        groups={groups}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(">Dificultad<");
    expect(html).toMatch(/<option value="low" selected="">Baja<\/option>/);
  });

  it("a task created in the UI can carry one", () => {
    const result = createOp(
      { ...emptyDraft("BE"), title: "Nueva", difficulty: "medium" },
      { groups: doc.groups, tasks: doc.tasks },
    );
    expect(result.ok && result.op.difficulty).toBe("medium");
    const none = createOp(
      { ...emptyDraft("BE"), title: "Nueva" },
      doc.tasks && {
        groups: doc.groups,
        tasks: doc.tasks,
      },
    );
    expect(none.ok && "difficulty" in none.op).toBe(false);
  });
});
