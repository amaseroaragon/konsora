import { describe, expect, it } from "vitest";
import { filterFacets, matchingIds } from "../src/filter.ts";
import { migratePlan } from "../src/migrate.ts";
import { milestoneProgress } from "../src/milestones.ts";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, type Op, type OpContext } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at = "2026-11-02T10:00:00Z";
const human: OpContext = { actor: "human", at };
const agent: OpContext = { actor: "agent:claude", at };
const task = (id: string, state: Task["state"] = "todo", extra: Partial<Task> = {}): Task => ({
  id,
  title: `T ${id}`,
  state,
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const base = (tasks: Task[] = [task("BE-01"), task("BE-02", "done")]): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks,
});
function run(doc: TasksDocument, op: Op, ctx: OpContext = agent): TasksDocument {
  const result = applyOp(doc, op, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
}
const refusal = (doc: TasksDocument, op: Op, ctx: OpContext = agent) => {
  const result = applyOp(doc, op, ctx);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};
const withM11 = () =>
  run(base(), { op: "add-milestone", id: "m11", name: " Giro ", criterion: "Todo verde" });

describe("milestones (CORE-19)", () => {
  it("adds, edits and removes milestones", () => {
    let d = withM11();
    expect(d.milestones).toEqual([{ id: "m11", name: "Giro", criterion: "Todo verde" }]);
    d = run(d, { op: "add-milestone", id: "m12", name: "Sin aprobación" });
    expect(d.milestones?.map((m) => m.id)).toEqual(["m11", "m12"]);
    d = run(d, { op: "edit-milestone", id: "m11", name: "Gestor", criterion: null });
    expect(d.milestones?.[0]).toEqual({ id: "m11", name: "Gestor" });
    d = run(d, { op: "edit-milestone", id: "m11", criterion: "Pruebas manuales" });
    expect(d.milestones?.[0]?.criterion).toBe("Pruebas manuales");
    d = run(d, { op: "remove-milestone", id: "m12" });
    d = run(d, { op: "remove-milestone", id: "m11" });
    expect(d.milestones).toBeUndefined();
  });

  it("rejects bad ids, repeated ids and unknown milestones", () => {
    expect(refusal(withM11(), { op: "add-milestone", id: "m11", name: "x" }).code).toBe("invalid");
    expect(refusal(base(), { op: "add-milestone", id: "M 1", name: "x" }).code).toBe("invalid");
    expect(refusal(base(), { op: "edit-milestone", id: "x", name: "y" }).code).toBe("not_found");
    expect(refusal(base(), { op: "remove-milestone", id: "x" }).code).toBe("not_found");
  });

  it("a task joins a milestone when created or edited, and leaves it with null", () => {
    let d = withM11();
    d = run(d, { op: "propose", title: "New", group: "BE", milestone: "m11" });
    expect(d.tasks.find((t) => t.title === "New")?.milestone).toBe("m11");
    d = run(d, {
      op: "batch",
      tasks: [{ title: "Batched", group: "BE", milestone: "m11" }],
    });
    expect(d.tasks.find((t) => t.title === "Batched")?.milestone).toBe("m11");
    d = run(d, { op: "edit", task: "BE-01", changes: { milestone: "m11" } });
    expect(d.tasks.find((t) => t.id === "BE-01")?.events?.at(-1)?.fields).toEqual(["milestone"]);
    d = run(d, { op: "edit", task: "BE-01", changes: { milestone: null } });
    expect(d.tasks.find((t) => t.id === "BE-01")?.milestone).toBeUndefined();
    expect(
      refusal(withM11(), { op: "edit", task: "BE-01", changes: { milestone: "nope" } }).code,
    ).toBe("not_found");
    expect(
      refusal(withM11(), { op: "propose", title: "x", group: "BE", milestone: "no" }).code,
    ).toBe("not_found");
    // Finished work stays the human's.
    expect(
      refusal(withM11(), { op: "edit", task: "BE-02", changes: { milestone: "m11" } }).code,
    ).toBe("forbidden");
    expect(
      run(withM11(), { op: "edit", task: "BE-02", changes: { milestone: "m11" } }, human).tasks[1]
        ?.milestone,
    ).toBe("m11");
  });

  it("refuses to remove a milestone that still has tasks", () => {
    const d = run(withM11(), { op: "edit", task: "BE-01", changes: { milestone: "m11" } });
    const error = refusal(d, { op: "remove-milestone", id: "m11" });
    expect(error.code).toBe("in_use");
    expect(error.message).toContain("BE-01");
  });

  it("validates unknown and repeated milestones in the file", () => {
    const bad = {
      ...base([task("BE-01", "todo", { milestone: "ghost" })]),
      milestones: [
        { id: "m1", name: "A" },
        { id: "m1", name: "B" },
      ],
    };
    const result = validateDocument(bad);
    expect(!result.ok && result.issues.map((i) => i.code).sort()).toEqual([
      "duplicate_milestone",
      "unknown_milestone",
    ]);
  });

  it("is serialized in canonical order and round-trips", () => {
    const d = run(withM11(), { op: "edit", task: "BE-01", changes: { milestone: "m11" } });
    const text = serializeDocument(d);
    const json = JSON.parse(text);
    expect(Object.keys(json)).toEqual([
      "schema",
      "project",
      "groups",
      "milestones",
      "seq",
      "tasks",
    ]);
    const keys = Object.keys(json.tasks[0]);
    expect(keys).toEqual([
      "id",
      "title",
      "state",
      "group",
      "rank",
      "milestone",
      "created",
      "updated_at",
      "events",
    ]);
    const parsed = parseTasksFile(text);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(text);
  });

  it("counts done and total tasks per milestone, archived ones included", () => {
    const d: TasksDocument = {
      ...base([
        task("BE-01", "todo", { milestone: "m11" }),
        task("BE-02", "done", { milestone: "m11" }),
        task("BE-03", "proposed", { milestone: "m12" }),
        task("BE-04"),
      ]),
      milestones: [
        { id: "m11", name: "Giro" },
        { id: "m12", name: "Otro" },
        { id: "m13", name: "Vacío" },
      ],
    };
    const archive = [task("BE-05", "done", { milestone: "m11" })];
    expect(milestoneProgress(d, archive).map((m) => [m.id, m.done, m.total])).toEqual([
      ["m11", 2, 3],
      ["m12", 0, 1],
      ["m13", 0, 0],
    ]);
    expect(milestoneProgress(d).map((m) => [m.id, m.done, m.total])[0]).toEqual(["m11", 1, 2]);
  });

  it("filters by milestone, or none for the tasks outside every one", () => {
    const d: TasksDocument = {
      ...base([task("BE-01", "todo", { milestone: "m11" }), task("BE-02")]),
      milestones: [{ id: "m11", name: "Giro" }],
    };
    expect([...matchingIds(d, { milestone: "m11" })]).toEqual(["BE-01"]);
    expect([...matchingIds(d, { milestone: "none" })]).toEqual(["BE-02"]);
    expect(filterFacets(d).milestones).toEqual(["m11", "none"]);
    expect(filterFacets(base()).milestones).toEqual([]);
  });

  it("needs no migration: konsora migrate output is valid without milestones", () => {
    const r = migratePlan({ ...base(), schema: "konsora/4" }, { at });
    if (!r.ok) throw new Error(r.message);
    expect(r.document.milestones).toBeUndefined();
    expect(validateDocument(r.document).ok).toBe(true);
  });

  it("parses the milestone ops from JSON", () => {
    for (const op of [
      { op: "add-milestone", id: "m1", name: "A", criterion: "B" },
      { op: "edit-milestone", id: "m1", criterion: null },
      { op: "remove-milestone", id: "m1" },
      { op: "edit", task: "BE-01", changes: { milestone: null } },
      { op: "propose", title: "x", group: "BE", milestone: "m1" },
    ])
      expect(parseOp(op).ok, JSON.stringify(op)).toBe(true);
  });
});
