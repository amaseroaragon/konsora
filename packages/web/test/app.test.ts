import { describe, expect, it } from "vitest";
import { blockers, byId, depths, formatDuration, isWaiting, type Task } from "../src/app/model.ts";
import { type AppState, reducer } from "../src/app/state.ts";
import { mockProject } from "../src/mock/data.ts";

const base: AppState = {
  project: mockProject,
  view: "board",
  query: "",
  selected: new Set(),
  open: null,
  tab: "detail",
  agent: { provider: "claude", model: "opus", effort: "alto" },
  permissions: "default",
  parallel: 2,
};
const find = (state: AppState, id: string) => state.project.tasks.find((t) => t.id === id) as Task;

describe("view model", () => {
  const index = byId(mockProject.tasks);

  it("only done dependencies unblock; review does not", () => {
    expect(blockers(index.get("CORE-05") as Task, index)).toEqual(["CORE-03", "CORE-04"]);
    expect(blockers(index.get("UI-06") as Task, index)).toEqual([]);
  });

  it("detects an unanswered question", () => {
    expect(isWaiting(index.get("UI-04") as Task)).toBe(true);
    expect(isWaiting(index.get("CORE-04") as Task)).toBe(false);
  });

  it("layers tasks by longest dependency path", () => {
    const d = depths(mockProject.tasks);
    expect(d.get("CORE-01")).toBe(0);
    expect(d.get("CORE-05")).toBe(3);
    expect(d.get("DMN-02")).toBe(6);
  });

  it("formats durations", () => {
    expect(formatDuration(252)).toBe("4:12");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});

describe("mock reducer", () => {
  it("runs only ready selected tasks and clears the selection", () => {
    const state = reducer(
      { ...base, selected: new Set(["UI-06", "CORE-05"]) },
      { type: "runSelection", at: "2026-11-02T14:00:00Z" },
    );
    expect(find(state, "UI-06").state).toBe("doing");
    expect(find(state, "CORE-05").state).toBe("todo");
    expect(state.selected.size).toBe(0);
    expect(
      state.project.runs.filter((r) => r.task === "UI-06" && r.state === "running"),
    ).toHaveLength(1);
  });

  it("send back requires the task to return to todo with a human feedback note", () => {
    const state = reducer(base, {
      type: "sendBack",
      id: "CORE-04",
      text: "Add a test",
      at: "2026-11-02T14:00:00Z",
    });
    const task = find(state, "CORE-04");
    expect(task.state).toBe("todo");
    expect(task.notes.at(-1)).toMatchObject({ by: "human", kind: "feedback", text: "Add a test" });
  });

  it("accept marks the task done and its run integrated", () => {
    const state = reducer(base, { type: "accept", id: "CORE-04" });
    expect(find(state, "CORE-04").state).toBe("done");
    expect(state.project.runs.find((r) => r.task === "CORE-04")?.integrated).toBe(true);
  });

  it("cancelling a run returns its task to todo", () => {
    const state = reducer(base, { type: "cancelRun", id: "r-01JD5A" });
    expect(find(state, "CORE-03").state).toBe("todo");
    expect(state.project.runs.find((r) => r.id === "r-01JD5A")?.state).toBe("cancelled");
  });
});
