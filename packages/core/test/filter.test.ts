import { describe, expect, it } from "vitest";
import {
  cleanFilter,
  filterFacets,
  isFilterActive,
  matchingIds,
  taskMatches,
} from "../src/filter.ts";
import type { Task, TaskState } from "../src/schema.ts";

const at = "2026-11-01T09:00:00Z";
function task(id: string, state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title ${id}`,
    state,
    group: id.split("-")[0] as string,
    rank: "a0",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}

const tasks = [
  task("BE-01", "done", {
    title: "Proxy forecast endpoint",
    labels: ["perf"],
    notes: [{ id: "n1", at, by: "agent:claude", kind: "summary", text: "Done." }],
  }),
  task("BE-02", "todo", { title: "Cache forecasts", desc: "Keyed by **rounded** lat/lon." }),
  task("FE-01", "proposed", {
    title: "Show cache age",
    labels: ["perf", "ui"],
    created: { at, by: "agent:codex" },
  }),
];
const ids = (filter: Parameters<typeof matchingIds>[1]) => [...matchingIds({ tasks }, filter)];

describe("task filters", () => {
  it("an empty filter passes everything and is not active", () => {
    expect(ids({})).toEqual(["BE-01", "BE-02", "FE-01"]);
    expect(isFilterActive({ text: "  ", group: "" })).toBe(false);
    expect(cleanFilter({ text: " cache ", label: "" })).toEqual({ text: "cache" });
  });

  it("text matches the id, the title or the description, ignoring case", () => {
    expect(ids({ text: "be-02" })).toEqual(["BE-02"]);
    expect(ids({ text: "CACHE" })).toEqual(["BE-02", "FE-01"]);
    expect(ids({ text: "rounded" })).toEqual(["BE-02"]);
    expect(ids({ text: "nothing like this" })).toEqual([]);
  });

  it("every word of the text must appear", () => {
    expect(ids({ text: "cache age" })).toEqual(["FE-01"]);
    expect(ids({ text: "cache be-" })).toEqual(["BE-02"]);
  });

  it("filters by group, by label and by who created or closed the task", () => {
    expect(ids({ group: "BE" })).toEqual(["BE-01", "BE-02"]);
    expect(ids({ label: "perf" })).toEqual(["BE-01", "FE-01"]);
    expect(ids({ by: "agent:claude" })).toEqual(["BE-01"]);
    expect(ids({ by: "agent:codex" })).toEqual(["FE-01"]);
    expect(ids({ by: "human" })).toEqual(["BE-01", "BE-02"]);
  });

  it("combines every part", () => {
    expect(ids({ group: "BE", label: "perf", text: "proxy" })).toEqual(["BE-01"]);
    expect(taskMatches(tasks[2] as Task, { group: "BE", label: "perf" })).toBe(false);
  });

  it("lists the labels and the actors the plan can be filtered by", () => {
    expect(filterFacets({ tasks })).toEqual({
      labels: ["perf", "ui"],
      actors: ["agent:claude", "agent:codex", "human"],
    });
  });
});
