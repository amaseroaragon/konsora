import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunHandle, RunSpec } from "../src/adapter.ts";
import { createCodexAdapter } from "../src/codex/adapter.ts";
import { CodexExecNormalizer, codexExecArgs } from "../src/codex/exec.ts";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url));

let dir: string;
let spec: RunSpec;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-codex-exec-"));
  spec = {
    prompt: "Do the task.\nIt is private.",
    cwd: dir,
    agent: { provider: "codex", model: "gpt-6-luna", effort: "low", permissions: "default" },
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

function normalize(name: string, exit = { code: 0, signal: null }) {
  const normalizer = new CodexExecNormalizer("/work/repo", "gpt-6-luna");
  const events: RunEvent[] = [];
  for (const line of readFileSync(fixture(name), "utf8").split("\n")) {
    events.push(...normalizer.push(line));
  }
  events.push(...normalizer.end(exit));
  return events;
}

describe("codex exec --json recordings (codex-cli 0.166.0)", () => {
  it("normalizes a real session with a command, a patch and a blocked network call", () => {
    const final =
      "`notes.txt` contains `hello`; `a.txt` now contains `a`, and the single curl request failed with exit code 6.";
    expect(normalize("exec-success")).toEqual([
      {
        t: "started",
        session: "01a19791-7d3b-7683-8a4b-57858917212a",
        model: "gpt-6-luna",
        transport: "exec",
      },
      {
        t: "message",
        text: "I’ll read `notes.txt`, create `a.txt` with the requested line, then make the single curl request.",
        final: false,
      },
      { t: "tool", phase: "start", id: "item_1", name: "shell", summary: "cat notes.txt" },
      { t: "tool", phase: "end", id: "item_1", name: "shell", summary: "hello", ok: true },
      { t: "tool", phase: "start", id: "item_2", name: "apply_patch", summary: "a.txt" },
      { t: "tool", phase: "end", id: "item_2", name: "apply_patch", summary: "a.txt", ok: true },
      { t: "file", path: "a.txt", change: "add" },
      {
        t: "tool",
        phase: "start",
        id: "item_3",
        name: "shell",
        summary: "curl -sI https://example.com",
      },
      // No approval in exec: what the sandbox does not allow just fails.
      { t: "tool", phase: "end", id: "item_3", name: "shell", summary: "exit 6", ok: false },
      { t: "message", text: final, final: true },
      {
        t: "usage",
        input_tokens: 77849,
        output_tokens: 197,
        cache_read_tokens: 65792,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
      { t: "turn_end", ok: true },
      { t: "finished", ok: true, summary: final },
    ]);
  });

  it("normalizes a resumed session", () => {
    const events = normalize("exec-resume");
    expect(events.at(0)).toMatchObject({
      t: "started",
      session: "01a19791-7d3b-7683-8a4b-57858917212a",
    });
    expect(events.slice(-4)).toEqual([
      { t: "message", text: "done", final: true },
      expect.objectContaining({ t: "usage", input_tokens: 97476, cache_read_tokens: 85248 }),
      { t: "turn_end", ok: true },
      { t: "finished", ok: true, summary: "done" },
    ]);
  });

  it("reports a failed turn once (unknown model) and ends not ok", () => {
    const events = normalize("exec-error", { code: 1, signal: null });
    const message =
      "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account.";
    expect(events.filter((e) => e.t === "error" && e.message === message)).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "error",
        message: expect.stringMatching(/^Codex warning: Model metadata/),
      }),
    );
    expect(events.slice(-2)).toEqual([
      { t: "turn_end", ok: false },
      { t: "finished", ok: false },
    ]);
  });
});

describe("codexExecArgs", () => {
  it("runs in the worktree with workspace-write and the run's MCP, never a bypass", () => {
    const args = codexExecArgs(spec);
    expect(args.slice(0, 8)).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-6-luna",
      "-s",
      "workspace-write",
      "-C",
      dir,
    ]);
    expect(args.at(-1)).toBe("-"); // the prompt comes from stdin
    expect(args).toContain('mcp_servers.konsora.command="/usr/bin/node"');
    expect(args).toContain(
      'mcp_servers.konsora.args=["/opt/konsora/bin.ts", "mcp", "--root", "/home/me/project"]',
    );
    expect(args).toContain('model_reasoning_effort="low"');
    const env = args.find((a) => a.startsWith("mcp_servers.konsora.env="));
    expect(env).toContain('"KONSORA_RUN" = "r-01JC8Z3K2QX7M4V9T0B6N5R8PW"');
    const all = args.join(" ");
    // argv is visible to other local users: no token, no daemon URL, no prompt.
    expect(all).not.toMatch(/run-token|KONSORA_RUN_TOKEN|KONSORA_DAEMON_URL|private/);
    expect(all).not.toMatch(/danger|bypass|approve-for-me/);
  });

  it("resumes with exec resume and the sandbox through config", () => {
    const args = codexExecArgs({ ...spec, resume: "01a19791-7d3b-7683-8a4b-57858917212a" });
    expect(args.slice(0, 7)).toEqual([
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-6-luna",
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
    expect(args.slice(-2)).toEqual(["01a19791-7d3b-7683-8a4b-57858917212a", "-"]);
  });

  it("keeps the network off and opens the run's git paths, also when resuming", () => {
    expect(codexExecArgs(spec)).toContain("sandbox_workspace_write.network_access=false");
    expect(codexExecArgs(spec).join(" ")).not.toContain("writable_roots");
    const gitWritePaths = ["/repo/.git/worktrees/BE-01-x", "/repo/.git/objects"];
    for (const resume of [undefined, "01a19791-7d3b-7683-8a4b-57858917212a"]) {
      const args = codexExecArgs({ ...spec, gitWritePaths, ...(resume ? { resume } : {}) });
      expect(args).toContain(
        'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/BE-01-x", "/repo/.git/objects"]',
      );
      expect(args).toContain("sandbox_workspace_write.network_access=false");
    }
  });
});

type ExecDump = { args: string[]; env: Record<string, string>; cwd: string; stdin: string };

function fallbackAdapter(mode: string, extra: Record<string, string> = {}) {
  const dumpFile = join(dir, "exec-dump.json");
  return {
    dumpFile,
    adapter: createCodexAdapter({
      command: process.execPath,
      prefixArgs: [fakeCodex],
      env: {
        ...process.env,
        FAKE_CODEX_MODE: mode,
        FAKE_CODEX_EXEC_FIXTURE: fixture("exec-success"),
        FAKE_CODEX_EXEC_DUMP: dumpFile,
        KONSORA_DAEMON_TOKEN: "human-token",
        ...extra,
      },
      killGraceMs: 500,
      requestTimeoutMs: 3000,
    }),
  };
}

async function drain(handle: RunHandle) {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return { events, exit: await handle.exited };
}

describe("choosing exec", () => {
  it.each([
    ["missing", "no-app-server", /exited with code 2/],
    ["incompatible", "incompatible", /does not match the protocol types/],
  ])("falls back to exec when app-server is %s", async (_, mode, reason) => {
    const { adapter, dumpFile } = fallbackAdapter(mode);
    const found = await adapter.detect();
    expect(found).toMatchObject({ installed: true, transport: "exec" });
    expect(found.warning).toMatch(reason);
    expect(found.warning).toContain("without approvals or rate limits");

    const handle = adapter.start(spec);
    const { events, exit } = await drain(handle);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(handle.acceptsInput).toBe(false);
    expect(events[0]).toMatchObject({ t: "started", transport: "exec" });
    expect(events.at(-1)).toMatchObject({ t: "finished", ok: true });
    const seen = JSON.parse(readFileSync(dumpFile, "utf8")) as ExecDump;
    expect(seen.args[0]).toBe("exec");
    expect(seen.stdin).toBe(spec.prompt);
    expect(Object.keys(seen.env).filter((k) => k.startsWith("KONSORA_"))).toEqual([]);
  });

  it("keeps app-server when it answers initialize as expected", async () => {
    const { adapter } = fallbackAdapter("replay", { FAKE_CODEX_FIXTURE: fixture("models") });
    expect(await adapter.detect()).toMatchObject({ installed: true, transport: "app-server" });
  });

  it("reports a malformed line and a failed exit with one finished", async () => {
    const { adapter } = fallbackAdapter("exec-malformed", { FAKE_CODEX_EXEC_EXIT: "1" });
    const { events } = await drain(adapter.start(spec));
    expect(events).toContainEqual({
      t: "error",
      message: "Codex wrote a line that is not a JSON event",
      retryable: false,
    });
    expect(events.filter((e) => e.t === "finished")).toEqual([
      expect.objectContaining({ t: "finished", ok: false }),
    ]);
  });
});
