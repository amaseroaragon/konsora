import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDocument, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_JSON } from "../src/hooks.ts";
import { EXIT, main } from "../src/main.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: "BE",
  rank: "m",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const started = (by: string) => ({
  events: [{ type: "start" as const, at, by }],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settingsPath = () => join(dir, SETTINGS_JSON);
const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const tasksFile = () => join(dir, ".konsora", "tasks.json");

function seed(tasks: Task[]) {
  const doc: TasksDocument = {
    schema: "konsora/5",
    project: { name: "Weather" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: tasks.length },
    tasks,
  };
  mkdirSync(join(dir, ".konsora"), { recursive: true });
  writeFileSync(tasksFile(), serializeDocument(doc));
}

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
  });
  return { code, stdout, stderr };
}

const commands = (event: string) =>
  settings().hooks[event].flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );

describe("installing the hooks", () => {
  it("init --hooks adds SessionStart and Stop to .claude/settings.json", async () => {
    const r = await run(["init", "--hooks"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain(`Created ${SETTINGS_JSON} with the Konsora hooks`);
    expect(settings()).toEqual({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "konsora hook session-start", timeout: 30 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "konsora hook stop", timeout: 30 }] }],
      },
    });
  });

  it("init without --hooks writes no hook, and --no-claude refuses --hooks", async () => {
    expect((await run(["init"])).code).toBe(EXIT.ok);
    expect(existsSync(settingsPath())).toBe(false);
    const other = await run(["init", "--no-claude", "--hooks", "--root", "sub"]);
    expect(other.code).toBe(EXIT.usage);
    expect(existsSync(join(dir, "sub"))).toBe(false);
  });

  it("skill --hooks merges into existing settings without touching other keys, once", async () => {
    await run(["init", "--no-claude"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const own = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(own));
    const r = await run(["skill", "--hooks", "--no-mcp", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout)).toMatchObject({ hooks: "added" });
    const merged = settings();
    expect(merged.permissions).toEqual(own.permissions);
    expect(merged.hooks.PreToolUse).toEqual(own.hooks.PreToolUse);
    expect(commands("Stop")).toEqual(["say done", "konsora hook stop"]);
    expect(commands("SessionStart")).toEqual(["konsora hook session-start"]);

    const text = readFileSync(settingsPath(), "utf8");
    const again = await run(["skill", "--hooks", "--no-mcp"]);
    expect(again.stdout).toContain(`${SETTINGS_JSON} already has the Konsora hooks.`);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  it("never overwrites an invalid settings file", async () => {
    await run(["init", "--no-claude"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    for (const bad of ["{ not json", "[1]", '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
      writeFileSync(settingsPath(), bad);
      const r = await run(["skill", "--hooks", "--no-mcp"]);
      expect(r.code, bad).toBe(EXIT.failure);
      expect(r.stderr).toContain(`${SETTINGS_JSON} `);
      expect(r.stderr).toContain("left it unchanged");
      expect(readFileSync(settingsPath(), "utf8")).toBe(bad);
    }
  });
});

describe("konsora hook", () => {
  it("session-start prints the plan's status for Claude's context", async () => {
    seed([t("BE-01", "todo", { title: "Add the cache" })]);
    const r = await run(["hook", "session-start"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^This project plans and tracks its work in Konsora/);
    expect(r.stdout).toContain("take work with `konsora next`");
    expect(r.stdout).toContain("Ready to start:\n  BE-01     Add the cache");
  });

  it("finds the project from CLAUDE_PROJECT_DIR, and never fails the session", async () => {
    seed([t("BE-01", "todo")]);
    const elsewhere = mkdtempSync(join(tmpdir(), "konsora-hooks-cwd-"));
    try {
      let out = "";
      const code = await main(["hook", "session-start"], {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
        cwd: elsewhere,
        env: { CLAUDE_PROJECT_DIR: join(dir) },
      });
      expect(code).toBe(EXIT.ok);
      expect(out).toContain("Weather");
      const none = await main(["hook", "session-start"], {
        stdout: (s) => {
          out = s;
        },
        stderr: () => {},
        cwd: elsewhere,
        env: {},
      });
      expect(none).toBe(EXIT.ok);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    writeFileSync(tasksFile(), "{ broken");
    const invalid = await run(["hook", "session-start"]);
    expect(invalid.code).toBe(EXIT.ok);
    expect(invalid.stdout).toContain("is invalid, so it is read-only");
    expect((await run(["hook", "stop"])).stdout).toBe("");
  });

  it("stop blocks once with a reminder when the agent's own task is in progress", async () => {
    seed([
      t("BE-01", "doing", { title: "Mine", ...started("agent:claude") }),
      t("BE-02", "doing", { title: "Theirs", ...started("agent:codex") }),
    ]);
    const r = await run(["hook", "stop"], { stdin: JSON.stringify({ stop_hook_active: false }) });
    expect(r.code).toBe(EXIT.ok);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("Stop");
    expect(out.additionalContext).toContain("BE-01 (Mine) is in progress under your name");
    expect(out.additionalContext).not.toContain("BE-02");
    expect(out.additionalContext).toContain("konsora finish");
    expect(out.additionalContext).toContain("nothing is needed: just end your turn");

    const again = await run(["hook", "stop"], {
      stdin: JSON.stringify({ stop_hook_active: true }),
    });
    expect(again.stdout).toBe("");
    const codex = await run(["hook", "stop"], { env: { KONSORA_AGENT: "codex" }, stdin: "{}" });
    expect(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext).toContain(
      "BE-02 (Theirs)",
    );
  });

  it("stop lets the agent stop with nothing in progress or a question pending", async () => {
    seed([
      t("BE-01", "doing", {
        ...started("agent:claude"),
        notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "Which TTL?" }],
      }),
      t("BE-02", "todo"),
    ]);
    expect((await run(["hook", "stop"], { stdin: "{}" })).stdout).toBe("");
    expect((await run(["hook", "stop"], { stdin: "not json" })).stdout).toBe("");
  });

  it("only reads the plan", async () => {
    seed([t("BE-01", "doing", started("agent:claude"))]);
    const before = readFileSync(tasksFile(), "utf8");
    await run(["hook", "session-start"]);
    await run(["hook", "stop"], { stdin: "{}" });
    expect(readFileSync(tasksFile(), "utf8")).toBe(before);
    expect(existsSync(join(dir, ".konsora", "tasks.json.lock"))).toBe(false);
  });
});
