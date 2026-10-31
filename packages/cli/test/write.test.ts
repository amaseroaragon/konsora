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
    schema: "konsora/2",
    project: { name: "P", base_branch: "main" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 5 },
    tasks: [
      t("BE-01", "done"),
      t("BE-02", "review", ["BE-01"]),
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
  it("propose creates a proposal with criteria, deps and labels", async () => {
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
    expect(r.stdout).toBe("Proposed BE-06: Add caching\nIt is waiting for human approval.\n");
    expect(task("BE-06")).toMatchObject({
      state: "proposed",
      desc: "Cache it",
      deps: ["BE-01"],
      labels: ["perf"],
      acceptance: [
        { id: "ac1", text: "Fast" },
        { id: "ac2", text: "Correct" },
      ],
    });
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
    expect(r.stdout).toContain("Proposed 2 task(s):\n  BE-06     API endpoint\n  FE-01     Screen");
    expect(task("FE-01")).toMatchObject({ state: "proposed", deps: ["BE-06"] });
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

  it("batch can read a file", async () => {
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({ tasks: [{ title: "From file", group: "BE" }] }),
    );
    expect((await run(["batch", "--file", "plan.json"])).code).toBe(EXIT.ok);
    expect(task("BE-06").title).toBe("From file");
  });

  it("edit, depend, undepend and withdraw work on proposals only", async () => {
    expect(
      (await run(["edit", "BE-05", "--title", "Better title", "--criterion", "Works"])).code,
    ).toBe(EXIT.ok);
    expect(task("BE-05")).toMatchObject({
      title: "Better title",
      acceptance: [{ id: "ac1", text: "Works" }],
    });
    expect((await run(["depend", "BE-05", "BE-04"])).stdout).toBe("BE-05 now depends on BE-04.\n");
    expect((await run(["undepend", "BE-05", "BE-04"])).code).toBe(EXIT.ok);
    expect(task("BE-05").deps).toBeUndefined();

    const approved = await run(["edit", "BE-04", "--title", "Hijack"]);
    expect(approved.code).toBe(EXIT.failure);
    expect(approved.stderr).toContain("only humans can change approved work");
    expect(approved.stderr).toContain("Hint: Agents propose, start, note, ask and finish");

    expect((await run(["withdraw", "BE-05"])).stdout).toBe("Withdrew BE-05.\n");
    expect(doc().tasks.map((x) => x.id)).not.toContain("BE-05");
    expect((await run(["withdraw", "BE-04"])).code).toBe(EXIT.failure);
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

  it("start → note → ask → finish moves a ready task to review with notes", async () => {
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
    expect(done.stdout).toBe("Finished BE-04: waiting for human review. Stop here.\n");
    expect(task("BE-04").state).toBe("review");
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

  it("inside a run (KONSORA_RUN_TASK) an agent can only act on its task", async () => {
    await run(["start", "BE-04"]);
    const env = { KONSORA_RUN_TASK: "BE-04", KONSORA_RUN: "r-01JC8Z3K2Q", KONSORA_AGENT: "claude" };
    const other = await run(["note", "BE-03", "x"], { env });
    expect(other.code).toBe(EXIT.failure);
    expect(other.stderr).toContain("This run works on BE-04");
    await run(["note", "BE-04", "progress"], { env });
    expect(task("BE-04").notes?.at(-1)).toMatchObject({ text: "progress", run: "r-01JC8Z3K2Q" });
  });
});

describe("no human transitions in the CLI", () => {
  it.each(["approve", "accept", "send-back", "reopen", "yolo", "done", "answer"])(
    "`konsora %s` does not exist",
    async (name) => {
      const r = await run([name, "BE-02"]);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stderr).toContain("unknown command");
    },
  );

  it("no command sequence an agent can run marks a task done", async () => {
    // finish is the only way out of doing, and it leads to review.
    await run(["start", "BE-04"]);
    await run(["finish", "BE-04", "--summary", "x"]);
    expect(task("BE-04").state).toBe("review");
    expect(
      doc()
        .tasks.filter((x) => x.state === "done")
        .map((x) => x.id),
    ).toEqual(["BE-01"]);
  });
});
