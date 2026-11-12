import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { BlocksView } from "../src/shell/BlocksView.tsx";
import {
  addCandidates,
  moveErrorText,
  moveWarning,
  setBlockOp,
} from "../src/shell/blocks-model.ts";
import { NO_BLOCK, SelectionBar } from "../src/shell/SelectionBar.tsx";
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
const block = (id: string, merged = false) => ({
  id,
  name: `Bloque ${id}`,
  branch: `konsora/${id}`,
  base: "main",
  created: { at, by: "human" },
  ...(merged
    ? {
        merged: {
          at,
          by: "human",
          commit: "a".repeat(40),
          strategy: "squash" as const,
        },
      }
    : {}),
});
const doc: TasksDocument = {
  schema: "konsora/4",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 6 },
  blocks: [block("cache"), block("api"), block("old", true)],
  tasks: [
    task("BE-01", "todo", { block: "cache" }),
    task("BE-02", "todo"),
    task("BE-03", "doing"),
    task("BE-04", "done", { block: "api" }),
    task("BE-05", "done", { block: "old" }),
    task("BE-06", "proposed"),
  ],
};
const tasks: BoardTask[] = (() => {
  const flags = deriveFlags(doc);
  return doc.tasks.map(
    (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
  );
})();
const byId = (id: string) => tasks.find((t) => t.id === id) as BoardTask;

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("adding and removing tasks of a block (UI-07)", () => {
  it("offers every task not in the block and not held by a merged one (ac1)", () => {
    expect(addCandidates(tasks, doc, "cache").map((t) => t.id)).toEqual([
      "BE-02",
      "BE-03",
      "BE-04", // in another open block: it can move
      "BE-06",
    ]);
  });

  it("sends one set-block per task, on the version shown (ac1, ac2)", () => {
    expect(setBlockOp(byId("BE-02"), "cache")).toEqual({
      op: "set-block",
      task: "BE-02",
      block: "cache",
      expect: { "BE-02": byId("BE-02").hash },
    });
    expect(setBlockOp(byId("BE-01"), null)).toMatchObject({ task: "BE-01", block: null });
  });

  it("an open block lists the candidates and a remove button per task; a merged one, neither (ac1, ac2)", () => {
    const html = wrap(
      <BlocksView projectId="p" doc={doc} tasks={tasks} readOnly={false} onOpen={() => {}} />,
    );
    const card = (name: string) => {
      const start = html.indexOf(`>${name}<`);
      const end = html.indexOf("b-blocks__item", start);
      return html.slice(start, end < 0 ? undefined : end);
    };
    const cache = card("Bloque cache");
    expect(cache).toContain("<summary");
    expect(cache).toContain("Añadir tareas");
    expect(cache).toContain('aria-label="Quitar BE-01 del bloque"');
    for (const id of ["BE-02", "BE-03", "BE-04", "BE-06"]) expect(cache).toContain(`>${id}<`);
    expect(cache).toContain("ahora en Bloque api");
    expect(cache).not.toContain(">BE-05<");
    const old = card("Bloque old");
    expect(old).not.toContain("Añadir tareas");
    expect(old).not.toContain("Quitar");
  });

  it("offers nothing to change in read-only mode", () => {
    const html = wrap(
      <BlocksView projectId="p" doc={doc} tasks={tasks} readOnly onOpen={() => {}} />,
    );
    expect(html).not.toContain("Añadir tareas");
    expect(html).not.toContain("Quitar");
  });

  it("warns when started or done work goes into a block (ac4)", () => {
    const cache = block("cache");
    expect(moveWarning([byId("BE-02"), byId("BE-06")], cache)).toBeNull();
    expect(moveWarning([byId("BE-02"), byId("BE-03")], cache)).toBe(
      "BE-03 ya está empezada o hecha: sus commits pueden no estar en la rama konsora/cache.",
    );
    expect(moveWarning([byId("BE-03"), byId("BE-04")], cache)).toBe(
      "BE-03, BE-04 ya están empezadas o hechas: sus commits pueden no estar en la rama konsora/cache.",
    );
  });

  it("explains in Spanish a move core refused (ac3)", () => {
    expect(moveErrorText("block_merged", "BE-05", "Block old is already merged")).toBe(
      "No se pudo mover BE-05: su bloque o el de destino ya está integrado.",
    );
    expect(moveErrorText("unknown_block", "BE-02", "Block x does not exist")).toBe(
      "No se pudo mover BE-02: ese bloque ya no existe.",
    );
    expect(moveErrorText("conflict", "BE-02", "changed")).toContain("BE-02");
  });

  it("the selection bar offers Move to… with the open blocks and No block (ac3)", () => {
    const bar = (targets: { value: string; label: string }[], readOnly = false) =>
      renderToStaticMarkup(
        <SelectionBar
          ids={["BE-02", "BE-04"]}
          promotable={[]}
          deletable={["BE-02", "BE-04"]}
          readOnly={readOnly}
          onPromote={() => {}}
          onDelete={() => {}}
          onClear={() => {}}
          blockTargets={targets}
          onMove={() => {}}
        />,
      );
    const targets = [
      { value: "cache", label: "Bloque cache" },
      { value: NO_BLOCK, label: "Sin bloque" },
    ];
    const html = bar(targets);
    expect(html).toContain("Bloque");
    expect(html).toContain("Mover a…");
    expect(bar([])).not.toContain("Mover a…");
    expect(bar(targets, true)).not.toContain("Mover a…");
  });
});
