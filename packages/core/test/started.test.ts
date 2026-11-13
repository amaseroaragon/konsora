import { describe, expect, it } from "vitest";
import { startedBy } from "../src/graph.ts";
import { migratePlan } from "../src/migrate.ts";
import { applyOp, type Op, type OpContext } from "../src/ops.ts";
import { type Task, type TasksDocument, validateStructure } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at0 = "2026-11-02T10:00:00Z";
const ctx = (actor: string, at: string): OpContext => ({ actor, at });
const task = (over: Partial<Task> = {}): Task => ({
  id: "BE-01",
  title: "Cache",
  state: "todo",
  group: "BE",
  rank: "a",
  created: { at: at0, by: "human" },
  updated_at: at0,
  ...over,
});
const base = (tasks: Task[] = [task()]): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: tasks.length },
  tasks,
});
function run(doc: TasksDocument, op: Op, context: OpContext): TasksDocument {
  const result = applyOp(doc, op, context);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
}
const first = (doc: TasksDocument) => doc.tasks[0] as Task;

describe("who started a task (CORE-09)", () => {
  it("start records the agent and the time", () => {
    const d = run(
      base(),
      { op: "start", task: "BE-01" },
      ctx("agent:claude", "2026-11-02T11:00:00Z"),
    );
    expect(first(d).started).toEqual({ at: "2026-11-02T11:00:00Z", by: "agent:claude" });
    expect(startedBy(first(d))).toEqual({ at: "2026-11-02T11:00:00Z", by: "agent:claude" });
  });

  it("pause removes it, a new start replaces it and finish keeps it", () => {
    let d = run(base(), { op: "start", task: "BE-01" }, ctx("agent:a", "2026-11-02T11:00:00Z"));
    d = run(d, { op: "pause", task: "BE-01" }, ctx("agent:a", "2026-11-02T11:10:00Z"));
    expect(first(d).started).toBeUndefined();
    expect(startedBy(first(d))).toBeUndefined();
    d = run(d, { op: "start", task: "BE-01" }, ctx("agent:b", "2026-11-02T12:00:00Z"));
    expect(first(d).started).toEqual({ at: "2026-11-02T12:00:00Z", by: "agent:b" });
    d = run(
      d,
      { op: "finish", task: "BE-01", summary: "Hecho" },
      ctx("agent:b", "2026-11-02T13:00:00Z"),
    );
    expect(first(d).started).toEqual({ at: "2026-11-02T12:00:00Z", by: "agent:b" });
  });

  it("reopen removes it", () => {
    let d = run(base(), { op: "start", task: "BE-01" }, ctx("agent:a", "2026-11-02T11:00:00Z"));
    d = run(d, { op: "finish", task: "BE-01", summary: "x" }, ctx("agent:a", at0));
    d = run(d, { op: "reopen", task: "BE-01" }, ctx("human", at0));
    expect(first(d).started).toBeUndefined();
  });

  it("a task started before the field existed falls back to its last start event", () => {
    const old = task({
      state: "doing",
      events: [
        { at: "2026-11-01T09:00:00Z", by: "agent:a", type: "start" },
        { at: "2026-11-01T09:30:00Z", by: "agent:a", type: "pause" },
        { at: "2026-11-01T10:00:00Z", by: "agent:b", type: "start" },
      ],
    });
    expect(startedBy(old)).toEqual({ at: "2026-11-01T10:00:00Z", by: "agent:b" });
    expect(startedBy(task({ state: "doing" }))).toBeUndefined();
    // A stale field on a task nobody is working on means nothing.
    expect(startedBy(task({ started: { at: at0, by: "agent:a" } }))).toBeUndefined();
  });

  it("is validated and serialized right after created", () => {
    const d = run(
      base(),
      { op: "start", task: "BE-01" },
      ctx("agent:claude", "2026-11-02T11:00:00Z"),
    );
    const text = serializeDocument(d);
    const keys = Object.keys(JSON.parse(text).tasks[0]);
    expect(keys.indexOf("started")).toBe(keys.indexOf("created") + 1);
    expect(validateDocument(JSON.parse(text)).ok).toBe(true);
    const parsed = parseTasksFile(text);
    expect(parsed.ok).toBe(true);
    const bad = validateStructure({ ...d, tasks: [{ ...first(d), started: { at: at0 } }] });
    expect(bad.ok).toBe(false);
    const badActor = validateStructure({
      ...d,
      tasks: [{ ...first(d), started: { at: at0, by: "someone" } }],
    });
    expect(badActor.ok).toBe(false);
  });

  it("konsora migrate leaves tasks in progress without it, and the result is valid", () => {
    const v4 = {
      schema: "konsora/4",
      project: { name: "P" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 1 },
      tasks: [{ ...task({ state: "doing" }) }],
    };
    const r = migratePlan(v4, { at: at0 });
    if (!r.ok) throw new Error(r.message);
    expect(r.document.tasks[0]?.started).toBeUndefined();
    expect(validateDocument(r.document).ok).toBe(true);
  });
});
