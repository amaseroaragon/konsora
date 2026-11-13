import { describe, expect, it } from "vitest";
import { planActivity } from "../src/history.ts";
import { applyOp, type Op, type OpContext, undoOf } from "../src/ops.ts";
import { DELETED_LIMIT, EVENTS_LIMIT, type Task, type TasksDocument } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at0 = "2026-11-02T10:00:00Z";
const human = (at: string): OpContext => ({ actor: "human", at });
const agent = (at: string): OpContext => ({ actor: "agent:claude", at });
const base = (tasks: Task[] = []): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: tasks.length },
  tasks,
});
function run(doc: TasksDocument, op: Op, ctx: OpContext): TasksDocument {
  const result = applyOp(doc, op, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
}
const events = (doc: TasksDocument, id: string) => doc.tasks.find((t) => t.id === id)?.events ?? [];

describe("task events (CORE-17)", () => {
  it("every op that changes a task records who, when and what", () => {
    let d = run(
      base(),
      { op: "propose", title: "Cache", group: "BE", state: "proposed" },
      agent("2026-11-02T10:00:00Z"),
    );
    d = run(d, { op: "propose", title: "Other", group: "BE" }, agent("2026-11-02T10:00:00Z"));
    // Creating stores no event: `created` already holds it.
    expect(events(d, "BE-01")).toEqual([]);
    d = run(d, { op: "promote", task: "BE-01" }, human("2026-11-02T10:01:00Z"));
    d = run(d, { op: "demote", task: "BE-01" }, human("2026-11-02T10:02:00Z"));
    d = run(d, { op: "promote", task: "BE-01" }, agent("2026-11-02T10:03:00Z"));
    d = run(
      d,
      { op: "edit", task: "BE-01", changes: { title: "Caché", labels: ["perf"] } },
      agent("2026-11-02T10:04:00Z"),
    );
    d = run(d, { op: "depend", task: "BE-01", on: "BE-02" }, agent("2026-11-02T10:05:00Z"));
    d = run(d, { op: "undepend", task: "BE-01", on: "BE-02" }, agent("2026-11-02T10:06:00Z"));
    d = run(d, { op: "start", task: "BE-01" }, agent("2026-11-02T10:07:00Z"));
    d = run(d, { op: "pause", task: "BE-01" }, agent("2026-11-02T10:08:00Z"));
    d = run(d, { op: "start", task: "BE-01" }, agent("2026-11-02T10:09:00Z"));
    d = run(d, { op: "finish", task: "BE-01", summary: "Hecho" }, agent("2026-11-02T10:10:00Z"));
    d = run(d, { op: "reopen", task: "BE-01" }, human("2026-11-02T10:11:00Z"));
    // Reordering, notes and questions leave no event of their own.
    d = run(d, { op: "move", task: "BE-01", top: true }, human("2026-11-02T10:12:00Z"));
    d = run(d, { op: "note", task: "BE-01", text: "Ojo" }, human("2026-11-02T10:13:00Z"));
    expect(events(d, "BE-01")).toEqual([
      { at: "2026-11-02T10:01:00Z", by: "human", type: "promote" },
      { at: "2026-11-02T10:02:00Z", by: "human", type: "demote" },
      { at: "2026-11-02T10:03:00Z", by: "agent:claude", type: "promote" },
      { at: "2026-11-02T10:04:00Z", by: "agent:claude", type: "edit", fields: ["title", "labels"] },
      { at: "2026-11-02T10:05:00Z", by: "agent:claude", type: "edit", fields: ["deps"] },
      { at: "2026-11-02T10:06:00Z", by: "agent:claude", type: "edit", fields: ["deps"] },
      { at: "2026-11-02T10:07:00Z", by: "agent:claude", type: "start" },
      { at: "2026-11-02T10:08:00Z", by: "agent:claude", type: "pause" },
      { at: "2026-11-02T10:09:00Z", by: "agent:claude", type: "start" },
      { at: "2026-11-02T10:10:00Z", by: "agent:claude", type: "finish" },
      { at: "2026-11-02T10:11:00Z", by: "human", type: "reopen" },
    ]);
    // A rejected op records nothing.
    expect(applyOp(d, { op: "finish", task: "BE-01", summary: "x" }, agent(at0)).ok).toBe(false);
  });

  it("a deletion is kept in the plan with the task's id and title; its dependents record the change", () => {
    let d = run(
      base(),
      {
        op: "batch",
        tasks: [
          { title: "A", group: "BE" },
          { title: "B", group: "BE", deps: ["A"] },
        ],
      },
      agent(at0),
    );
    d = run(d, { op: "delete", task: "BE-01" }, human("2026-11-02T11:00:00Z"));
    expect(d.deleted).toEqual([
      { id: "BE-01", title: "A", at: "2026-11-02T11:00:00Z", by: "human" },
    ]);
    expect(events(d, "BE-02")).toEqual([
      { at: "2026-11-02T11:00:00Z", by: "human", type: "edit", fields: ["deps"] },
    ]);
  });

  it("undoing a deletion forgets it, and the plan is back byte for byte", () => {
    const before = run(base(), { op: "propose", title: "A", group: "BE" }, agent(at0));
    const result = applyOp(before, { op: "delete", task: "BE-01" }, human(at0));
    if (!result.ok) throw new Error("delete failed");
    const undone = run(
      result.document,
      { op: "undo", changes: undoOf(before, result.document, result.changed) },
      human(at0),
    );
    expect(undone.deleted).toBeUndefined();
    expect(serializeDocument(undone)).toBe(serializeDocument(before));
  });

  it("is bounded: the oldest events and deletions are dropped", () => {
    let d = run(base(), { op: "propose", title: "A", group: "BE" }, agent(at0));
    for (let i = 0; i < EVENTS_LIMIT + 5; i++) {
      const when = new Date(Date.UTC(2026, 10, 3, 0, i)).toISOString().replace(".000", "");
      d = run(d, { op: "start", task: "BE-01" }, agent(when));
      d = run(d, { op: "pause", task: "BE-01" }, agent(when));
    }
    const kept = events(d, "BE-01");
    expect(kept).toHaveLength(EVENTS_LIMIT);
    expect(kept.at(-1)?.type).toBe("pause");
    expect(kept[0]?.at).toBe("2026-11-03T00:30:00Z");

    let e = base();
    e.seq.BE = 0;
    for (let i = 0; i < DELETED_LIMIT + 3; i++) {
      e = run(e, { op: "propose", title: `T${i}`, group: "BE" }, agent(at0));
      e = run(e, { op: "delete", task: e.tasks[0]?.id as string }, agent(at0));
    }
    expect(e.deleted).toHaveLength(DELETED_LIMIT);
    expect(e.deleted?.[0]?.title).toBe("T3");
  });

  it("is part of the canonical format and validated", () => {
    let d = run(base(), { op: "propose", title: "A", group: "BE" }, agent(at0));
    d = run(d, { op: "edit", task: "BE-01", changes: { desc: "x" } }, agent(at0));
    d = run(d, { op: "propose", title: "B", group: "BE" }, agent(at0));
    d = run(d, { op: "delete", task: "BE-02" }, agent(at0));
    const text = serializeDocument(d);
    const parsed = parseTasksFile(text);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(text);
    // Events go after the notes, deletions after the tasks.
    expect(text.indexOf('"events"')).toBeGreaterThan(text.indexOf('"updated_at"'));
    expect(text.indexOf('"deleted"')).toBeGreaterThan(text.lastIndexOf('"events"'));
    const bad = structuredClone(d);
    (bad.tasks[0] as Task).events = [{ at: at0, by: "human", type: "approve" as "start" }];
    expect(validateDocument(bad).ok).toBe(false);
  });
});

describe("planActivity (CORE-17)", () => {
  it("lists creations, events and deletions, newest first", () => {
    let d = run(base(), { op: "propose", title: "A", group: "BE" }, agent("2026-11-02T10:00:00Z"));
    d = run(d, { op: "propose", title: "B", group: "BE" }, human("2026-11-02T10:00:00Z"));
    d = run(d, { op: "start", task: "BE-01" }, agent("2026-11-02T10:05:00Z"));
    d = run(d, { op: "finish", task: "BE-01", summary: "Hecho" }, agent("2026-11-02T10:05:00Z"));
    d = run(d, { op: "delete", task: "BE-02" }, human("2026-11-02T10:06:00Z"));
    expect(planActivity(d)).toEqual([
      {
        task: "BE-02",
        title: "B",
        type: "delete",
        at: "2026-11-02T10:06:00Z",
        by: "human",
        deleted: true,
      },
      // Same second: the later event of the task first.
      { task: "BE-01", title: "A", type: "finish", at: "2026-11-02T10:05:00Z", by: "agent:claude" },
      { task: "BE-01", title: "A", type: "start", at: "2026-11-02T10:05:00Z", by: "agent:claude" },
      { task: "BE-01", title: "A", type: "create", at: "2026-11-02T10:00:00Z", by: "agent:claude" },
    ]);
  });

  it("dates closures made before events existed by their summaries, and includes archived tasks", () => {
    const legacy: Task = {
      id: "BE-01",
      title: "Antigua",
      state: "done",
      group: "BE",
      rank: "a",
      created: { at: "2026-10-01T09:00:00Z", by: "human" },
      updated_at: "2026-10-02T09:00:00Z",
      notes: [
        { id: "n1", at: "2026-10-02T09:00:00Z", by: "agent:codex", kind: "summary", text: "x" },
      ],
    };
    // Reopened and finished again after CORE-17: that closure comes from its event only.
    let d = run(base([legacy]), { op: "reopen", task: "BE-01" }, human("2026-11-01T09:00:00Z"));
    d = run(d, { op: "start", task: "BE-01" }, agent("2026-11-01T10:00:00Z"));
    d = run(d, { op: "finish", task: "BE-01", summary: "y" }, agent("2026-11-01T11:00:00Z"));
    const archived: Task = { ...legacy, id: "BE-09", title: "Archivada" };
    const activity = planActivity(d, [archived]);
    expect(activity.map((e) => `${e.task} ${e.type} ${e.at.slice(0, 10)}`)).toEqual([
      "BE-01 finish 2026-11-01",
      "BE-01 start 2026-11-01",
      "BE-01 reopen 2026-11-01",
      "BE-09 finish 2026-10-02",
      "BE-01 finish 2026-10-02",
      "BE-09 create 2026-10-01",
      "BE-01 create 2026-10-01",
    ]);
    expect(activity.find((e) => e.task === "BE-09")?.archived).toBe(true);
  });
});
