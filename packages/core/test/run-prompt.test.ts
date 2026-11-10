import { describe, expect, it } from "vitest";
import {
  buildAnswerMessage,
  buildRebasePrompt,
  buildResumePrompt,
  buildRetryPrompt,
  buildReviewPrompt,
  buildRunPrompt,
} from "../src/run-prompt.ts";
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

describe("buildAnswerMessage", () => {
  // BE-02 without its trailing unanswered question.
  const task2 = document.tasks[2] as Task;
  const base: Task = { ...task2, notes: (task2.notes ?? []).slice(0, -1) };

  it("carries the latest answer with its question", () => {
    expect(buildAnswerMessage(base)).toBe(
      [
        "The human answered your question on BE-02.",
        "",
        "Question:",
        "> Memory or Redis?",
        "",
        "Answer:",
        "> Memory is enough for now.",
        "",
        "Continue with BE-02. When it is done, call `finish` with your summary.",
        "",
      ].join("\n"),
    );
  });

  it("is null without an answer, or when a newer question is still open", () => {
    expect(buildAnswerMessage({ ...base, notes: [note("question", "Q?")] })).toBeNull();
    expect(buildAnswerMessage({ ...base, notes: [] })).toBeNull();
    expect(
      buildAnswerMessage({
        ...base,
        notes: [note("question", "Q1?"), note("answer", "A1"), note("question", "Q2?")],
      }),
    ).toBeNull();
  });
});

describe("buildRebasePrompt (RUN-24)", () => {
  const input = {
    branch: "konsora/BE-01/01JABCDEFGHJ",
    onto: "a".repeat(40),
    files: ["src/b.ts", "src/a.ts", "src/b.ts"],
  };

  it("is deterministic and lists the conflicting files, sorted and once", () => {
    const first = buildRebasePrompt(document, "BE-01", input);
    expect(
      buildRebasePrompt(document, "BE-01", { ...input, files: ["src/a.ts", "src/b.ts"] }),
    ).toBe(first);
    expect(first).toContain("- `src/a.ts`\n- `src/b.ts`\n");
    expect(first).toContain(`git rebase ${"a".repeat(40)}`);
    expect(first).toContain("konsora/BE-01/01JABCDEFGHJ");
    expect(first).toContain("`npm test`");
    expect(first).toMatchSnapshot();
  });

  it("forbids pushing and forcing, and touching base_branch", () => {
    const text = buildRebasePrompt(document, "BE-01", input);
    expect(text).toContain("never check out, reset, commit to, push or force-update `main`");
    expect(text).toContain("Never push anything and never use `--force`");
    expect(text).toContain("`.konsora/`");
  });

  it("says so when git named no files", () => {
    expect(buildRebasePrompt(document, "BE-01", { ...input, files: [] })).toContain(
      "Git did not name the conflicting files",
    );
  });
});

describe("tool guidance (RUN-26)", () => {
  const guidance =
    "Create, change and read files with your file-editing and file-reading tools, not with shell commands. Run shell commands one at a time, never chained with `&&`, `;` or pipes.";

  it("tells the agent of a run and of a rebase how to avoid approvals, naming what it may run", () => {
    const prompts = [
      buildRunPrompt(document, "BE-02"),
      buildRebasePrompt(document, "BE-01", { branch: "b", onto: "a".repeat(40), files: [] }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(guidance);
      expect(prompt).toContain("`git add …`, `git commit …`,");
      expect(prompt).toContain("`npm ci`,");
      expect(prompt).toContain("any other command may wait for the human's approval");
    }
  });

  it("names the read-only commands the default profile allows, and none that writes (CORE-16)", () => {
    const prompt = buildRunPrompt(document, "BE-02");
    expect(prompt).toContain(
      "`git show …`, `git blame …`, `git add …`, `git commit …`, `ls …`, `cat …`, `head …`, " +
        "`tail …`, `wc …`, `grep …`, `rg …`, `sed -n …` and the project's checks without asking",
    );
    expect(prompt).not.toMatch(/`(sed -i|find|tee)\b/);
  });
});

describe("buildResumePrompt (RUN-27)", () => {
  it("is deterministic and tells the agent that Konsora restarted and to go on with the task", () => {
    const text = buildResumePrompt("BE-01");
    expect(buildResumePrompt("BE-01")).toBe(text);
    expect(text).toContain("Konsora stopped while you were working on BE-01");
    expect(text).toContain("call `finish`");
  });
});

describe("the agent writes in the task's language (CORE-14)", () => {
  const rule = "in the language of the task's title and description";
  const spanish: TasksDocument = {
    ...document,
    tasks: [
      ...document.tasks,
      task("BE-04", {
        title: "Añadir caché de previsiones",
        desc: "Guarda las previsiones 10 minutos.",
      }),
    ],
  };

  it("the run prompt asks for notes, questions and summary in it", () => {
    const prompt = buildRunPrompt(spanish, "BE-04");
    expect(prompt).toContain(`- Write your notes, questions and summary ${rule};`);
    expect(prompt).toContain("Añadir caché de previsiones");
    // The rule is text of the prompt, not a detected language: the same input, the same prompt.
    expect(buildRunPrompt(spanish, "BE-04")).toBe(prompt);
  });

  it("the retry and rebase prompts ask for it too", () => {
    const retry = buildRetryPrompt(
      "BE-04",
      {
        attempt: 1,
        results: [
          {
            id: "test",
            source: "project",
            command: "npm test",
            exit_code: 1,
            duration_ms: 10,
            timed_out: false,
            output: "1 failing",
          },
        ],
      },
      1,
    );
    expect(retry).toContain(`with an updated summary, ${rule} as before.`);
    const rebase = buildRebasePrompt(spanish, "BE-04", {
      branch: "konsora/BE-04/01JABCDEFGHJ",
      onto: "a".repeat(40),
      files: [],
    });
    expect(rebase).toContain(`- Write your questions and summary ${rule};`);
  });

  it("the review prompt asks for the text of the review in it", () => {
    const prompt = buildReviewPrompt(spanish, "BE-04", {
      run: { id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW", summary: "Hecho." },
      diff: null,
    });
    expect(prompt).toContain(`- Write the text of your review ${rule};`);
    expect(
      buildReviewPrompt(spanish, "BE-04", {
        run: { id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW", summary: "Hecho." },
        diff: null,
      }),
    ).toBe(prompt);
  });
});
