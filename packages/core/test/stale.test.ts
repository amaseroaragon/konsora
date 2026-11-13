import { describe, expect, it } from "vitest";
import { isStale, STALE_AFTER_HOURS } from "../src/graph.ts";
import { applyOp } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { serializeDocument } from "../src/serialize.ts";

const started = "2026-11-10T10:00:00Z";
const task = (extra: Partial<Task> = {}): Task => ({
  id: "BE-01",
  title: "Cache",
  state: "doing",
  group: "BE",
  rank: "a",
  created: { at: started, by: "human" },
  started: { at: started, by: "agent:claude" },
  updated_at: started,
  ...extra,
});
const at = (iso: string) => new Date(iso);

describe("abandoned tasks in progress (CORE-10)", () => {
  it("a task in doing with no activity for longer than the threshold is stale", () => {
    expect(STALE_AFTER_HOURS).toBe(24);
    expect(isStale(task(), at("2026-11-11T09:59:00Z"))).toBe(false);
    expect(isStale(task(), at("2026-11-11T10:00:01Z"))).toBe(true);
    expect(isStale(task(), at("2026-11-10T12:30:00Z"), 2)).toBe(true);
    expect(isStale(task(), at("2026-11-10T11:30:00Z"), 2)).toBe(false);
  });

  it("only tasks in progress can be stale", () => {
    for (const state of ["proposed", "todo", "done"] as const)
      expect(isStale(task({ state }), at("2026-12-01T00:00:00Z"))).toBe(false);
  });

  it("a new note or any change clears it", () => {
    const doc: TasksDocument = {
      schema: "konsora/5",
      project: { name: "P" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 1 },
      tasks: [task({ acceptance: [{ id: "ac1", text: "x" }] })],
    };
    const now = at("2026-11-12T10:00:00Z");
    expect(isStale(doc.tasks[0] as Task, now)).toBe(true);
    const later = "2026-11-12T09:00:00Z";
    for (const op of [
      { op: "note" as const, task: "BE-01", text: "Sigo" },
      { op: "edit" as const, task: "BE-01", changes: { title: "Caché" } },
    ]) {
      const r = applyOp(doc, op, { actor: "agent:claude", at: later });
      if (!r.ok) throw new Error(r.error.message);
      expect(isStale(r.document.tasks[0] as Task, now)).toBe(false);
    }
  });

  it("is derived: nothing about it is written to the plan", () => {
    const doc: TasksDocument = {
      schema: "konsora/5",
      project: { name: "P" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 1 },
      tasks: [task()],
    };
    expect(serializeDocument(doc)).not.toMatch(/stale/i);
  });
});
