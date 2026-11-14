import { describe, expect, it } from "vitest";
import { completionLog, dependencySummaries } from "../src/history.ts";
import type { Note, Task, TaskState } from "../src/schema.ts";

const created = { at: "2026-11-01T09:00:00Z", by: "human" };
function task(id: string, state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title ${id}`,
    state,
    group: "T",
    rank: "a0",
    created,
    updated_at: "2026-11-01T09:00:00Z",
    ...extra,
  };
}
const note = (id: string, kind: Note["kind"], at: string, text: string = kind): Note => ({
  id,
  at,
  by: "agent:claude",
  kind,
  text,
});

describe("completionLog", () => {
  it("dates a done task by its last summary note, else by updated_at", () => {
    const log = completionLog({
      tasks: [
        task("T-01", "done", {
          updated_at: "2026-11-05T12:00:00Z",
          notes: [
            note("n1", "summary", "2026-11-02T10:00:00Z", "first try"),
            note("n2", "note", "2026-11-03T10:00:00Z"),
            note("n3", "summary", "2026-11-04T10:00:00Z", "final"),
          ],
        }),
        task("T-02", "done", { updated_at: "2026-11-03T08:30:00Z" }),
      ],
    });
    expect(log).toEqual([
      {
        id: "T-01",
        title: "Title T-01",
        group: "T",
        at: "2026-11-04T10:00:00Z",
        by: "agent:claude",
        summary: "final",
      },
      { id: "T-02", title: "Title T-02", group: "T", at: "2026-11-03T08:30:00Z" },
    ]);
  });

  it("lists everything newest first, same-second ties by the higher id as a number", () => {
    const at = (when: string) => ({ notes: [note("n1", "summary", when)] });
    const log = completionLog({
      tasks: [
        task("T-01", "done", at("2026-11-06T10:00:00Z")),
        task("T-02", "done", at("2026-11-07T10:00:00Z")),
        task("T-03", "done", at("2026-11-02T10:00:00Z")),
        task("T-04", "done", at("2026-11-02T10:00:00Z")),
        task("T-100", "done", at("2026-11-02T10:00:00Z")),
      ],
    });
    expect(log.map((entry) => entry.id)).toEqual(["T-02", "T-01", "T-100", "T-04", "T-03"]);
  });

  it("leaves out tasks that are not done", () => {
    const summary = [note("n1", "summary", "2026-11-02T10:00:00Z")];
    const log = completionLog({
      tasks: [
        task("T-01", "proposed"),
        task("T-02", "todo", { notes: summary }),
        task("T-03", "doing", { notes: summary }),
        task("T-04", "done"),
      ],
    });
    expect(log.map((entry) => entry.id)).toEqual(["T-04"]);
  });

  it("is empty for an empty plan", () => {
    expect(completionLog({ tasks: [] })).toEqual([]);
  });
});

describe("dependencySummaries", () => {
  it("returns the done direct dependencies in deps order, archived ones included", () => {
    const doc = {
      tasks: [
        task("A-1", "done", { notes: [note("n1", "summary", "2026-11-02T09:00:00Z", "one")] }),
        task("A-2", "todo"),
        task("A-4", "done"),
      ],
    };
    const archived = [
      task("A-3", "done", { notes: [note("n1", "summary", "2026-11-01T10:00:00Z", "three")] }),
    ];
    const entries = dependencySummaries({ deps: ["A-4", "A-3", "A-2", "A-1"] }, doc, archived);
    expect(entries.map((e) => [e.id, e.summary, e.archived])).toEqual([
      ["A-4", undefined, undefined],
      ["A-3", "three", true],
      ["A-1", "one", undefined],
    ]);
    expect(dependencySummaries({}, doc)).toEqual([]);
  });
});
