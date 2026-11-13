import { describe, expect, it } from "vitest";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, type Op, type OpContext } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";

const at = "2026-11-02T10:00:00Z";
const human: OpContext = { actor: "human", at };
const agent: OpContext = { actor: "agent:claude", at };
const task = (id: string, group = id.split("-")[0] as string): Task => ({
  id,
  title: `T ${id}`,
  state: "todo",
  group,
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});
const base = (): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
    { id: "OPS", name: "Ops" },
  ],
  seq: { BE: 1, FE: 0, OPS: 0 },
  tasks: [task("BE-01")],
});
function run(doc: TasksDocument, op: Op, ctx: OpContext = agent): TasksDocument {
  const result = applyOp(doc, op, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
}
const error = (doc: TasksDocument, op: Op, ctx: OpContext = agent) => {
  const result = applyOp(doc, op, ctx);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};

describe("groups and the project's name (CORE-13)", () => {
  it("renames a group, keeping its id", () => {
    const d = run(base(), { op: "rename-group", id: "FE", name: "  Web  " });
    expect(d.groups[1]).toEqual({ id: "FE", name: "Web" });
    expect(error(base(), { op: "rename-group", id: "XX", name: "x" }).code).toBe("not_found");
    expect(error(base(), { op: "rename-group", id: "FE", name: "  " }).code).toBe("invalid");
  });

  it("reorders the groups with a permutation of every id", () => {
    const d = run(base(), { op: "reorder-groups", ids: ["OPS", "BE", "FE"] });
    expect(d.groups.map((g) => g.id)).toEqual(["OPS", "BE", "FE"]);
    for (const ids of [
      ["BE", "FE"],
      ["BE", "FE", "FE"],
      ["BE", "FE", "XX"],
      ["BE", "FE", "OPS", "X"],
    ])
      expect(error(base(), { op: "reorder-groups", ids }).code).toBe("invalid");
  });

  it("removes a group no task uses, with its seq entry", () => {
    const d = run(base(), { op: "remove-group", id: "OPS" });
    expect(d.groups.map((g) => g.id)).toEqual(["BE", "FE"]);
    expect(d.seq).toEqual({ BE: 1, FE: 0 });
  });

  it("refuses to remove a group with tasks, with an actionable error", () => {
    const e = error(base(), { op: "remove-group", id: "BE" });
    expect(e.code).toBe("in_use");
    expect(e.message).toContain("BE-01");
    // A task moved to another group keeps its prefix, and an archived id counts too.
    const moved = { ...base(), tasks: [task("BE-01", "FE")] };
    expect(error(moved, { op: "remove-group", id: "BE" }).code).toBe("in_use");
    expect(error(moved, { op: "remove-group", id: "FE" }).code).toBe("in_use");
    const archived = { ...base(), tasks: [], archived: ["BE-01"] };
    expect(error(archived, { op: "remove-group", id: "BE" }).code).toBe("in_use");
    expect(error(base(), { op: "remove-group", id: "XX" }).code).toBe("not_found");
  });

  it("never removes the last group", () => {
    const one: TasksDocument = {
      ...base(),
      groups: [{ id: "OPS", name: "Ops" }],
      seq: {},
      tasks: [],
    };
    expect(error(one, { op: "remove-group", id: "OPS" }).code).toBe("invalid");
  });

  it("only the human renames the project", () => {
    expect(run(base(), { op: "rename-project", name: " Weather " }, human).project.name).toBe(
      "Weather",
    );
    expect(error(base(), { op: "rename-project", name: "X" }).code).toBe("forbidden");
    expect(error(base(), { op: "rename-project", name: " " }, human).code).toBe("invalid");
  });

  it("group ops change no task and are refused in a planning session", () => {
    const result = applyOp(base(), { op: "rename-group", id: "BE", name: "API" }, agent);
    expect(result.ok && result.changed).toEqual([]);
    const plan = applyOp(base(), { op: "remove-group", id: "OPS" }, { ...agent, plan: true });
    expect(!plan.ok && plan.error.code).toBe("out_of_scope");
  });

  it("parses the new ops from JSON", () => {
    for (const op of [
      { op: "rename-group", id: "BE", name: "API" },
      { op: "reorder-groups", ids: ["FE", "BE"] },
      { op: "remove-group", id: "BE" },
      { op: "rename-project", name: "P" },
    ])
      expect(parseOp(op).ok).toBe(true);
    expect(parseOp({ op: "rename-project", name: "" }).ok).toBe(false);
  });
});
