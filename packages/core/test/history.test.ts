import { describe, expect, it } from "vitest";
import { completionLog } from "../src/history.ts";
import type { Block, Note, Task, TaskState } from "../src/schema.ts";

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
const commit = "a".repeat(40);
function block(id: string, merged?: Block["merged"]): Block {
  return {
    id,
    name: `Block ${id}`,
    branch: `konsora/${id}`,
    base: "main",
    created,
    ...(merged ? { merged } : {}),
  };
}

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
        task("T-02", "done", { updated_at: "2026-11-03T08:30:00Z", block: "b" }),
      ],
    });
    expect(log).toEqual([
      {
        kind: "task",
        id: "T-01",
        title: "Title T-01",
        group: "T",
        at: "2026-11-04T10:00:00Z",
        by: "agent:claude",
        summary: "final",
      },
      {
        kind: "task",
        id: "T-02",
        title: "Title T-02",
        group: "T",
        block: "b",
        at: "2026-11-03T08:30:00Z",
      },
    ]);
  });

  it("lists merged blocks with their commit, everything newest first", () => {
    const merged = {
      at: "2026-11-06T10:00:00Z",
      by: "human",
      commit,
      strategy: "squash" as const,
    };
    const log = completionLog({
      tasks: [
        task("T-01", "done", { notes: [note("n1", "summary", "2026-11-06T10:00:00Z")] }),
        task("T-02", "done", { notes: [note("n1", "summary", "2026-11-07T10:00:00Z")] }),
        task("T-03", "done", { notes: [note("n1", "summary", "2026-11-02T10:00:00Z")] }),
      ],
      blocks: [block("open"), block("docs", merged)],
    });
    expect(log.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "task:T-02",
      "block:docs", // same second as T-01: the merge goes first
      "task:T-01",
      "task:T-03",
    ]);
    expect(log[1]).toEqual({
      kind: "block",
      id: "docs",
      name: "Block docs",
      branch: "konsora/docs",
      base: "main",
      at: "2026-11-06T10:00:00Z",
      by: "human",
      commit,
      strategy: "squash",
    });
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
