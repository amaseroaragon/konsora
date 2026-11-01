import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunHandle, RunSpec } from "../src/adapter.ts";
import {
  ClaudeNormalizer,
  claudeAllowedTools,
  claudeArgs,
  claudeEnv,
  createClaudeAdapter,
  MCP_CONFIG_FILE,
} from "../src/claude.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url));
const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));

function normalize(
  name: string,
  exit: { code: number | null; signal: string | null },
  stderr = "",
) {
  const normalizer = new ClaudeNormalizer("/work/repo");
  const events: RunEvent[] = [];
  for (const line of readFileSync(fixture(name), "utf8").split("\n")) {
    events.push(...normalizer.push(line));
  }
  events.push(...normalizer.end(exit, stderr));
  return { events, session: normalizer.session };
}

let dir: string;
let spec: RunSpec;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-claude-"));
  spec = {
    prompt: "Do the task.",
    cwd: dir,
    agent: { provider: "claude", model: "sonnet", effort: "high", permissions: "default" },
    checks: [
      { id: "test", run: "npm test" },
      { id: "odd", run: "make a,b" },
    ],
    mcp: {
      command: "/usr/bin/node",
      args: ["/opt/konsora/bin.ts", "mcp", "--root", "/home/me/project"],
      env: {
        KONSORA_PROJECT: "/home/me/project",
        KONSORA_RUN: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
        KONSORA_TASK: "BE-02",
        KONSORA_DAEMON_URL: "http://127.0.0.1:4567",
        KONSORA_RUN_TOKEN: "run-token-123",
      },
    },
    privateDir: join(dir, "private"),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recorded stream-json (Claude Code 2.1.316)", () => {
  it("normalizes a real successful session", () => {
    const { events, session } = normalize("success", { code: 0, signal: null });
    expect(session).toBe("5aea2c44-e4de-448c-968f-dd5686d42629");
    const final =
      "All five steps are done, but `ls -la /` was blocked by the sandbox, which only allows listing the working directory, so I didn't get the root listing.";
    expect(events).toEqual([
      { t: "started", session: "5aea2c44-e4de-448c-968f-dd5686d42629", model: "claude-haiku-5-5" },
      {
        t: "tool",
        phase: "start",
        id: "toolu_01VMyyzoUZqbJkm59SVuTLy7",
        name: "Read",
        summary: "notes.txt",
      },
      {
        t: "usage",
        rate_limits: { status: "allowed", window: "five_hour", resets_at: 1793539200 },
      },
      {
        t: "tool",
        phase: "end",
        id: "toolu_01VMyyzoUZqbJkm59SVuTLy7",
        name: "Read",
        summary: "1 hello 2",
        ok: true,
      },
      {
        t: "tool",
        phase: "start",
        id: "toolu_01L7rwauBg86UShTwDFMxdMV",
        name: "Write",
        summary: "greeting.txt",
      },
      expect.objectContaining({ t: "tool", phase: "end", name: "Write", ok: true }),
      { t: "file", path: "greeting.txt", change: "add" },
      {
        t: "tool",
        phase: "start",
        id: "toolu_01K1e3YTUYV4sWTjBJXgfudH",
        name: "Edit",
        summary: "notes.txt",
      },
      expect.objectContaining({ t: "tool", phase: "end", name: "Edit", ok: true }),
      { t: "file", path: "notes.txt", change: "modify" },
      {
        t: "tool",
        phase: "start",
        id: "toolu_018s2FmKGtgfwYPZmLSwDTXJ",
        name: "Bash",
        summary: "Show short git status",
      },
      {
        t: "tool",
        phase: "end",
        id: "toolu_018s2FmKGtgfwYPZmLSwDTXJ",
        name: "Bash",
        summary: "M notes.txt ?? greeting.txt ?? in.jsonl",
        ok: true,
      },
      {
        t: "tool",
        phase: "start",
        id: "toolu_01CagErJ2V1PAysWe2a3FkRP",
        name: "Bash",
        summary: "List root directory contents",
      },
      expect.objectContaining({
        t: "tool",
        phase: "end",
        id: "toolu_01CagErJ2V1PAysWe2a3FkRP",
        ok: false,
      }),
      { t: "message", text: final, final: true },
      { t: "usage", input_tokens: 80772, output_tokens: 765, cost_usd: 0.00514598 },
      { t: "turn_end", ok: true },
      { t: "finished", ok: true, summary: final },
    ]);
  });

  it("normalizes a real failed session (unknown model)", () => {
    const { events } = normalize(
      "error",
      { code: 1, signal: null },
      "[claude-code:unrecognized_model]\n",
    );
    const apiError =
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
    expect(events).toEqual([
      {
        t: "started",
        session: "1a7ccbcc-d292-4788-885a-497b1055b1f2",
        model: "claude-nonexistent-9",
      },
      { t: "error", message: apiError, retryable: false },
      { t: "usage", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { t: "turn_end", ok: false },
      {
        t: "error",
        message: "Claude Code exited with code 1: [claude-code:unrecognized_model]",
        retryable: false,
      },
      { t: "finished", ok: false, summary: apiError },
    ]);
  });

  it("reports malformed lines and still finishes, never throwing", () => {
    const normalizer = new ClaudeNormalizer("/work/repo");
    const events = [
      ...normalizer.push("not json"),
      ...normalizer.push("[1,2]"),
      ...normalizer.push('{"type":"assistant","message":{"content":"oops"}}'),
      ...normalizer.push('{"type":"user","message":null}'),
      ...normalizer.push('{"type":"result","subtype":"success","is_error":false,"result":"ok"}'),
      ...normalizer.end({ code: 0, signal: null }),
    ];
    expect(events.filter((e) => e.t === "error")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ t: "finished", ok: false, summary: "ok" });
  });
});

describe("arguments and environment", () => {
  it("never uses --dangerously-* or --bare, and always routes approvals to Konsora", () => {
    const args = claudeArgs({ ...spec, resume: "s-1" }, "/private/claude-mcp.json");
    for (const arg of args) {
      expect(arg).not.toMatch(/^--dangerously|^--bare$|bypassPermissions|^--allow-dangerously/);
    }
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ]);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--permission-prompt-tool")).toBe("mcp__konsora__permission");
    expect(flag("--permission-mode")).toBe("acceptEdits");
    expect(flag("--model")).toBe("sonnet");
    expect(flag("--effort")).toBe("high");
    expect(flag("--mcp-config")).toBe("/private/claude-mcp.json");
    expect(flag("--resume")).toBe("s-1");
    expect(args).toContain("--strict-mcp-config");
    const tools = (flag("--allowedTools") as string).split(",");
    expect(tools).toContain("mcp__konsora");
    expect(tools).toContain("Bash(npm test)");
    expect(tools).toContain("Bash(git commit:*)");
    expect(tools.some((t) => t.includes("make a"))).toBe(false);
    expect(tools).not.toContain("Bash");
  });

  it("rejects other permission profiles and option-like values", () => {
    expect(() => claudeAllowedTools({ agent: { ...spec.agent, permissions: "trusted" } })).toThrow(
      /not available for Claude yet/,
    );
    expect(() => claudeArgs({ ...spec, agent: { ...spec.agent, model: "--bare" } }, "/x")).toThrow(
      /Invalid model/,
    );
  });

  it("strips every KONSORA_* variable from the child's environment", () => {
    const env = claudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      KONSORA_DAEMON_TOKEN: "human-token",
      KONSORA_TOKEN: "human-token-2",
      KONSORA_RUN_TOKEN: "run-token",
      KONSORA_ROOT: "/x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
  });
});

describe("the adapter with a fake claude", () => {
  const adapter = (mode: string, extra: Record<string, string> = {}, killGraceMs?: number) =>
    createClaudeAdapter({
      command: process.execPath,
      prefixArgs: [fakeClaude],
      env: {
        ...process.env,
        FAKE_CLAUDE_MODE: mode,
        KONSORA_DAEMON_TOKEN: "human-token",
        KONSORA_TOKEN: "human-token-2",
        ...extra,
      },
      ...(killGraceMs !== undefined ? { killGraceMs } : {}),
    });

  async function collect(handle: RunHandle): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    return events;
  }

  it("runs claude with the private MCP config and a clean environment", async () => {
    const dump = join(dir, "dump.json");
    const raw: string[] = [];
    const handle = adapter("replay", {
      FAKE_CLAUDE_DUMP: dump,
      FAKE_CLAUDE_FIXTURE: fixture("success"),
    }).start(spec, { raw: (line) => raw.push(line) });
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ t: "finished", ok: true });
    expect(raw).toHaveLength(21);
    expect(handle.sessionId()).toBe("5aea2c44-e4de-448c-968f-dd5686d42629");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.args).toContain("--permission-prompt-tool");
    expect(seen.args.join(" ")).not.toMatch(/--dangerously|--bare/);
    expect(seen.cwd).toBe(dir);
    expect(Object.keys(seen.env).filter((k) => k.startsWith("KONSORA_"))).toEqual([]);
    expect(JSON.stringify(seen.env)).not.toContain("human-token");
    // The run's MCP variables only travel in the config file, which is private and removed.
    expect(seen.config.mcpServers.konsora.env.KONSORA_RUN_TOKEN).toBe("run-token-123");
    expect(seen.configMode).toBe(0o600);
    expect(statSync(spec.privateDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(spec.privateDir, MCP_CONFIG_FILE))).toBe(false);
  });

  it("keeps stdin open for more messages until endInput", async () => {
    const handle = adapter("echo").start(spec);
    const events: RunEvent[] = [];
    let sent = false;
    for await (const event of handle.events) {
      events.push(event);
      if (event.t === "turn_end" && !sent) {
        sent = true;
        handle.send("the answer");
      } else if (event.t === "turn_end") {
        handle.endInput();
      }
    }
    const messages = events.filter((e) => e.t === "message");
    expect(messages).toEqual([
      { t: "message", text: "got: Do the task.", final: true },
      { t: "message", text: "got: the answer", final: true },
    ]);
    expect(events.at(-1)).toEqual({ t: "finished", ok: true, summary: "turn 2" });
    expect(await handle.exited).toEqual({ code: 0, signal: null });
  });

  it.each([
    ["malformed output", "garbage", /not a JSON object/],
    ["a process that dies", "die", /stopped by SIGKILL/],
    ["a process that exits with an error", "crash", /exited with code 3: Error: bad things/],
  ])("turns %s into an error and finished with ok false", async (_, mode, message) => {
    const events = await collect(adapter(mode).start(spec));
    expect(events.some((e) => e.t === "error" && message.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ t: "finished", ok: false });
    expect(events.filter((e) => e.t === "finished")).toHaveLength(1);
  });

  it("reports a missing claude binary without throwing", async () => {
    const handle = createClaudeAdapter({ command: join(dir, "no-such-claude") }).start(spec);
    const events = await collect(handle);
    expect(events).toEqual([
      { t: "error", message: "Claude Code is not installed or not on PATH", retryable: false },
      { t: "finished", ok: false },
    ]);
  });

  it("kill() escalates to SIGKILL when SIGTERM is ignored", async () => {
    const handle = adapter("stubborn", {}, 300).start(spec);
    const events = collect(handle);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.kill();
    expect(await handle.exited).toEqual({ code: null, signal: "SIGKILL" });
    expect((await events).at(-1)).toMatchObject({ t: "finished", ok: false });
  });

  it("detects the installed version", async () => {
    expect(await adapter("replay").detect()).toEqual({
      installed: true,
      version: "2.1.316",
      authenticated: "unknown",
    });
    expect(await createClaudeAdapter({ command: join(dir, "nope") }).detect()).toEqual({
      installed: false,
    });
  });
});
