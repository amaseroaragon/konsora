import { applyOp, type Op, OpSchema, type TasksDocument } from "@konsora/core";
import { describe, expect, it } from "vitest";
import { createOp, emptyDraft } from "../src/shell/create-model.ts";

const at = "2026-11-11T10:00:00Z";
const plan: TasksDocument = {
  schema: "konsora/3",
  project: {
    name: "Demo",
    templates: [{ id: "bug", name: "Bug", acceptance: [{ text: "Un test lo reproduce" }] }],
  },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  seq: { BE: 1, FE: 0 },
  tasks: [
    {
      id: "BE-01",
      title: "Base",
      state: "todo",
      group: "BE",
      rank: "a",
      created: { at, by: "human" },
      updated_at: at,
    },
  ],
};
const ctx = { groups: plan.groups, tasks: plan.tasks, templates: plan.project.templates };

describe("create a task from the UI", () => {
  it("builds one propose op in todo that core accepts, with only the fields given", () => {
    const result = createOp(
      {
        ...emptyDraft("FE"),
        title: "  Pantalla de previsión ",
        desc: " Qué consigue ",
        acceptance: [{ text: " Se ve la previsión " }, { text: "  " }],
        labels: "ui, fe",
        deps: "be-01",
        template: "bug",
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      op: {
        op: "propose",
        state: "todo",
        title: "Pantalla de previsión",
        group: "FE",
        desc: "Qué consigue",
        acceptance: ["Se ve la previsión"],
        labels: ["ui", "fe"],
        deps: ["BE-01"],
        template: "bug",
      },
    });
    const op = OpSchema.parse(result.ok ? result.op : null) as Op;
    const applied = applyOp(plan, op, { actor: "human", at });
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.created).toEqual(["FE-01"]);
    expect(applied.document.tasks.find((t) => t.id === "FE-01")).toMatchObject({
      state: "todo",
      deps: ["BE-01"],
      acceptance: [
        { id: "ac1", text: "Un test lo reproduce" },
        { id: "ac2", text: "Se ve la previsión" },
      ],
    });
  });

  it("can create a proposal instead, and a minimal task has no optional fields", () => {
    const result = createOp({ ...emptyDraft("BE"), title: "Idea", state: "proposed" }, ctx);
    expect(result).toEqual({
      ok: true,
      op: { op: "propose", state: "proposed", title: "Idea", group: "BE" },
    });
  });

  it("explains a missing title, an unknown group, dependency or template in Spanish", () => {
    expect(createOp(emptyDraft("BE"), ctx)).toMatchObject({ ok: false, field: "title" });
    expect(createOp({ ...emptyDraft("ZZ"), title: "x" }, ctx)).toMatchObject({
      ok: false,
      field: "group",
      message: "El grupo ZZ no existe en este plan.",
    });
    expect(createOp({ ...emptyDraft("BE"), title: "x", deps: "BE-01, BE-09" }, ctx)).toEqual({
      ok: false,
      field: "deps",
      message: "BE-09 no existe en este plan.",
    });
    expect(createOp({ ...emptyDraft("BE"), title: "x", template: "nope" }, ctx)).toMatchObject({
      ok: false,
      field: "template",
    });
  });
});
