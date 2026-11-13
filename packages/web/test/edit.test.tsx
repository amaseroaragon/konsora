import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type BoardTask, editBody } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { DepPicker } from "../src/shell/DepPicker.tsx";
import {
  changesFrom,
  criteriaFrom,
  dependencyOptions,
  dependencyProblem,
  draftFrom,
  editErrorText,
  rebaseDraft,
} from "../src/shell/edit-model.ts";
import { TaskEditor } from "../src/shell/TaskEditor.tsx";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state: "todo",
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const groups = [
  { id: "BE", name: "Backend" },
  { id: "FE", name: "Frontend" },
];
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups,
  seq: { BE: 3 },
  tasks: [
    task("BE-01"),
    task("BE-02", { deps: ["BE-01"] }),
    task("BE-03", {
      deps: ["BE-02"],
      desc: "Texto",
      labels: ["m4"],
      acceptance: [
        { id: "ac1", text: "Uno" },
        { id: "ac2", text: "Dos" },
      ],
    }),
  ],
};
const boardTask = (t: Task): BoardTask => {
  const flags = deriveFlags({ tasks: [t] }).get(t.id) as NonNullable<
    ReturnType<ReturnType<typeof deriveFlags>["get"]>
  >;
  return { ...t, ...flags, hash: taskHash(t) };
};
const base = doc.tasks[2] as Task;

describe("edit draft (UI-09)", () => {
  it("sends only the fields the human changed, as one edit op", () => {
    const draft = { ...draftFrom(base), title: "  Nuevo título ", labels: "m4, ui, m4" };
    const check = changesFrom(draft, base, groups);
    expect(check).toEqual({
      ok: true,
      empty: false,
      changes: { title: "Nuevo título", labels: ["m4", "ui"] },
    });
    expect(
      editBody({ op: "edit", task: "BE-03", hash: "sha256:x", changes: { title: "N" } }),
    ).toEqual({
      op: "edit",
      task: "BE-03",
      expect: { "BE-03": "sha256:x" },
      changes: { title: "N" },
    });
  });

  it("treats text typed back to the stored value as no change", () => {
    const draft = { ...draftFrom(base), desc: "Texto  ", labels: "m4" };
    expect(changesFrom(draft, base, groups)).toMatchObject({ ok: true, empty: true });
  });

  it("explains empty titles, unknown groups and bad criteria in Spanish before sending", () => {
    expect(changesFrom({ ...draftFrom(base), title: " " }, base, groups)).toEqual({
      ok: false,
      field: "title",
      message: "El título no puede quedar vacío.",
    });
    expect(changesFrom({ ...draftFrom(base), group: "ZZ" }, base, groups)).toMatchObject({
      ok: false,
      field: "group",
      message: "El grupo ZZ no existe en este plan.",
    });
    const rows = [{ text: "x".repeat(501) }];
    expect(changesFrom({ ...draftFrom(base), acceptance: rows }, base, groups)).toMatchObject({
      ok: false,
      field: "acceptance",
    });
  });

  it("keeps criterion ids, numbers new ones after the highest, and drops empty rows", () => {
    expect(
      criteriaFrom([
        { id: "ac2", text: "Dos" },
        { text: " Nuevo " },
        { text: "  " },
        { id: "ac5", text: "Cinco" },
        { text: "Otro" },
      ]),
    ).toEqual([
      { id: "ac2", text: "Dos" },
      { id: "ac6", text: "Nuevo" },
      { id: "ac5", text: "Cinco" },
      { id: "ac7", text: "Otro" },
    ]);
  });

  it("moves a draft onto a newer version without undoing the other side's changes (ac3)", () => {
    const draft = { ...draftFrom(base), title: "Mi título", desc: "Mi texto" };
    const current = { ...base, title: "Su título", labels: ["m4", "urgente"] };
    const rebased = rebaseDraft(draft, base, current);
    expect(rebased.draft).toMatchObject({
      title: "Mi título",
      desc: "Mi texto",
      labels: "m4, urgente",
    });
    expect(rebased.clashes).toEqual(["title"]);
    // Saving now only sends what the human wrote; their labels stay.
    expect(changesFrom(rebased.draft, current, groups)).toEqual({
      ok: true,
      empty: false,
      changes: { title: "Mi título", desc: "Mi texto" },
    });
  });
});

describe("dependencies (UI-09)", () => {
  it("explains in Spanish why a dependency cannot be added (ac2)", () => {
    expect(dependencyProblem(doc, "BE-01", "BE-03")).toBe(
      "No se puede: BE-03 ya depende de BE-01, directa o indirectamente, y añadirla crearía un ciclo.",
    );
    expect(dependencyProblem(doc, "BE-01", "BE-01")).toBe("BE-01 no puede depender de sí misma.");
    expect(dependencyProblem(doc, "BE-03", "BE-02")).toBe("BE-03 ya depende de BE-02.");
    expect(dependencyProblem(doc, "BE-03", "BE-09")).toBe(
      "No hay ninguna tarea BE-09 en este plan.",
    );
    expect(dependencyProblem(doc, "BE-03", "BE-01")).toBeNull();
  });

  it("translates the daemon's refusals", () => {
    const ctx = { id: "BE-01", on: "BE-03" };
    expect(
      editErrorText({ code: "invalid", message: "Adding BE-03 … would create a cycle" }, ctx),
    ).toContain("crearía un ciclo");
    expect(editErrorText({ code: "conflict", message: "changed" }, ctx)).toContain(
      "tu borrador se conserva",
    );
    expect(
      editErrorText({ code: "invalid", message: "x", issues: [{ code: "unknown_group" }] }, ctx),
    ).toContain("ese grupo ya no existe");
    expect(editErrorText({ code: "bad_request", message: "Invalid op" }, ctx)).toContain(
      "Algún campo",
    );
    expect(editErrorText({ code: "plan_invalid", message: "x" }, ctx)).not.toContain("x");
  });
});

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );

describe("editor and panel (UI-09)", () => {
  it("when the task changed while editing, shows the current version and keeps the draft (ac3)", () => {
    const old = boardTask(base);
    const now = boardTask({ ...base, title: "Cambiado fuera" });
    const out = wrap(
      <TaskEditor projectId="p" task={now} groups={groups} startFrom={old} onClose={() => {}} />,
    );
    expect(out).toContain("La tarea ha cambiado mientras la editabas.");
    expect(out).toContain("<dd>Cambiado fuera</dd>"); // the current version
    expect(out).toContain(`value="${base.title}"`); // the draft is still what was being edited
    expect(out).toMatch(/<button type="submit"[^>]*disabled=""/); // nothing can be saved over it
    expect(out).toContain("Seguir con mi borrador");
  });

  it("an up-to-date editor has no warning and can save", () => {
    const current = boardTask(base);
    const out = wrap(
      <TaskEditor projectId="p" task={current} groups={groups} onClose={() => {}} />,
    );
    expect(out).not.toContain("ha cambiado mientras");
    expect(out).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("offers Edit on a valid plan and nothing to edit when the plan is invalid (ac4)", () => {
    const panel = (readOnly: boolean) =>
      wrap(
        <TaskPanel
          projectId="p"
          task={boardTask(base)}
          doc={doc}
          groupName="Backend"
          groups={groups}
          external={[]}
          readOnly={readOnly}
          onClose={() => {}}
          onOpen={() => {}}
        />,
      );
    expect(panel(false)).toContain(">Editar<");
    const readOnly = panel(true);
    expect(readOnly).not.toContain(">Editar<");
    expect(readOnly).not.toContain("<form");
    expect(readOnly).not.toContain("Añadir dependencia");
  });
});

describe("dependency picker (UI-25)", () => {
  const plan: TasksDocument = {
    ...doc,
    tasks: [
      task("BE-01", { title: "Diseño del esquema" }),
      task("BE-02", { deps: ["BE-01"], title: "Migraciones" }),
      task("BE-03", { deps: ["BE-02"], title: "API" }),
      task("FE-01", { group: "FE", title: "Pantalla de diseño" }),
    ],
  };
  const ids = (options: { id: string }[]) => options.map((o) => o.id);

  it("finds tasks by id or by title, ignoring case and accents, id matches first", () => {
    expect(ids(dependencyOptions(plan, null, [], "fe"))).toEqual(["FE-01"]);
    expect(ids(dependencyOptions(plan, null, [], "diseno"))).toEqual(["BE-01", "FE-01"]);
    expect(ids(dependencyOptions(plan, null, [], ""))).toEqual([
      "BE-01",
      "BE-02",
      "BE-03",
      "FE-01",
    ]);
  });

  it("never offers the task itself, its current deps, nor tasks that depend on it", () => {
    // BE-02 and BE-03 depend on BE-01: picking them would close a cycle.
    expect(ids(dependencyOptions(plan, "BE-01", [], ""))).toEqual(["FE-01"]);
    expect(ids(dependencyOptions(plan, "BE-03", ["BE-02"], ""))).toEqual(["BE-01", "FE-01"]);
  });

  it("renders as a combobox in the editor and in the creator", () => {
    const html = renderToStaticMarkup(
      <DepPicker
        doc={plan}
        task="BE-03"
        chosen={[]}
        label="Añadir dependencia"
        onPick={() => true}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="listbox"');
  });
});
