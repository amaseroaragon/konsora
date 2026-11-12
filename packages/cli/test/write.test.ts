import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasksFile, serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], deps: string[] = []): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: "BE",
  ...(deps.length ? { deps } : {}),
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
});

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "P" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 5 },
    tasks: [
      t("BE-01", "done"),
      t("BE-02", "doing", ["BE-01"]),
      t("BE-03", "todo", ["BE-02"]),
      t("BE-04", "todo", ["BE-01"]),
      t("BE-05", "proposed"),
    ],
  };
}

let dir: string;
const file = () => join(dir, ".konsora", "tasks.json");
const bytes = () => readFileSync(file(), "utf8");
const doc = () => {
  const r = parseTasksFile(bytes());
  if (!r.ok) throw new Error("invalid plan on disk");
  return r.document;
};
const task = (id: string) => doc().tasks.find((x) => x.id === id) as Task;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-write-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".konsora"));
  writeFileSync(file(), serializeDocument(plan()));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: dir,
    env: options.env ?? {},
    readStdin: async () => options.stdin ?? "",
    now: () => new Date("2026-11-03T09:30:00Z"),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("attribution", () => {
  it("--as and KONSORA_AGENT name the agent; default is agent:unknown", async () => {
    await run(["propose", "A", "--group", "BE", "--as", "Claude"]);
    await run(["propose", "B", "--group", "be"], { env: { KONSORA_AGENT: "codex" } });
    await run(["propose", "C", "--group", "BE"]);
    expect(["BE-06", "BE-07", "BE-08"].map((id) => task(id).created.by)).toEqual([
      "agent:claude",
      "agent:codex",
      "agent:unknown",
    ]);
    expect(task("BE-06").created.at).toBe("2026-11-03T09:30:00Z");
  });

  it.each(["human", "konsora", "agent:human"])(
    "refuses to act as %s (usage error, nothing written)",
    async (name) => {
      const before = bytes();
      const r = await run(["propose", "Sneaky", "--group", "BE", "--as", name]);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stderr).toContain("The CLI always acts as an agent");
      expect(bytes()).toBe(before);
    },
  );
});

describe("planning commands", () => {
  it("propose creates a todo task with criteria, deps and labels; --idea creates an idea", async () => {
    const r = await run([
      "propose",
      "Add caching",
      "--group",
      "BE",
      "--desc",
      "Cache it",
      "--criterion",
      "Fast",
      "--criterion",
      "Correct",
      "--deps",
      "be-01",
      "--labels",
      "perf",
    ]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe("Created BE-06: Add caching (todo).\n");
    expect(task("BE-06")).toMatchObject({
      state: "todo",
      desc: "Cache it",
      deps: ["BE-01"],
      labels: ["perf"],
      acceptance: [
        { id: "ac1", text: "Fast" },
        { id: "ac2", text: "Correct" },
      ],
    });
    const idea = await run(["propose", "Maybe later", "--group", "BE", "--idea"]);
    expect(idea.stdout).toContain("Created idea BE-07");
    expect(task("BE-07").state).toBe("proposed");
    expect((await run(["promote", "BE-07"])).stdout).toBe("Promoted BE-07 to todo.\n");
    expect(task("BE-07").state).toBe("todo");
  });

  it("batch from stdin creates groups and resolves deps by earlier titles", async () => {
    const input = JSON.stringify({
      groups: [{ id: "FE", name: "Frontend" }],
      tasks: [
        { title: "API endpoint", group: "BE", deps: ["BE-01"], acceptance: ["Returns 200"] },
        { title: "Screen", group: "FE", deps: ["API endpoint"] },
      ],
    });
    const r = await run(["batch", "--as", "claude"], { stdin: input });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Created 2 task(s):\n  BE-06     API endpoint\n  FE-01     Screen");
    expect(task("FE-01")).toMatchObject({ state: "todo", deps: ["BE-06"] });
  });

  it("batch creates tasks with idea: true as ideas, and its help says so", async () => {
    const input = JSON.stringify({
      tasks: [
        { title: "Ship it", group: "BE" },
        { title: "Someday", group: "BE", idea: true },
      ],
    });
    expect((await run(["batch", "--as", "claude"], { stdin: input })).code).toBe(EXIT.ok);
    expect(task("BE-06").state).toBe("todo");
    expect(task("BE-07").state).toBe("proposed");
    const help = await run(["batch", "--help"]);
    expect(help.stdout).toContain('"idea":true');
    expect(help.stdout).toContain("is created as an idea (proposed)");
  });

  it.each([
    [
      "a dependency on a later title (would be a cycle)",
      [
        { title: "A", group: "BE", deps: ["B"] },
        { title: "B", group: "BE", deps: ["A"] },
      ],
    ],
    [
      "an unknown dependency",
      [
        { title: "A", group: "BE" },
        { title: "B", group: "BE", deps: ["BE-99"] },
      ],
    ],
    [
      "an unknown group",
      [
        { title: "A", group: "BE" },
        { title: "B", group: "OPS" },
      ],
    ],
  ])("batch with %s writes nothing", async (_name, tasks) => {
    const before = bytes();
    const r = await run(["batch", "--json"], { stdin: JSON.stringify({ tasks }) });
    expect(r.code).toBe(EXIT.failure);
    expect(r.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(bytes()).toBe(before);
  });

  it("batch rejects malformed JSON and unknown fields as usage errors", async () => {
    expect((await run(["batch"], { stdin: "{ nope" })).code).toBe(EXIT.usage);
    const r = await run(["batch"], {
      stdin: JSON.stringify({ tasks: [{ title: "A", group: "BE", state: "done" }] }),
    });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("Batch has the wrong shape");
  });

  it("propose and batch take a template; an unknown one fails with a hint; status lists them", async () => {
    const withTemplates = plan();
    withTemplates.project.templates = [
      {
        id: "bug",
        name: "Bug fix",
        desc: "Reproduce and fix.",
        acceptance: [{ text: "A test reproduces it" }],
        labels: ["bug"],
      },
    ];
    writeFileSync(file(), serializeDocument(withTemplates));

    const status = await run(["status"]);
    expect(status.stdout).toContain(
      "Templates (propose --template <id>):\n  bug       Bug fix  [1 criteria; labels bug]\n",
    );
    expect((await run(["status", "--json"])).json().project.templates).toHaveLength(1);

    const r = await run([
      "propose",
      "Crash",
      "--group",
      "BE",
      "--template",
      "BUG",
      "--criterion",
      "Own",
    ]);
    expect(r.code).toBe(EXIT.ok);
    expect(task("BE-06")).toMatchObject({
      desc: "Reproduce and fix.",
      acceptance: [
        { id: "ac1", text: "A test reproduces it" },
        { id: "ac2", text: "Own" },
      ],
      labels: ["bug"],
    });
    const batch = JSON.stringify({ tasks: [{ title: "B", group: "BE", template: "bug" }] });
    expect((await run(["batch"], { stdin: batch })).code).toBe(EXIT.ok);
    expect(task("BE-07")).toMatchObject({ desc: "Reproduce and fix.", labels: ["bug"] });

    const before = bytes();
    const missing = await run(["propose", "X", "--group", "BE", "--template", "feature"]);
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.stderr).toContain('Template "feature" does not exist');
    expect(missing.stderr).toContain("Hint: `konsora status` lists the project's templates");
    const json = await run(["propose", "X", "--group", "BE", "--template", "feature", "--json"]);
    expect(json.json()).toMatchObject({ ok: false, error: { code: "unknown_template" } });
    expect(bytes()).toBe(before);
  });

  it("batch can read a file", async () => {
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ tasks: [{ title: "From file", group: "BE" }] }),
    );
    expect((await run(["batch", "--file", "plan.json"])).code).toBe(EXIT.ok);
    expect(task("BE-06").title).toBe("From file");
  });

  it("edit, depend, undepend and delete work on unfinished tasks only", async () => {
    expect(
      (await run(["edit", "BE-04", "--title", "Better title", "--criterion", "Works"])).code,
    ).toBe(EXIT.ok);
    expect(task("BE-04")).toMatchObject({
      title: "Better title",
      acceptance: [{ id: "ac1", text: "Works" }],
    });
    expect((await run(["depend", "BE-05", "BE-04"])).stdout).toBe("BE-05 now depends on BE-04.\n");
    expect((await run(["undepend", "BE-05", "BE-04"])).code).toBe(EXIT.ok);
    expect(task("BE-05").deps).toBeUndefined();

    const finished = await run(["edit", "BE-01", "--title", "Hijack"]);
    expect(finished.code).toBe(EXIT.failure);
    expect(finished.stderr).toContain("only humans can change finished work");
    expect(finished.stderr).toContain("Hint: Agents create, start, note, ask and finish");

    expect((await run(["delete", "BE-05"])).stdout).toBe("Deleted BE-05.\n");
    expect(doc().tasks.map((x) => x.id)).not.toContain("BE-05");
    expect((await run(["delete", "BE-02"])).code).toBe(EXIT.failure); // doing: the human's
    expect((await run(["delete", "BE-03"])).code).toBe(EXIT.ok);
  });

  it("has no block commands or options any more", async () => {
    const help = await run(["--help"]);
    expect(help.stdout).not.toMatch(/\bblocks?\b|merge/i);
    expect((await run(["add-block", "cache", "--name", "Cache"])).code).not.toBe(EXIT.ok);
    expect((await run(["propose", "TTL", "--group", "BE", "--block", "cache"])).code).not.toBe(
      EXIT.ok,
    );
  });

  it("depend rejects cycles", async () => {
    const r = await run(["depend", "BE-02", "BE-03"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("would create a cycle");
  });
});

describe("work commands", () => {
  it("start refuses blocked tasks with the blockers and a hint", async () => {
    const r = await run(["start", "BE-03"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toBe(
      "Error: BE-03 is blocked by BE-02\nHint: Pick another task with `konsora ready`, or wait until its dependencies are done.\n",
    );
  });

  it("start → note → ask → finish moves a ready task to done with notes", async () => {
    const started = await run(["start", "BE-04", "-m", "Plan: add an LRU", "--as", "claude"]);
    expect(started.code).toBe(EXIT.ok);
    expect(started.stdout).toContain("Started BE-04 (doing).");
    writeFileSync(join(dir, "note.md"), "Line one\nLínea dos ✓");
    await run(["note", "BE-04", "--file", "note.md", "--as", "claude"]);
    await run(["note", "BE-04", "--stdin", "--as", "claude"], { stdin: "From stdin" });
    expect((await run(["ask", "BE-04", "Which TTL?", "--as", "claude"])).stdout).toContain(
      "Stop here",
    );
    expect((await run(["finish", "BE-04", "--as", "claude"])).code).toBe(EXIT.usage); // no summary
    const done = await run([
      "finish",
      "BE-04",
      "--summary",
      "LRU with TTL, tests added",
      "--as",
      "claude",
    ]);
    expect(done.stdout).toBe("Finished BE-04: done.\n");
    expect(task("BE-04").state).toBe("done");
    expect(task("BE-04").notes?.map((n) => [n.kind, n.text])).toEqual([
      ["note", "Plan: add an LRU"],
      ["note", "Line one\nLínea dos ✓"],
      ["note", "From stdin"],
      ["question", "Which TTL?"],
      ["summary", "LRU with TTL, tests added"],
    ]);
  });

  it("pause returns a task to todo; text may only come from one source", async () => {
    await run(["start", "BE-04"]);
    expect((await run(["pause", "BE-04", "-m", "Need input"])).stdout).toBe(
      "Paused BE-04 (todo).\n",
    );
    expect(task("BE-04").state).toBe("todo");
    expect((await run(["note", "BE-04", "a", "-m", "b"])).code).toBe(EXIT.usage);
  });

  it("--json returns the affected tasks with their hash", async () => {
    const r = await run(["start", "BE-04", "--json"]);
    expect(r.json()).toMatchObject({
      ok: true,
      changed: ["BE-04"],
      tasks: [{ id: "BE-04", state: "doing", hash: expect.stringMatching(/^sha256:/) }],
    });
  });
});

describe("no human transitions in the CLI", () => {
  it.each([
    "approve",
    "accept",
    "send-back",
    "reopen",
    "yolo",
    "done",
    "answer",
    "merge",
    "delete-block",
  ])("`konsora %s` does not exist", async (name) => {
    const r = await run([name, "BE-02"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("unknown command");
  });

  it("an agent reaches done only by finishing, and never reopens finished work", async () => {
    await run(["start", "BE-04"]);
    await run(["finish", "BE-04", "--summary", "x"]);
    expect(task("BE-04").state).toBe("done");
    expect(task("BE-04").notes?.at(-1)?.kind).toBe("summary");
    expect((await run(["edit", "BE-04", "--title", "x"])).code).toBe(EXIT.failure);
    expect((await run(["delete", "BE-04"])).code).toBe(EXIT.failure);
  });
});
