import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../src/main.ts";
import { SLOW_TIMEOUT } from "./slow-timeout.ts";

const at = "2026-11-02T10:00:00Z";
const t = (
  id: string,
  state: Task["state"],
  deps: string[] = [],
  extra: Partial<Task> = {},
): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: id.split("-")[0] as string,
  ...(deps.length ? { deps } : {}),
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});

function plan(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "Weather" },
    groups: [
      { id: "BE", name: "Backend" },
      { id: "FE", name: "Frontend" },
    ],
    seq: { BE: 4, FE: 1 },
    tasks: [
      t("BE-01", "done"),
      t("BE-02", "doing", ["BE-01"]),
      t("BE-03", "todo", ["BE-02"]),
      t("BE-04", "todo", ["BE-01"], {
        desc: "Cache responses.",
        acceptance: [{ id: "ac1", text: "Fast" }],
        notes: [{ id: "n1", at, by: "agent:codex", kind: "question", text: "Which TTL?" }],
      }),
      t("FE-01", "proposed", [], { created: { at, by: "agent:claude" } }),
    ],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-cli-"));
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(doc: TasksDocument = plan()) {
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(join(dir, ".konsora", "tasks.json"), serializeDocument(doc));
}

async function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: options.cwd ?? dir,
    env: options.env ?? {},
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("init", () => {
  it("creates a valid plan, the protocol skill and the konsora server in .mcp.json", async () => {
    const r = await run(["init", "--name", "Weather", "--group", "BE", "--group-name", "Backend"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain('Created .konsora/tasks.json (project "Weather", group BE)');
    const doc = JSON.parse(readFileSync(join(dir, ".konsora", "tasks.json"), "utf8"));
    expect(doc).toEqual({
      schema: "konsora/5",
      project: { name: "Weather" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 0 },
      tasks: [],
    });
    expect(readdirSync(join(dir, ".konsora"))).toEqual(["tasks.json"]);
    expect(existsSync(join(dir, ".claude", "skills", "konsora", "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        konsora: {
          type: "stdio",
          command: "konsora",
          args: ["mcp"],
          env: { KONSORA_AGENT: "claude" },
        },
      },
    });
  });

  it("--no-claude creates only the plan", async () => {
    expect((await run(["init", "--no-claude"])).code).toBe(EXIT.ok);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("refuses to overwrite an existing plan (exit 1, file untouched)", async () => {
    seed();
    const before = readFileSync(join(dir, ".konsora", "tasks.json"), "utf8");
    const r = await run(["init"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toMatch(/^Error: .*already exists.*\nHint: /);
    expect(readFileSync(join(dir, ".konsora", "tasks.json"), "utf8")).toBe(before);
  });

  it("rejects an invalid group id as a usage error", async () => {
    const r = await run(["init", "--group", "core"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain('Invalid group id "core"');
  });

  it("--json prints the created plan; defaults name to the folder", async () => {
    const r = await run(["init", "--json"]);
    expect(r.json()).toMatchObject({
      project: { name: dir.split("/").pop() },
      groups: [{ id: "TASK" }],
    });
  });
});

describe("read commands", () => {
  beforeEach(() => seed());

  it("status shows counts and what needs attention", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Weather · .konsora/tasks.json · 5 tasks in 2 groups");
    expect(r.stdout).toContain("proposed 1   todo 2   doing 1   done 1");
    expect(r.stdout).toContain("ready 1 · blocked 1 · waiting 1");
    expect(r.stdout).toMatch(/Waiting for an answer:\n {2}BE-04/);
    expect(r.stdout).toMatch(/Doing:\n {2}BE-02/);
    expect(r.stdout).toMatch(/Ready to start:\n {2}BE-04/);
    expect(r.stdout).toMatch(/Ideas \(proposed; anyone can promote them to todo\):\n {2}FE-01/);
  });

  it("status --json", async () => {
    expect((await run(["status", "--json"])).json()).toEqual({
      project: { name: "Weather" },
      groups: [
        { id: "BE", name: "Backend" },
        { id: "FE", name: "Frontend" },
      ],
      tasks: 5,
      byState: { proposed: 1, todo: 2, doing: 1, done: 1 },
      ready: ["BE-04"],
      blocked: ["BE-03"],
      waiting: ["BE-04"],
      // The fixture's task in progress is days old for the real clock (CORE-10).
      stale: ["BE-02"],
      proposed: ["FE-01"],
    });
  });

  it("list prints every task in dependency order with flags", async () => {
    const r = await run(["list"]);
    const ids = r.stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(" ")[0]);
    expect(ids.indexOf("BE-01")).toBeLessThan(ids.indexOf("BE-02"));
    expect(ids.indexOf("BE-02")).toBeLessThan(ids.indexOf("BE-03"));
    expect(r.stdout).toContain("BE-03  todo      -       Title BE-03  [blocked by BE-02]");
    expect(r.stdout).toContain("BE-04  todo      -       Title BE-04  [ready; waiting for answer]");
  });

  it("list filters combine; --json returns tasks with derived flags", async () => {
    expect(
      (await run(["list", "--group", "BE", "--state", "todo", "--json"]))
        .json()
        .map((x: Task) => x.id),
    ).toEqual(["BE-03", "BE-04"]);
    const blocked = (await run(["list", "--blocked", "--json"])).json();
    expect(blocked).toEqual([
      expect.objectContaining({ id: "BE-03", blocked: true, blockers: ["BE-02"], ready: false }),
    ]);
    expect((await run(["list", "--state", "done"])).stdout).toContain("BE-01");
  });

  it("ready and blocked are presets", async () => {
    expect((await run(["ready", "--json"])).json().map((x: Task) => x.id)).toEqual(["BE-04"]);
    expect((await run(["blocked"])).stdout).toContain(
      "BE-03  todo      -       Title BE-03  [blocked by BE-02]",
    );
    expect((await run(["ready", "--group", "FE"])).stdout).toBe("No tasks match.\n");
  });

  it("show prints details; ids are case-insensitive", async () => {
    const r = await run(["show", "be-04"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("BE-04 · Title BE-04");
    expect(r.stdout).toContain("state: todo (ready; waiting for answer)   group: BE (Backend)");
    expect(r.stdout).toContain("deps: BE-01 (done)");
    expect(r.stdout).toContain("ac1  Fast\n");
    expect(r.stdout).toContain("agent:codex  question");
    expect((await run(["show", "BE-01"])).stdout).toContain("dependents: BE-02, BE-04");
  });

  it("show --json includes derived flags", async () => {
    expect((await run(["show", "BE-03", "--json"])).json()).toMatchObject({
      id: "BE-03",
      blocked: true,
      blockers: ["BE-02"],
    });
  });

  it("check passes on a valid plan", async () => {
    const r = await run(["check"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^OK · 5 tasks in 2 groups · sha256:/);
    expect((await run(["check", "--json"])).json()).toMatchObject({ ok: true, tasks: 5 });
  });
});

describe("errors and discovery", () => {
  it("check exits 1 and lists every problem with its path", async () => {
    const doc = plan();
    (doc.tasks[2] as Task).deps = ["BE-99"];
    doc.seq.BE = 1;
    seed(doc);
    const r = await run(["check"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("/seq/BE  seq_behind");
    expect(r.stderr).toContain("/tasks/2/deps/0  unknown_dependency");
    expect((await run(["check", "--json"])).json()).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("read commands refuse an invalid plan with a hint", async () => {
    writeFileSync(join(dir, "x"), "");
    mkdirSync(join(dir, ".konsora"));
    writeFileSync(join(dir, ".konsora", "tasks.json"), "{ nope");
    const r = await run(["status"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("invalid_json");
    expect(r.stderr).toContain("Hint: Fix the file");
  });

  it("finds the plan from a subfolder, via --root or KONSORA_ROOT", async () => {
    seed();
    const sub = join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect((await run(["status", "--json"], { cwd: sub })).json().tasks).toBe(5);
    expect((await run(["--root", dir, "status", "--json"], { cwd: tmpdir() })).json().tasks).toBe(
      5,
    );
    expect(
      (await run(["status", "--json"], { cwd: tmpdir(), env: { KONSORA_ROOT: dir } })).json().tasks,
    ).toBe(5);
  });

  it("without a plan: exit 1 with a hint to run init", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.stderr).toContain("No .konsora/ folder found");
    expect(r.stderr).toContain("Hint: Run `konsora init`");
  });

  it("unknown task, unknown group and bad options", async () => {
    seed();
    expect((await run(["show", "BE-42"])).stderr).toContain("Task BE-42 does not exist.");
    const g = await run(["list", "--group", "OPS"]);
    expect([g.code, g.stderr]).toEqual([EXIT.usage, expect.stringContaining("Groups: BE, FE.")]);
    expect((await run(["list", "--state", "pending"])).code).toBe(EXIT.usage);
    expect((await run(["frobnicate"])).code).toBe(EXIT.usage);
  });

  it("--help and --version exit 0", async () => {
    expect((await run(["--help"])).code).toBe(EXIT.ok);
    expect((await run(["--version"])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the real binary", { timeout: SLOW_TIMEOUT }, () => {
  it("runs through Node type stripping and sets the exit code", () => {
    seed();
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const ok = spawnSync(process.execPath, [bin, "ready"], { cwd: dir, encoding: "utf8" });
    expect([ok.status, ok.stdout]).toEqual([0, expect.stringContaining("BE-04")]);
    const bad = spawnSync(process.execPath, [bin, "show", "NOPE-01"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("Error: Task NOPE-01 does not exist.");
  });
});
