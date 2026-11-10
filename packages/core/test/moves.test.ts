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
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 7 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "review", { deps: ["BE-01"] }),
    t("BE-03", "todo", { deps: ["BE-02"] }),
    t("BE-04", "todo", { deps: ["BE-01"] }),
    t("BE-05", "proposed", { created: { at, by: "agent:claude" } }),
    t("BE-06", "doing"),
    t("BE-07", "todo", { deps: ["BE-05"] }),
  ],
};

describe("planMove (human)", () => {
  it.each([
    ["BE-05", "todo", "approve"],
    ["BE-02", "done", "accept"],
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

  it("sending back asks for feedback", () => {
    expect(planMove(doc, "BE-02", "todo")).toMatchObject({
      ok: true,
      op: "send-back",
      needs: "feedback",
    });
  });

  it("refuses agent-only moves with the op that would do them", () => {
    expect(planMove(doc, "BE-04", "doing")).toMatchObject({
      ok: false,
      reason: "forbidden",
      op: "start",
    });
    expect(planMove(doc, "BE-06", "review")).toMatchObject({
      ok: false,
      reason: "forbidden",
      op: "finish",
    });
  });

  it("refuses pairs with no single op, and the same column", () => {
    expect(planMove(doc, "BE-05", "done")).toMatchObject({ ok: false, reason: "no_op" });
    expect(planMove(doc, "BE-04", "review")).toMatchObject({ ok: false, reason: "no_op" });
    expect(planMove(doc, "BE-04", "todo")).toMatchObject({ ok: false, reason: "same_state" });
    expect(planMove(doc, "BE-99", "todo")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("an agent may start a ready task but not a blocked one, and is told why", () => {
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
    ["BE-05", ["approve"]],
    ["BE-02", ["accept", "send-back"]],
    ["BE-01", ["reopen"]],
    ["BE-04", []],
    ["BE-06", []],
  ] as const)("human on %s", (id, actions) => {
    expect(availableActions(doc, id)).toEqual(actions);
  });

  it("offers withdrawing a proposal only while nothing depends on it", () => {
    expect(availableActions(doc, "BE-05")).not.toContain("withdraw"); // BE-07 depends on it
    const alone = { ...doc, tasks: doc.tasks.filter((task) => task.id !== "BE-07") };
    expect(availableActions(alone, "BE-05")).toEqual(["approve", "withdraw"]);
    expect(availableActions(doc, "BE-06")).not.toContain("withdraw"); // approved work
  });

  it("offers answering only while a question is open", () => {
    expect(availableActions(withQuestion, "BE-06")).toEqual(["answer"]);
  });

  it("offers agents none of the human actions", () => {
    for (const task of withQuestion.tasks)
      expect(availableActions(withQuestion, task.id, "agent:claude")).toEqual([]);
  });
});
