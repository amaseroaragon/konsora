import { deriveFlags, planMove, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { describe, expect, it } from "vitest";
import {
  actionBody,
  type BoardOk,
  moveBody,
  reconnectDelay,
  toDocument,
} from "../src/api/board.ts";
import {
  ALL_LANE,
  boardLanes,
  dropTargets,
  externalText,
  opErrorText,
  refusalText,
} from "../src/shell/board-model.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: id.split("-")[0] as string,
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

const doc: TasksDocument = {
  schema: "konsora/4",
  project: { name: "P" },
  groups: [
    { id: "BE", name: "Backend" },
    { id: "FE", name: "Frontend" },
    { id: "OPS", name: "Ops" },
  ],
  seq: { BE: 3, FE: 2 },
  tasks: [
    t("BE-01", "done"),
    t("BE-02", "doing", { deps: ["BE-01"] }),
    t("BE-03", "todo", { deps: ["BE-02"] }),
    t("FE-01", "proposed", { created: { at, by: "agent:claude" } }),
    t("FE-02", "doing"),
  ],
};

/** The board as the daemon sends it: stored fields + derived flags + hash. */
function boardOf(plan: TasksDocument): BoardOk {
  const flags = deriveFlags(plan);
  const { tasks, ...rest } = plan;
  return {
    status: "ok",
    project: { id: "p-000000000000", name: "P", path: "/p", added_at: at },
    hash: "sha256:x",
    external: [],
    plan: rest,
    tasks: tasks.map((task) => ({
      ...task,
      ...(flags.get(task.id) as NonNullable<ReturnType<typeof flags.get>>),
      hash: taskHash(task),
    })),
  };
}

const board = boardOf(doc);

describe("board data", () => {
  it("strips derived fields back to the stored plan", () => {
    expect(toDocument(board)).toEqual(doc);
  });

  it("sends a move as one op conditioned on the task hash", () => {
    const task = board.tasks.find((x) => x.id === "BE-02") as BoardOk["tasks"][number];
    expect(moveBody({ task, op: "pause", to: "todo" })).toEqual({
      op: "pause",
      task: "BE-02",
      expect: { "BE-02": taskHash(doc.tasks[1] as Task) },
    });
  });

  it("backs off reconnects up to 10 s", () => {
    expect([0, 1, 2, 5, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 10_000, 10_000]);
  });
});

describe("lanes", () => {
  it("one lane per group with tasks, cells in state order", () => {
    const lanes = boardLanes(board, true);
    expect(lanes.map((l) => l.id)).toEqual(["BE", "FE"]);
    expect(lanes[0]?.cells.map((cell) => cell.map((x) => x.id))).toEqual([
      [],
      ["BE-03"],
      ["BE-02"],
      ["BE-01"],
    ]);
  });

  it("a single lane without swimlanes", () => {
    const lanes = boardLanes(board, false);
    expect(lanes.map((l) => [l.id, l.name])).toEqual([[ALL_LANE, "Todas"]]);
    expect(lanes[0]?.cells.flat()).toHaveLength(5);
  });
});

describe("drops", () => {
  it("marks the columns core allows", () => {
    const allowed = (id: string) =>
      [...dropTargets(doc, id)].filter(([, plan]) => plan.ok).map(([state]) => state);
    expect(allowed("FE-01")).toEqual(["todo"]);
    expect(allowed("BE-02")).toEqual(["todo"]);
    expect(allowed("BE-01")).toEqual(["todo"]);
    expect(allowed("BE-03")).toEqual([]);
    expect(allowed("FE-02")).toEqual(["todo"]);
  });

  it("explains every refusal in Spanish", () => {
    const say = (id: string, to: Task["state"]) => refusalText(planMove(doc, id, to), id);
    expect(say("FE-01", "done")).toBe("FE-01 es una idea: pásala primero a Por hacer.");
    expect(say("BE-03", "doing")).toContain("las empieza un agente");
    expect(say("FE-02", "done")).toBe(
      "Solo el agente termina FE-02, con un resumen de lo que hizo.",
    );
    expect(say("BE-03", "done")).toBe("BE-03 no puede pasar de Por hacer a Hecho en un solo paso.");
    expect(say("BE-03", "todo")).toBeNull();
    expect(refusalText(planMove(doc, "BE-03", "doing", "agent:x"), "BE-03")).toBe(
      "BE-03 está bloqueada por BE-02.",
    );
  });

  it("explains refusals from the daemon", () => {
    expect(opErrorText("conflict", "BE-02", "x")).toContain("ha cambiado mientras tanto");
    expect(opErrorText("plan_invalid", "BE-02", "x")).toContain("no se puede escribir");
  });
});

describe("task actions", () => {
  const task = board.tasks.find((x) => x.id === "BE-02") as BoardOk["tasks"][number];
  const expectHash = { "BE-02": task.hash };

  it("builds each op with its text field and the task hash", () => {
    expect(actionBody({ task, action: "promote" })).toEqual({
      op: "promote",
      task: "BE-02",
      expect: expectHash,
    });
    expect(actionBody({ task, action: "delete", text: "ignored" })).toEqual({
      op: "delete",
      task: "BE-02",
      expect: expectHash,
    });
    expect(actionBody({ task, action: "answer", text: "10 min" })).toMatchObject({
      text: "10 min",
    });
    expect(actionBody({ task, action: "reopen" })).not.toHaveProperty("text");
    expect(actionBody({ task, action: "reopen", text: "Bug" })).toMatchObject({ text: "Bug" });
  });
});

describe("external changes", () => {
  const flag = (extra: Partial<Parameters<typeof externalText>[0]>) => ({
    task: "BE-02",
    kind: "transition",
    message: "english",
    detected_at: at,
    ...extra,
  });

  it("describes each kind in Spanish", () => {
    expect(externalText(flag({ from: "done", to: "todo" }))).toBe(
      "Hecho → Por hacer hecho fuera de Konsora, y ningún agente puede hacerlo.",
    );
    expect(externalText(flag({ kind: "created_approved", to: "todo" }))).toBe(
      "Creada fuera de Konsora directamente en Por hacer.",
    );
    expect(externalText(flag({ kind: "deleted", from: "done" }))).toContain("estaba en Hecho");
    expect(externalText(flag({ kind: "edited" }))).toBe(
      "Tarea terminada modificada fuera de Konsora.",
    );
    expect(externalText(flag({ kind: "future_kind" }))).toBe("english");
  });
});
