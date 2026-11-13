import { describe, expect, it } from "vitest";
import type { Task, TasksDocument } from "../src/schema.ts";
import { activityStats } from "../src/stats.ts";

const created = { at: "2026-10-01T09:00:00Z", by: "human" };
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  state: "done",
  group: "BE",
  rank: "a",
  created,
  updated_at: created.at,
  ...extra,
});
const ev = (type: "start" | "pause" | "finish" | "reopen", at: string, by = "agent:claude") => ({
  at,
  by,
  type,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  tasks: [
    // 2 h in progress, closed on the 10th by claude.
    task("BE-01", {
      events: [ev("start", "2026-11-10T08:00:00Z"), ev("finish", "2026-11-10T10:00:00Z")],
    }),
    // Paused (its time does not count from the first start), restarted, closed by codex on the 12th.
    task("BE-02", {
      events: [
        ev("start", "2026-11-11T08:00:00Z", "agent:codex"),
        ev("pause", "2026-11-11T09:00:00Z", "agent:codex"),
        ev("start", "2026-11-12T08:00:00Z", "agent:codex"),
        ev("finish", "2026-11-12T12:00:00Z", "agent:codex"),
      ],
    }),
    // Closed, reopened and closed again on the 12th: two closures, reopened once.
    task("BE-03", {
      events: [
        ev("start", "2026-11-12T06:00:00Z"),
        ev("finish", "2026-11-12T07:00:00Z"),
        ev("reopen", "2026-11-12T07:30:00Z", "human"),
        ev("start", "2026-11-12T08:00:00Z"),
        ev("finish", "2026-11-12T09:00:00Z"),
      ],
    }),
    // Closed long before the window.
    task("BE-04", {
      events: [ev("start", "2026-09-01T08:00:00Z"), ev("finish", "2026-09-01T09:00:00Z")],
    }),
    task("BE-05", { state: "doing", events: [ev("start", "2026-11-12T10:00:00Z")] }),
  ],
};
const now = new Date("2026-11-12T20:00:00Z");

describe("activity stats (UI-18)", () => {
  it("counts closures per day and per agent over the window, oldest day first", () => {
    const stats = activityStats(doc, [], { now, days: 7, timeZone: "UTC" });
    expect(stats.days.map((d) => d.day)).toEqual([
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    expect(stats.days.at(-1)).toEqual({
      day: "2026-11-12",
      total: 3,
      byActor: { "agent:claude": 2, "agent:codex": 1 },
    });
    expect(stats.days[4]).toMatchObject({ total: 1, byActor: { "agent:claude": 1 } });
    expect(stats.closures).toBe(4);
    expect(stats.actors).toEqual(["agent:claude", "agent:codex"]);
  });

  it("averages the time from start to finish, restarting after a pause or a reopen", () => {
    const stats = activityStats(doc, [], { now, days: 7, timeZone: "UTC" });
    // BE-01 2 h, BE-02 4 h, BE-03 1 h + 1 h.
    expect(stats.cycle).toEqual({ averageMs: ((2 + 4 + 1 + 1) * 3_600_000) / 4, samples: 4 });
  });

  it("counts the distinct tasks reopened in the window", () => {
    expect(activityStats(doc, [], { now, days: 7, timeZone: "UTC" }).reopened).toBe(1);
    expect(
      activityStats(doc, [], { now: new Date("2026-12-31T00:00:00Z"), days: 7, timeZone: "UTC" }),
    ).toMatchObject({ closures: 0, reopened: 0, cycle: null, actors: [] });
  });

  it("counts archived tasks too, and legacy closures without events", () => {
    const archived = [
      task("BE-09", {
        notes: [
          { id: "n1", at: "2026-11-12T05:00:00Z", by: "agent:gemini", kind: "summary", text: "ok" },
        ],
      }),
    ];
    const stats = activityStats(doc, archived, { now, days: 7, timeZone: "UTC" });
    expect(stats.closures).toBe(5);
    expect(stats.days.at(-1)?.byActor["agent:gemini"]).toBe(1);
    // Its start is unknown: it does not move the average.
    expect(stats.cycle?.samples).toBe(4);
  });

  it("uses the local day of the given time zone", () => {
    // 23:30 UTC on the 11th is the 12th in Madrid.
    const late = {
      ...doc,
      tasks: [task("BE-01", { events: [ev("finish", "2026-11-11T23:30:00Z")] })],
    };
    const madrid = activityStats(late, [], { now, days: 2, timeZone: "Europe/Madrid" });
    expect(madrid.days.map((d) => [d.day, d.total])).toEqual([
      ["2026-11-11", 0],
      ["2026-11-12", 1],
    ]);
  });
});
