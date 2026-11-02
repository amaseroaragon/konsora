import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunHandle, RunSpec } from "../src/adapter.ts";
import {
  CODEX_APPROVAL_POLICY,
  CODEX_SANDBOX,
  type CodexAdapterOptions,
  codexDecision,
  codexPermission,
  codexThreadParams,
  createCodexAdapter,
} from "../src/codex/adapter.ts";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url));

let dir: string;
let spec: RunSpec;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "konsora-codex-"));
  spec = {
    prompt: "Do the task.",
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

type Dump = {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  received: Record<string, unknown>[];
};

function adapter(
  name: string,
  env: Record<string, string> = {},
  transport: CodexAdapterOptions["transport"] = "app-server",
) {
  const dumpFile = join(dir, "dump.json");
  return {
    dumpFile,
    adapter: createCodexAdapter({
      command: process.execPath,
      prefixArgs: [fakeCodex],
      env: {
        ...process.env,
        FAKE_CODEX_FIXTURE: fixture(name),
        FAKE_CODEX_SKIP: "model/list",
        FAKE_CODEX_DUMP: dumpFile,
        ...env,
      },
      killGraceMs: 500,
      requestTimeoutMs: 5000,
      transport,
    }),
  };
}

/** Runs the handle to the end; `onEvent` may drive it (send, endInput, interrupt). */
async function collect(
  handle: RunHandle,
  onEvent: (event: RunEvent, handle: RunHandle) => void = (event, h) => {
    if (event.t === "permission") h.answerPermission?.(event.id, { behavior: "allow" });
    if (event.t === "turn_end") h.endInput();
  },
) {
  const events: RunEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    onEvent(event, handle);
  }
  return { events, exit: await handle.exited };
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Dump;

describe("codex app-server recordings (codex-cli 0.166.0)", () => {
  it("normalizes a real two-turn session with commands and approvals", async () => {
    const { adapter: codex, dumpFile } = adapter("success");
    const handle = codex.start(spec);
    let turns = 0;
    const { events, exit } = await collect(handle, (event, h) => {
      if (event.t === "permission") {
        // As in the recording: the file commands are allowed, the network one is not.
        const allow = !event.detail.startsWith("curl");
        h.answerPermission?.(event.id, allow ? { behavior: "allow" } : { behavior: "deny" });
      }
      if (event.t !== "turn_end") return;
      if (++turns === 1) h.send("Reply with just the word: done");
      else h.endInput();
    });
    expect(exit).toEqual({ code: 0, signal: null });
    expect(handle.sessionId()).toBe("01a19774-906d-7483-8718-645c81a1df62");
    const final =
      "I read `notes.txt` (“hello”), created `hello.txt` with `hi`, and added `bye` to `notes.txt`; the curl request was rejected.";
    const permission = (id: string, command: string) => ({
      t: "permission",
      id,
      tool: "shell",
      detail: command,
      input: expect.objectContaining({ command, cwd: dir, reason: expect.any(String) }),
    });
    const python =
      "python3 -c \"from pathlib import Path; Path('hello.txt').write_text('hi'); p=Path('notes.txt'); p.write_text(p.read_text()+'\\nbye')\"";
    expect(events).toEqual([
      // configWarning arrives before the thread exists.
      {
        t: "error",
        message:
          "Codex warning: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
        retryable: false,
      },
      {
        t: "started",
        session: "01a19774-906d-7483-8718-645c81a1df62",
        model: "gpt-6-luna",
        transport: "app-server",
      },
      {
        t: "message",
        text: "I’ll read the note, make the two file changes, then run the requested network command.",
        final: false,
      },
      {
        t: "usage",
        rate_limits: {
          status: "allowed",
          windows: [
            { window: "five_hour", status: "allowed", utilization: 0.01, resets_at: 1793547209 },
            { window: "seven_day", status: "allowed", utilization: 0.42, resets_at: 1793827780 },
          ],
        },
      },
      {
        t: "tool",
        phase: "start",
        id: "exec-c856d8fe-db4e-47a0-b6e7-08fe685e96ed",
        name: "shell",
        summary: "cat notes.txt",
      },
      permission("codex-1", "cat notes.txt"),
      {
        t: "tool",
        phase: "end",
        id: "exec-c856d8fe-db4e-47a0-b6e7-08fe685e96ed",
        name: "shell",
        summary: "hello",
        ok: true,
      },
      expect.objectContaining({ t: "tool", phase: "start", name: "shell", summary: python }),
      permission("codex-2", python),
      expect.objectContaining({
        t: "tool",
        phase: "end",
        name: "shell",
        summary: "exit 0",
        ok: true,
      }),
      expect.objectContaining({
        t: "tool",
        phase: "start",
        summary: "curl -sI https://example.com",
      }),
      permission("codex-3", "curl -sI https://example.com"),
      expect.objectContaining({ t: "tool", phase: "end", summary: "declined", ok: false }),
      { t: "message", text: final, final: true },
      expect.objectContaining({ t: "usage", input_tokens: expect.any(Number) }),
      { t: "turn_end", ok: true },
      { t: "message", text: "done", final: true },
      expect.objectContaining({ t: "usage", input_tokens: expect.any(Number) }),
      { t: "turn_end", ok: true },
      { t: "finished", ok: true, summary: "done" },
    ]);
    // The human's decisions went back as the replies to Codex's requests.
    const replies = read(dumpFile).received.filter((m) => m.method === undefined && "result" in m);
    expect(replies.map((m) => m.result)).toEqual([
      { decision: "accept" },
      { decision: "accept" },
      { decision: "decline" },
    ]);
  });

  it("splits the thread's usage by turn, with the cache and reasoning apart", async () => {
    const { adapter: codex } = adapter("success");
    let turns = 0;
    const { events } = await collect(codex.start(spec), (event, h) => {
      if (event.t === "permission") h.answerPermission?.(event.id, { behavior: "allow" });
      if (event.t !== "turn_end") return;
      if (++turns === 1) h.send("again");
      else h.endInput();
    });
    const usage = events.filter((e) => e.t === "usage" && e.input_tokens !== undefined);
    const lines = readFileSync(fixture("success"), "utf8").split("\n").filter(Boolean);
    const totals = lines
      .map((l) => JSON.parse(l).s)
      .filter((m) => m?.method === "thread/tokenUsage/updated")
      .map((m) => m.params.tokenUsage.total);
    // The thread's totals when the first turn completed, and at the end.
    let turnOne: Record<string, number> = {};
    for (const message of lines.map((l) => JSON.parse(l).s)) {
      if (message?.method === "thread/tokenUsage/updated")
        turnOne = message.params.tokenUsage.total;
      if (message?.method === "turn/completed") break;
    }
    const last = totals.at(-1);
    expect(usage).toHaveLength(2);
    const [first, second] = usage as Extract<RunEvent, { t: "usage" }>[];
    expect(first?.input_tokens).toBe(turnOne.inputTokens);
    expect((first?.input_tokens ?? 0) + (second?.input_tokens ?? 0)).toBe(last.inputTokens);
    expect((first?.cache_read_tokens ?? 0) + (second?.cache_read_tokens ?? 0)).toBe(
      last.cachedInputTokens,
    );
    expect((first?.output_tokens ?? 0) + (second?.output_tokens ?? 0)).toBe(last.outputTokens);
    expect((first?.reasoning_tokens ?? 0) + (second?.reasoning_tokens ?? 0)).toBe(
      last.reasoningOutputTokens,
    );
    expect(first?.cost_usd).toBeUndefined();
  });

  it("reports apply_patch changes as files relative to the worktree", async () => {
    const { adapter: codex } = adapter("patch");
    const { events } = await collect(codex.start(spec));
    expect(events.filter((e) => e.t === "file")).toEqual([
      { t: "file", path: "a.txt", change: "add" },
      { t: "file", path: "notes.txt", change: "modify" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool",
        phase: "start",
        name: "apply_patch",
        summary: "a.txt, notes.txt",
      }),
    );
    expect(events).toContainEqual({
      t: "permission",
      id: "codex-1",
      tool: "apply_patch",
      detail: "a.txt, notes.txt",
      input: {
        path: "a.txt",
        paths: ["a.txt", "notes.txt"],
        reason: "command failed; retry without sandbox?",
      },
    });
    expect(events.at(-1)).toEqual({
      t: "finished",
      ok: true,
      summary: "Created `a.txt` with `a` and changed `hello` to `hello world` in `notes.txt`.",
    });
  });

  it("interrupts the turn with turn/interrupt", async () => {
    const { adapter: codex, dumpFile } = adapter("interrupt");
    const handle = codex.start(spec);
    const { events } = await collect(handle, (event, h) => {
      if (event.t === "started") setTimeout(() => void h.interrupt(), 100);
      if (event.t === "turn_end") h.endInput();
    });
    const interrupt = read(dumpFile).received.find((m) => m.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({
      threadId: "01a19779-21bc-7dd2-af70-ffbeeac67243",
      turnId: "01a19779-2221-7241-8341-22343d817cd5",
    });
    expect(events.slice(-2)).toEqual([
      { t: "turn_end", ok: false },
      { t: "finished", ok: false },
    ]);
  });

  it("reports a failed turn once (unknown model)", async () => {
    const { adapter: codex } = adapter("error");
    const { events } = await collect(
      codex.start({ ...spec, agent: { ...spec.agent, model: "gpt-nonexistent-9" } }),
    );
    const message =
      "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account.";
    expect(events.filter((e) => e.t === "error" && e.message === message)).toHaveLength(1);
    expect(events.slice(-2)).toEqual([
      { t: "turn_end", ok: false },
      { t: "finished", ok: false },
    ]);
  });
});

describe("what Konsora sends to codex", () => {
  it("uses the sandbox and approvals of the default profile, never a bypass", async () => {
    const { adapter: codex, dumpFile } = adapter("patch", {
      KONSORA_DAEMON_TOKEN: "human-token",
      KONSORA_TOKEN: "human-token-2",
      KONSORA_RUN_TOKEN: "leaked-run-token",
    });
    await collect(codex.start(spec));
    const seen = read(dumpFile);
    expect(seen.args).toEqual(["app-server"]);
    expect(seen.cwd).toBe(dir);
    const byMethod = (method: string) => seen.received.find((m) => m.method === method);
    expect(byMethod("initialize")?.params).toMatchObject({ clientInfo: { name: "konsora" } });
    expect(byMethod("thread/start")?.params).toEqual({
      model: "gpt-6-luna",
      cwd: dir,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      config: { mcp_servers: { konsora: spec.mcp } },
    });
    expect(byMethod("turn/start")?.params).toMatchObject({
      input: [{ type: "text", text: "Do the task.", text_elements: [] }],
      effort: "low",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    const sent = JSON.stringify(seen.received) + JSON.stringify(seen.args);
    expect(sent).not.toMatch(/danger|bypass|"never"/i);
    // The run's variables reach the MCP server through config only, never the child's env.
    expect(Object.keys(seen.env).filter((k) => k.startsWith("KONSORA_"))).toEqual([]);
    expect(JSON.stringify(seen.env)).not.toMatch(/human-token|run-token/);
  });

  it("opens the run's git paths in the sandbox so the agent can commit on its branch", async () => {
    const { adapter: codex, dumpFile } = adapter("patch");
    const gitWritePaths = ["/repo/.git/worktrees/BE-01-x", "/repo/.git/objects"];
    await collect(codex.start({ ...spec, gitWritePaths }));
    const turn = read(dumpFile).received.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", writableRoots: gitWritePaths, networkAccess: false },
    });
  });

  it("resumes the saved thread with the same safety parameters", () => {
    const resumed = codexThreadParams({ ...spec, resume: "01a19774-906d-7483-8718-645c81a1df62" });
    expect(resumed).toEqual({
      method: "thread/resume",
      params: {
        threadId: "01a19774-906d-7483-8718-645c81a1df62",
        model: "gpt-6-luna",
        cwd: dir,
        sandbox: CODEX_SANDBOX,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        config: { mcp_servers: { konsora: spec.mcp } },
      },
    });
  });

  it("refuses profiles it does not implement", async () => {
    const { adapter: codex } = adapter("patch");
    const { events } = await collect(
      codex.start({ ...spec, agent: { ...spec.agent, permissions: "trusted" } }),
    );
    expect(events).toEqual([
      {
        t: "error",
        message: 'Permission profile "trusted" is not available for Codex yet; use "default"',
        retryable: false,
      },
      { t: "finished", ok: false },
    ]);
  });
});

describe("approval replies", () => {
  it("uses each method's decision format", () => {
    const v2 = "item/commandExecution/requestApproval";
    expect(codexDecision(v2, { behavior: "allow" })).toEqual({ decision: "accept" });
    expect(codexDecision("item/fileChange/requestApproval", { behavior: "deny" })).toEqual({
      decision: "decline",
    });
    expect(codexDecision("execCommandApproval", { behavior: "allow" })).toEqual({
      decision: "approved",
    });
    expect(codexDecision("applyPatchApproval", { behavior: "deny", message: "No." })).toEqual({
      decision: { denied: { rejection: "No." } },
    });
  });

  it("shows the legacy requests' command and files", () => {
    expect(
      codexPermission("execCommandApproval", { command: ["git", "push"], cwd: "/w" }, () => []),
    ).toEqual({ tool: "shell", detail: "git push", input: { command: "git push", cwd: "/w" } });
    expect(
      codexPermission(
        "applyPatchApproval",
        { callId: "c1", fileChanges: { "/w/a.ts": {} } },
        () => [],
      ),
    ).toEqual({
      tool: "apply_patch",
      detail: "/w/a.ts",
      input: { path: "/w/a.ts", paths: ["/w/a.ts"] },
    });
  });
});

describe("models()", () => {
  it("lists the visible models with the efforts from model/list", async () => {
    const { adapter: codex } = adapter("models", { FAKE_CODEX_SKIP: "" });
    const models = await codex.models();
    expect(models.map((m) => m.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(models[0]).toEqual({
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(models.find((m) => m.id === "gpt-6-luna")?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("fails with an actionable error when codex is missing", async () => {
    const codex = createCodexAdapter({ command: "/nonexistent/codex" });
    await expect(codex.models()).rejects.toThrow(/Could not list Codex models/);
  });
});

describe("failures", () => {
  const onlyOneFinished = (events: RunEvent[]) => {
    expect(events.filter((e) => e.t === "finished")).toEqual([
      expect.objectContaining({ t: "finished", ok: false }),
    ]);
    expect(events.at(-1)?.t).toBe("finished");
  };

  it("reports a malformed line and ends not ok", async () => {
    const { adapter: codex } = adapter("patch", { FAKE_CODEX_MODE: "malformed" });
    const { events } = await collect(codex.start(spec));
    expect(events).toContainEqual({
      t: "error",
      message: "Codex wrote a line that is not a JSON object",
      retryable: false,
    });
    onlyOneFinished(events);
  });

  it("reports a process that dies, with its stderr", async () => {
    const { adapter: codex } = adapter("patch", { FAKE_CODEX_MODE: "die" });
    const { events, exit } = await collect(codex.start(spec));
    expect(exit).toEqual({ code: 3, signal: null });
    expect(events).toContainEqual({
      t: "error",
      message: "Codex exited with code 3: ERROR fake codex crashed",
      retryable: false,
    });
    onlyOneFinished(events);
  });

  it("reports a rejected thread/start and closes the session", async () => {
    const { adapter: codex } = adapter("patch", { FAKE_CODEX_MODE: "reject" });
    const { events } = await collect(codex.start(spec));
    expect(events).toContainEqual({
      t: "error",
      message: "Codex could not start the session: thread/start rejected",
      retryable: false,
    });
    onlyOneFinished(events);
  });

  it("reports a missing executable", async () => {
    const codex = createCodexAdapter({ command: "/nonexistent/codex" });
    const { events } = await collect(codex.start(spec));
    expect(events).toContainEqual({
      t: "error",
      message: "Codex is not installed or not on PATH",
      retryable: false,
    });
    onlyOneFinished(events);
  });

  it("kill() stops a session that waits for an approval, and a late answer is ignored", async () => {
    const { adapter: codex, dumpFile } = adapter("patch");
    const handle = codex.start(spec);
    let permission = "";
    const { events, exit } = await collect(handle, (event, h) => {
      if (event.t === "permission") {
        permission = event.id;
        void h.kill(); // nobody answers
      }
    });
    expect(exit.signal).toBe("SIGTERM");
    onlyOneFinished(events);
    handle.answerPermission?.(permission, { behavior: "allow" });
    expect(read(dumpFile).received.filter((m) => m.method === undefined)).toEqual([]);
  });
});
