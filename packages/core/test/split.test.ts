import { describe, expect, it } from "vitest";
import { compareByRank, topoOrder } from "../src/graph.ts";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, type Op, type OpContext } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { validateDocument } from "../src/semantics.ts";

const at = "2026-11-02T10:00:00Z";
const agent: OpContext = { actor: "agent:claude", at };
const task = (id: string, rank: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `T ${id}`,
  state: "todo",
  group: "BE",
  rank,
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const base = (): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
  ],
  milestones: [{ id: "m1", name: "Uno" }],
  seq: { BE: 4, FE: 0 },
  tasks: [
    task("BE-01", "a", { state: "done" }),
    task("BE-02", "b", {
      group: "FE",
      deps: ["BE-01"],
      labels: ["perf"],
      difficulty: "high",
      milestone: "m1",
      desc: "Grande",
    }),
    task("BE-03", "c", { deps: ["BE-02"] }),
    task("BE-04", "d", { deps: ["BE-02", "BE-03"] }),
  ],
});
const split: Op = {
  op: "split",
  task: "BE-02",
  into: [
    { title: "Primera parte", acceptance: ["Uno"] },
    { title: "Segunda parte", desc: "La otra mitad", difficulty: "low" },
  ],
};
function run(doc: TasksDocument, op: Op, ctx: OpContext = agent): TasksDocument {
  const result = applyOp(doc, op, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
}
const byId = (doc: TasksDocument, id: string) => doc.tasks.find((t) => t.id === id) as Task;

describe("split a task (CORE-20)", () => {
  it("replaces a task nobody started by several that inherit its group, labels and deps", () => {
    const result = applyOp(base(), split, agent);
    if (!result.ok) throw new Error(result.error.message);
    const d = result.document;
    expect(result.created).toEqual(["FE-01", "FE-02"]);
    expect(d.tasks.some((t) => t.id === "BE-02")).toBe(false);
    expect(d.deleted?.at(-1)).toMatchObject({ id: "BE-02", by: "agent:claude" });
    const [first, second] = [byId(d, "FE-01"), byId(d, "FE-02")];
    expect(first).toMatchObject({
      title: "Primera parte",
      state: "todo",
      group: "FE",
      deps: ["BE-01"],
      labels: ["perf"],
      difficulty: "high",
      milestone: "m1",
      acceptance: [{ id: "ac1", text: "Uno" }],
    });
    expect(first.desc).toBeUndefined();
    expect(second).toMatchObject({
      deps: ["FE-01"],
      desc: "La otra mitad",
      difficulty: "low",
      labels: ["perf"],
    });
    expect(first.notes?.[0]?.text).toBe("Split from BE-02 (T BE-02).");
  });

  it("the dependents depend on the last part, and the plan has no cycles", () => {
    const d = run(base(), split);
    expect(byId(d, "BE-03").deps).toEqual(["FE-02"]);
    expect(byId(d, "BE-04").deps?.sort()).toEqual(["BE-03", "FE-02"]);
    expect(byId(d, "BE-03").events?.at(-1)).toMatchObject({ type: "edit", fields: ["deps"] });
    expect(topoOrder(d).cyclic).toEqual([]);
    expect(validateDocument(d).ok).toBe(true);
  });

  it("keeps the original's place in the order", () => {
    const d = run(base(), split);
    expect([...d.tasks].sort(compareByRank).map((t) => t.id)).toEqual([
      "BE-01",
      "FE-01",
      "FE-02",
      "BE-03",
      "BE-04",
    ]);
  });

  it("an idea splits into ideas", () => {
    const doc = base();
    (doc.tasks[1] as Task).state = "proposed";
    const d = run(doc, split);
    expect([byId(d, "FE-01").state, byId(d, "FE-02").state]).toEqual(["proposed", "proposed"]);
  });

  it("refuses started work, a single part, and is allowed in a planning session", () => {
    const doing = base();
    (doing.tasks[1] as Task).state = "doing";
    const refused = applyOp(doing, split, agent);
    expect(!refused.ok && refused.error.code).toBe("invalid_transition");
    const one = applyOp(base(), { op: "split", task: "BE-02", into: [{ title: "x" }] }, agent);
    expect(!one.ok && one.error.code).toBe("invalid");
    expect(applyOp(base(), split, { ...agent, plan: true }).ok).toBe(true);
    const planDoing = applyOp(doing, split, { ...agent, plan: true });
    expect(!planDoing.ok && planDoing.error.code).toBe("out_of_scope");
  });

  it("parses from JSON", () => {
    expect(parseOp(split).ok).toBe(true);
    expect(parseOp({ op: "split", task: "BE-02", into: [{ title: "a" }] }).ok).toBe(false);
  });
});
