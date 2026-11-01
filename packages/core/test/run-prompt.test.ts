import { describe, expect, it } from "vitest";
import { buildRunPrompt } from "../src/run-prompt.ts";
import type { Note, Task, TasksDocument } from "../src/schema.ts";

const at = "2026-11-02T10:00:00Z";
let noteSeq = 0;
const note = (kind: Note["kind"], text: string, minute = 0): Note => ({
  id: `n${++noteSeq}`,
  at: `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`,
  by: kind === "feedback" || kind === "answer" ? "human" : "agent:claude",
  kind,
  text,
});

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "todo",
    group: "BE",
    rank: id.toLowerCase().replace("-", ""),
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}

const document: TasksDocument = {
  schema: "konsora/2",
  project: {
    name: "tiempo",
    base_branch: "main",
    checks: [
      { id: "test", run: "npm test" },
      { id: "lint", run: "npm run lint" },
    ],
  },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks: [
    task("BE-01", {
      title: "Forecast client",
      state: "done",
      notes: [
        note("note", "half way", 1),
        note("summary", "First summary, later replaced.", 2),
        note("summary", "Client in src/forecast.ts with retries.\nTested against fixtures.", 3),
      ],
    }),
    task("BE-03", { title: "Settings", state: "done" }),
    task("BE-02", {
      title: "Add forecast cache",
      desc: "Cache forecasts for 10 minutes so repeated requests do not hit upstream.",
      deps: ["BE-01", "BE-03"],
      acceptance: [
        {
          id: "ac1",
          text: "A repeated request within 10 min does not hit upstream",
          check: "npm test -- cache",
        },
        { id: "ac2", text: "The cache age is logged" },
      ],
      notes: [
        note("note", "ORDINARY-NOTE: started on the cache", 4),
        note("question", "Memory or Redis?", 5),
        note("answer", "Memory is enough for now.", 6),
        note("summary", "AGENT-SUMMARY: first attempt", 7),
        note("feedback", "The TTL must be configurable.\nUse an env var.", 8),
        note("question", "UNANSWERED: should the TTL default to 5?", 9),
      ],
    }),
  ],
};

describe("buildRunPrompt", () => {
  const prompt = buildRunPrompt(document, "BE-02", { branch: "konsora/BE-02/01JC8Z3K2QX7" });

  it("includes every part of the task and the protocol", () => {
    expect(prompt).toMatchSnapshot();
    for (const part of [
      "Add forecast cache",
      "Cache forecasts for 10 minutes",
      "ac1: A repeated request within 10 min does not hit upstream",
      "Check: `npm test -- cache`",
      "ac2: The cache age is logged",
      "test: `npm test`",
      "konsora/BE-02/01JC8Z3K2QX7",
      "`note`",
      "`ask`",
      "`finish`",
      "`.konsora/`",
      "Never push",
    ]) {
      expect(prompt).toContain(part);
    }
  });

  it("keeps feedback, answers with their question and dependency summaries, but not ordinary notes", () => {
    expect(prompt).toContain("> The TTL must be configurable.\n> Use an env var.");
    expect(prompt).toContain(
      "Question (2026-11-02T10:05:00Z):\n> Memory or Redis?\nAnswer (2026-11-02T10:06:00Z):\n> Memory is enough for now.",
    );
    expect(prompt).toContain(
      "### BE-01: Forecast client (done)\n\n> Client in src/forecast.ts with retries.\n> Tested against fixtures.",
    );
    expect(prompt).toContain("### BE-03: Settings (done)\n\n(no summary)");
    expect(prompt).not.toContain("First summary, later replaced.");
    expect(prompt).not.toContain("ORDINARY-NOTE");
    expect(prompt).not.toContain("half way");
    expect(prompt).not.toContain("AGENT-SUMMARY");
    expect(prompt).not.toContain("UNANSWERED");
  });

  it("is deterministic and leaves out empty sections", () => {
    expect(buildRunPrompt(document, "BE-02", { branch: "konsora/BE-02/01JC8Z3K2QX7" })).toBe(
      prompt,
    );
    const bare = buildRunPrompt(
      { ...document, project: { name: "x", base_branch: "trunk" } },
      "BE-03",
    );
    expect(bare).not.toMatch(/## (Acceptance criteria|Project checks|From the human|Dependencies)/);
    expect(bare).toContain("(no description)");
    expect(bare).toContain("this worktree's branch, created from `trunk`");
  });

  it("refuses an unknown task", () => {
    expect(() => buildRunPrompt(document, "BE-99")).toThrow(/BE-99 does not exist/);
  });
});
