import { describe, expect, it } from "vitest";
import {
  applyOp,
  availableActions,
  planMove,
  type Task,
  TaskStateSchema,
  type TasksDocument,
} from "../src/index.ts";

const taskStates = TaskStateSchema.options;

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 7 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "doing", { deps: ["BE-01"] }),
    t("BE-03", "todo", { deps: ["BE-02"] }),
    t("BE-04", "todo", { deps: ["BE-01"] }),
    t("BE-05", "proposed", { created: { at, by: "agent:claude" } }),
    t("BE-06", "doing"),
    t("BE-07", "todo", { deps: ["BE-05"] }),
  ],
};

describe("planMove (human)", () => {
  it.each([
    ["BE-05", "todo", "promote"],
    ["BE-04", "proposed", "demote"],
    ["BE-01", "todo", "reopen"],
    ["BE-06", "todo", "pause"],
  ] as const)("%s → %s is %s", (id, to, op) => {
    expect(planMove(doc, id, to)).toEqual({
      ok: true,
      op,
      from: doc.tasks.find((x) => x.id === id)?.state,
      to,
    });
  });

  it("refuses agent-only moves with the op that would do them", () => {
    expect(planMove(doc, "BE-04", "doing")).toMatchObject({
      ok: false,
      reason: "forbidden",
      op: "start",
    });
    expect(planMove(doc, "BE-06", "done")).toMatchObject({
      ok: false,
      reason: "forbidden",
      op: "finish",
    });
  });

  it("refuses pairs with no single op, and the same column", () => {
    expect(planMove(doc, "BE-05", "done")).toMatchObject({ ok: false, reason: "no_op" });
    expect(planMove(doc, "BE-04", "done")).toMatchObject({ ok: false, reason: "no_op" });
    expect(planMove(doc, "BE-04", "todo")).toMatchObject({ ok: false, reason: "same_state" });
    expect(planMove(doc, "BE-99", "todo")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("an agent may start a ready task but not a blocked one, and may promote ideas", () => {
    expect(planMove(doc, "BE-04", "doing", "agent:claude")).toMatchObject({
      ok: true,
      op: "start",
    });
    expect(planMove(doc, "BE-03", "doing", "agent:claude")).toMatchObject({
      ok: false,
      reason: "blocked",
      blockers: ["BE-02"],
    });
    expect(planMove(doc, "BE-05", "todo", "agent:claude")).toMatchObject({
      ok: true,
      op: "promote",
    });
    expect(planMove(doc, "BE-01", "todo", "agent:claude")).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });

  it("agrees with applyOp for every task × column (an allowed move always applies)", () => {
    for (const task of doc.tasks)
      for (const to of taskStates) {
        const plan = planMove(doc, task.id, to);
        if (!plan.ok) continue;
        const result = applyOp(
          doc,
          { op: plan.op, task: task.id, feedback: "x" } as Parameters<typeof applyOp>[1],
          { actor: "human", at },
        );
        expect(result.ok && result.document.tasks.find((x) => x.id === task.id)?.state).toBe(to);
      }
  });
});

describe("availableActions", () => {
  const withQuestion: TasksDocument = {
    ...doc,
    tasks: doc.tasks.map((task) =>
      task.id === "BE-06"
        ? { ...task, notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "TTL?" }] }
        : task,
    ),
  };

  it.each([
    ["BE-05", ["promote", "delete"]],
    ["BE-02", ["delete"]],
    ["BE-01", ["reopen", "delete"]],
    ["BE-04", ["demote", "delete"]],
    ["BE-06", ["delete"]],
  ] as const)("human on %s", (id, actions) => {
    expect(availableActions(doc, id)).toEqual(actions);
  });

  it("offers answering only while a question is open", () => {
    expect(availableActions(withQuestion, "BE-06")).toEqual(["answer", "delete"]);
  });

  it("offers agents only promoting, demoting and deleting what nobody started", () => {
    expect(availableActions(withQuestion, "BE-05", "agent:claude")).toEqual(["promote", "delete"]);
    expect(availableActions(withQuestion, "BE-04", "agent:claude")).toEqual(["demote", "delete"]);
    for (const id of ["BE-01", "BE-02", "BE-06"])
      expect(availableActions(withQuestion, id, "agent:claude")).toEqual([]);
  });
});
