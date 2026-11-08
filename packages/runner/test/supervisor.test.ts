import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Op, Task, TasksDocument } from "@konsora/core";
import { initTasks, mutate, readTasks } from "@konsora/core/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentAdapter,
  EventQueue,
  type PermissionDecision,
  type RunEvent,
  type RunExit,
  type RunHandle,
  type RunSpec,
} from "../src/adapter.ts";
import { createClaudeAdapter } from "../src/claude.ts";
import { createCodexAdapter } from "../src/codex/adapter.ts";
import { gitEnv } from "../src/git.ts";
import { integrateRun } from "../src/integrate.ts";
import { RunStore } from "../src/run-store.ts";
import {
  RunError,
  type RunRegistry,
  type SupervisorOptions,
  startRebaseRun,
  startRun,
} from "../src/supervisor.ts";

const cliBin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const at = "2026-11-02T10:00:00Z";
let root: string;
let data: string;
let store: RunStore;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();

/** What the agent does through Konsora's MCP in run mode; the CLI applies the same rules. */
function konsora(spec: RunSpec, ...args: string[]): string {
  return execFileSync(process.execPath, [cliBin, ...args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.mcp.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type Script = (spec: RunSpec, emit: (event: RunEvent) => void) => Promise<void> | void;

/**
 * A fake agent: runs `script` as its first turn, then ends the turn and waits for the runner to
 * close its input (or for `send`, which runs `onMessage` as another turn).
 */
function fakeAdapter(
  script: Script,
  options: { exit?: RunExit; onMessage?: Script; seen?: RunSpec[]; handles?: RunHandle[] } = {},
): AgentAdapter {
  return {
    id: "claude",
    detect: async () => ({ installed: true, version: "0.0.0" }),
    models: async () => [],
    start(spec, io) {
      options.seen?.push(spec);
      const queue = new EventQueue<RunEvent>();
      const emit = (event: RunEvent) => {
        io?.raw?.(JSON.stringify({ fake: event.t }));
        queue.push(event);
      };
      let resolveExit: (exit: RunExit) => void = () => undefined;
      const exited = new Promise<RunExit>((resolve) => {
        resolveExit = resolve;
      });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        const exit = options.exit ?? { code: 0, signal: null };
        emit({ t: "finished", ok: exit.code === 0 });
        queue.close();
        resolveExit(exit);
      };
      void (async () => {
        await script(spec, emit);
        emit({ t: "turn_end", ok: true });
        if (options.exit) end();
      })();
      const handle: RunHandle = {
        events: queue,
        exited,
        send: (text) => {
          void (async () => {
            await options.onMessage?.({ ...spec, prompt: text }, emit);
            emit({ t: "turn_end", ok: true });
          })();
        },
        endInput: end,
        interrupt: async () => undefined,
        kill: async () => end(),
        sessionId: () => "s-fake",
      };
      options.handles?.push(handle);
      return handle;
    },
  };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "todo",
    group: "BE",
    rank: id.toLowerCase().replace("-", ""),
    desc: `Do ${id}.`,
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}

const plan: TasksDocument = {
  schema: "konsora/2",
  project: {
    name: "demo",
    base_branch: "main",
    defaults: { provider: "claude", model: "fake" },
    checks: [{ id: "test", run: "test -f readme.txt" }],
  },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [task("BE-01"), task("BE-02", { deps: ["BE-03"] }), task("BE-03")],
};

function options(adapter: AgentAdapter, extra: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    root,
    worktreesDir: join(data, "worktrees", "p-1"),
    privateDir: join(data, "private"),
    adapter,
    mcp: { command: process.execPath, args: [cliBin, "mcp"] },
    store,
    ...extra,
  };
}

/** The human's own ops (answer, accept…), which only the daemon applies in production. */
async function human(op: Op): Promise<void> {
  const result = await mutate(root, op, { actor: "human", at });
  if (!result.ok) throw new Error(result.error.message);
}

async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function taskIn(id: string): Promise<Task> {
  const result = await readTasks(root);
  if (!result.ok) throw new Error(result.error.message);
  return result.document.tasks.find((t) => t.id === id) as Task;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-sup-")));
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-sup-data-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  const init = await initTasks(root, plan);
  if (!init.ok) throw new Error(init.error.message);
  writeFileSync(join(root, "readme.txt"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("startRun", () => {
  /** A fake Codex: it asks to run `git push`, waits for the decision, then finishes. */
  function askingAdapter(decisions: PermissionDecision[]): AgentAdapter {
    let decide: (decision: PermissionDecision) => void = () => undefined;
    const base = fakeAdapter(async (spec, emit) => {
      emit({ t: "started", session: "t-1", model: "fake" });
      emit({ t: "tool", phase: "start", id: "item-1", name: "shell", summary: "git push" });
      emit({
        t: "permission",
        id: "codex-1",
        tool: "shell",
        detail: "git push",
        input: { command: "git push", cwd: spec.cwd },
      });
      const decision = await new Promise<PermissionDecision>((resolve) => {
        decide = resolve;
      });
      decisions.push(decision);
      emit({
        t: "tool",
        phase: "end",
        id: "item-1",
        name: "shell",
        summary: decision.behavior,
        ok: decision.behavior === "allow",
      });
      konsora(spec, "finish", "BE-01", "--summary", "Asked first.");
    });
    return {
      ...base,
      start(spec, io) {
        const handle = base.start(spec, io);
        return {
          ...handle,
          answerPermission: (id, decision) => {
            if (id === "codex-1") decide(decision);
          },
        };
      },
    };
  }

  it("hands the agent's own approval requests to the daemon and its decision back", async () => {
    const decisions: PermissionDecision[] = [];
    const asked: unknown[] = [];
    const registry: RunRegistry = {
      register: async () => ({ url: "http://127.0.0.1:9999", token: "run-token" }),
      unregister: () => undefined,
      requestPermission: async (request) => {
        asked.push(request);
        return { behavior: "allow" };
      },
    };
    const session = await startRun(options(askingAdapter(decisions), { registry }), {
      task: "BE-01",
    });
    const run = await session.done;
    expect(asked).toEqual([
      {
        run: run.id,
        task: "BE-01",
        tool: "shell",
        input: { command: "git push", cwd: run.worktree },
        tool_use_id: "codex-1",
      },
    ]);
    expect(decisions).toEqual([{ behavior: "allow" }]);
    expect(run.state).toBe("succeeded");
    const events = (await store.readEvents(run.id)) as Record<string, unknown>[];
    expect(events).toContainEqual(
      expect.objectContaining({ t: "permission_decision", id: "codex-1", behavior: "allow" }),
    );
  });

  it("denies the agent's approval requests when no daemon can ask the human", async () => {
    const decisions: PermissionDecision[] = [];
    const session = await startRun(options(askingAdapter(decisions)), { task: "BE-01" });
    await session.done;
    expect(decisions).toEqual([
      { behavior: "deny", message: "Nobody can approve it: the run has no daemon." },
    ]);
  });

  it("takes a task from ready to review when the agent edits files and calls finish", async () => {
    const seen: RunSpec[] = [];
    const registered: string[] = [];
    const registry: RunRegistry = {
      register: async ({ run }) => {
        registered.push(run);
        return { url: "http://127.0.0.1:9999", token: "run-token" };
      },
      unregister: (run) => registered.push(`-${run}`),
    };
    const adapter = fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: "s-1", model: "fake" });
        // A commit of its own, an uncommitted file, and a stray edit to the plan copy.
        writeFileSync(join(spec.cwd, "feature.txt"), "feature\n");
        writeFileSync(join(spec.cwd, ".konsora", "extra.txt"), "plan change\n");
        git(spec.cwd, "add", "feature.txt", ".konsora/extra.txt");
        git(spec.cwd, "commit", "-q", "-m", "add feature");
        writeFileSync(join(spec.cwd, "readme.txt"), "hello world\n");
        writeFileSync(join(spec.cwd, ".konsora", "tasks.json"), "{}\n");
        emit({ t: "file", path: "readme.txt", change: "modify" });
        konsora(spec, "note", "BE-01", "Half way there.");
        konsora(spec, "finish", "BE-01", "--summary", "Added feature.txt and updated the readme.");
        emit({
          t: "usage",
          rate_limits: {
            status: "allowed",
            window: "five_hour",
            resets_at: 1793539200,
            windows: [
              { window: "five_hour", status: "allowed", utilization: 0.5, resets_at: 1793539200 },
            ],
          },
        });
        emit({
          t: "usage",
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 60,
          cache_write_tokens: 30,
          cost_usd: 0.25,
        });
        emit({ t: "usage", rate_limits: { status: "allowed_warning", window: "five_hour" } });
        emit({ t: "message", text: "Done.", final: true });
      },
      { seen },
    );

    const session = await startRun(options(adapter, { registry }), { task: "BE-01" });
    expect(session.run.state).toBe("starting");
    const run = await session.done;

    expect(run).toMatchObject({
      state: "succeeded",
      task: "BE-01",
      session_id: "s-1",
      exit: { code: 0, signal: null },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cost_usd: 0.25,
        cache_read_tokens: 60,
        cache_write_tokens: 30,
        // The last snapshot of each window, keeping what the newer one does not repeat.
        rate_limits: [
          {
            window: "five_hour",
            status: "allowed_warning",
            utilization: 0.5,
            resets_at: "2026-11-01T13:20:00Z",
          },
        ],
      },
      summary: "Added feature.txt and updated the readme.",
      checks: [{ id: "test", source: "project", exit_code: 0, timed_out: false }],
      check_attempts: 1,
    });
    expect(run.prompt).toContain("Task BE-01: Task BE-01");
    expect((await taskIn("BE-01")).state).toBe("review");

    // diff.patch: the agent's commit and its leftovers, never .konsora/.
    const diff = (await store.readDiff(run.id)) as string;
    expect(diff).toContain("feature.txt");
    expect(diff).toContain("+hello world");
    expect(diff).not.toContain(".konsora");
    expect(git(run.worktree as string, "log", "--format=%s", `${run.base_commit}..HEAD`)).toBe(
      `konsora: keep .konsora/ out of run ${run.id}\nwip: BE-01 (Konsora run ${run.id})\nadd feature`,
    );
    // The branch carries no plan changes, even those the agent committed.
    expect(
      git(root, "diff", "--name-only", run.base_commit as string, run.head_commit as string),
    ).toBe("feature.txt\nreadme.txt");
    expect(run.head_commit).toBe(git(run.worktree as string, "rev-parse", "HEAD"));

    // events.jsonl has every event, in order, each with its time.
    const events = (await store.readEvents(run.id)) as (RunEvent & { at: string })[];
    expect(events.map((e) => e.t)).toEqual([
      "started",
      "file",
      "usage",
      "usage",
      "usage",
      "message",
      "turn_end",
      "finished",
      "check",
      "check",
    ]);
    for (const event of events) expect(event.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(
      readFileSync(join(store.runDir(run.id), "raw.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(8);

    // The agent got the run-mode MCP with the daemon's token; the run was unregistered.
    expect(seen[0]?.mcp.env).toEqual({
      KONSORA_AGENT: "claude",
      KONSORA_PROJECT: root,
      KONSORA_RUN: run.id,
      KONSORA_TASK: "BE-01",
      KONSORA_DAEMON_URL: "http://127.0.0.1:9999",
      KONSORA_RUN_TOKEN: "run-token",
    });
    expect(seen[0]?.cwd).toBe(run.worktree);
    expect(registered).toEqual([run.id, `-${run.id}`]);
    expect(existsSync(join(data, "private", run.id))).toBe(false);
    // The worktree is kept until the work is integrated or discarded.
    expect(existsSync(run.worktree as string)).toBe(true);
  });

  it("fails the run and returns the task to todo when the agent stops without finish", async () => {
    const adapter = fakeAdapter((spec, emit) => {
      emit({ t: "started", model: "fake" });
      writeFileSync(join(spec.cwd, "partial.txt"), "half done\n");
    });
    const session = await startRun(options(adapter), { task: "BE-01" });
    const run = await session.done;

    expect(run.state).toBe("failed");
    expect(run.summary).toBeUndefined();
    const t = await taskIn("BE-01");
    expect(t.state).toBe("todo");
    const last = t.notes?.at(-1);
    expect(last).toMatchObject({ by: "konsora", kind: "note", run: run.id });
    expect(last?.text).toMatch(/failed: the agent stopped without calling finish/);
    // Its work is kept: committed as wip, in diff.patch, on its branch.
    expect(await store.readDiff(run.id)).toContain("+half done");
    expect(git(root, "rev-parse", "--verify", run.branch as string)).toBe(run.head_commit);
    const events = (await store.readEvents(run.id)) as RunEvent[];
    expect(events.at(-1)).toMatchObject({
      t: "error",
      message: expect.stringMatching(/Run failed/),
    });
  });

  it("gives the agent its branch's git paths, and never commits for it on a branch it switched to", async () => {
    const seen: RunSpec[] = [];
    const mainBefore = git(root, "rev-parse", "main");
    const adapter = fakeAdapter(
      (spec) => {
        // A sandboxed agent can write its worktree's git dir: it points HEAD at main.
        writeFileSync(join(spec.cwd, "sneaky.txt"), "on main?\n");
        git(spec.cwd, "symbolic-ref", "HEAD", "refs/heads/main");
        konsora(spec, "finish", "BE-01", "--summary", "Done.");
      },
      { seen },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    const run = await session.done;

    const common = join(root, ".git");
    expect(seen[0]?.gitWritePaths).toEqual([
      join(common, "worktrees", `BE-01-${run.id.slice(2, 14)}`),
      join(common, "objects"),
      join(common, "refs", "heads", "konsora", "BE-01"),
      join(common, "logs", "refs", "heads", "konsora", "BE-01"),
    ]);
    expect(run.state).toBe("failed");
    expect(git(root, "rev-parse", "main")).toBe(mainBefore);
    expect(git(root, "log", "--format=%s", "main")).not.toMatch(/wip/);
  });

  it("reports a crash with its exit code", async () => {
    const adapter = fakeAdapter((_, emit) => emit({ t: "started", model: "fake" }), {
      exit: { code: 1, signal: null },
    });
    const run = await (await startRun(options(adapter), { task: "BE-01" })).done;
    expect(run).toMatchObject({ state: "failed", exit: { code: 1, signal: null } });
    expect((await taskIn("BE-01")).notes?.at(-1)?.text).toMatch(
      /exited with code 1 before calling finish/,
    );
  });

  it("writes the agent's notes to the main checkout with the run id, not to the worktree", async () => {
    let worktreePlan = "";
    const adapter = fakeAdapter((spec) => {
      konsora(spec, "note", "BE-01", "Progress from inside the run.");
      worktreePlan = readFileSync(join(spec.cwd, ".konsora", "tasks.json"), "utf8");
      // Out of scope: another task.
      expect(() => konsora(spec, "note", "BE-03", "nope")).toThrow();
      konsora(spec, "finish", "BE-01", "--summary", "Done.");
    });
    const run = await (await startRun(options(adapter), { task: "BE-01" })).done;

    const notes = (await taskIn("BE-01")).notes ?? [];
    expect(notes.find((n) => n.text === "Progress from inside the run.")).toMatchObject({
      by: "agent:claude",
      run: run.id,
    });
    expect(notes.find((n) => n.kind === "summary")).toMatchObject({ run: run.id });
    expect((await taskIn("BE-03")).notes).toBeUndefined();
    expect(worktreePlan).not.toContain("Progress from inside the run.");
  });

  it("delivers the human's answer to the live agent through its input", async () => {
    const answers: string[] = [];
    const adapter = fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: "s-1", model: "fake" });
        konsora(spec, "ask", "BE-01", "Memory or Redis?");
      },
      {
        onMessage: (spec) => {
          answers.push(spec.prompt);
          konsora(spec, "finish", "BE-01", "--summary", "Used memory.");
        },
      },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    let settled = false;
    void session.done.then(() => {
      settled = true;
    });
    await until(async () => (await taskIn("BE-01")).notes?.at(-1)?.kind === "question");
    // Wait for the state, not a fixed time: a loaded machine may write it later (DMN-10).
    await until(async () => (await store.read(session.run.id)).state === "running");
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The turn ended with an open question: the run is still alive, waiting.
    expect(settled).toBe(false);
    expect((await store.read(session.run.id)).state).toBe("running");

    await human({ op: "answer", task: "BE-01", text: "Memory is enough." });
    expect(await session.deliverAnswer()).toBe("stdin");
    const run = await session.done;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("> Memory or Redis?");
    expect(answers[0]).toContain("> Memory is enough.");
    expect(run.state).toBe("succeeded");
    expect((await taskIn("BE-01")).state).toBe("review");
    const events = (await store.readEvents(run.id)) as { t: string; delivery?: string }[];
    expect(events.find((e) => e.t === "answer")).toMatchObject({ delivery: "stdin" });
  });

  it("resumes the saved session with the answer when the agent's process has ended", async () => {
    const seen: RunSpec[] = [];
    const adapter = fakeAdapter(
      (spec, emit) => {
        if (spec.resume) {
          konsora(spec, "finish", "BE-01", "--summary", "Resumed and done.");
          return;
        }
        emit({ t: "started", session: "s-42", model: "fake" });
        konsora(spec, "ask", "BE-01", "Which TTL?");
      },
      { exit: { code: 0, signal: null }, seen },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    const id = session.run.id;
    await until(async () =>
      ((await store.readEvents(id)) as { t: string }[]).some((e) => e.t === "waiting_answer"),
    );
    expect(seen).toHaveLength(1);
    expect((await store.read(id)).state).toBe("running");

    await human({ op: "answer", task: "BE-01", text: "Ten minutes." });
    expect(await session.deliverAnswer()).toBe("resume");
    const run = await session.done;

    expect(seen).toHaveLength(2);
    expect(seen[1]?.resume).toBe("s-42");
    expect(seen[1]?.prompt).toContain("> Ten minutes.");
    expect(run).toMatchObject({
      state: "succeeded",
      session_id: "s-42",
      summary: "Resumed and done.",
    });
    const events = (await store.readEvents(id)) as {
      t: string;
      delivery?: string;
      session?: string;
    }[];
    expect(events.find((e) => e.t === "answer")).toMatchObject({
      delivery: "resume",
      session: "s-42",
    });
  });

  it("records in run.json that Codex ran over exec when app-server is missing", async () => {
    const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));
    const adapter = createCodexAdapter({
      command: process.execPath,
      prefixArgs: [fakeCodex],
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "no-app-server",
        FAKE_CODEX_EXEC_FIXTURE: fileURLToPath(
          new URL("./fixtures/codex/exec-success.jsonl", import.meta.url),
        ),
      },
      requestTimeoutMs: 3000,
    });
    const session = await startRun(options(adapter), {
      task: "BE-01",
      agent: { provider: "codex", model: "gpt-6-luna" },
    });
    const run = await session.done;
    expect(run.transport).toBe("exec");
    expect(run.session_id).toBe("01a19791-7d3b-7683-8a4b-57858917212a");
    // The recording never calls finish, so the task goes back to todo.
    expect(run.state).toBe("failed");
  });

  it("keeps an answer for a process that takes no input, and resumes once it has ended", async () => {
    const seen: RunSpec[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeAdapter(
      async (spec, emit) => {
        if (spec.resume) {
          konsora(spec, "finish", "BE-01", "--summary", "Resumed and done.");
          return;
        }
        emit({ t: "started", session: "t-7", model: "fake", transport: "exec" });
        konsora(spec, "ask", "BE-01", "Which TTL?");
        await gate; // still alive when the answer arrives
      },
      { exit: { code: 0, signal: null }, seen },
    );
    const sent: string[] = [];
    // Like `codex exec`: its input is closed; send() must not be used.
    const adapter: AgentAdapter = {
      ...base,
      start(spec, io) {
        const handle = base.start(spec, io);
        return { ...handle, acceptsInput: false, send: (text) => void sent.push(text) };
      },
    };
    const session = await startRun(options(adapter), { task: "BE-01" });
    const id = session.run.id;
    await until(
      async () => (await taskIn("BE-01")).notes?.some((n) => n.kind === "question") ?? false,
    );
    await human({ op: "answer", task: "BE-01", text: "Ten minutes." });
    expect(await session.deliverAnswer()).toBe("resume");
    release();
    const run = await session.done;

    expect(sent).toEqual([]);
    expect(seen.map((s) => s.resume)).toEqual([undefined, "t-7"]);
    expect(seen[1]?.prompt).toContain("> Ten minutes.");
    expect(run).toMatchObject({ state: "succeeded", transport: "exec", session_id: "t-7" });
    expect(await store.read(id)).toMatchObject({ transport: "exec" });
  });

  it("does not lose an answer written before the agent's turn ends", async () => {
    const answers: string[] = [];
    const adapter = fakeAdapter(
      async (spec) => {
        konsora(spec, "ask", "BE-01", "Which TTL?");
        // The human answers right away, before the runner sees this turn end.
        await human({ op: "answer", task: "BE-01", text: "Five." });
      },
      {
        onMessage: (spec) => {
          answers.push(spec.prompt);
          konsora(spec, "finish", "BE-01", "--summary", "Five it is.");
        },
      },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    await until(async () => (await taskIn("BE-01")).notes?.at(-1)?.kind === "answer");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.deliverAnswer();
    expect((await session.done).state).toBe("succeeded");
    expect(answers[0]).toContain("> Five.");
  });

  it("refuses to deliver when there is no answer", async () => {
    const adapter = fakeAdapter((spec) => {
      konsora(spec, "ask", "BE-01", "Q?");
    });
    const session = await startRun(options(adapter), { task: "BE-01" });
    await until(async () => (await taskIn("BE-01")).notes?.at(-1)?.kind === "question");
    await expect(session.deliverAnswer()).rejects.toMatchObject({ code: "no_answer" });
    await human({ op: "answer", task: "BE-01", text: "Stop here." });
    await session.deliverAnswer();
    expect((await session.done).state).toBe("failed");
  });

  it("follows pending approvals with waiting_approval", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = fakeAdapter(async (spec, emit) => {
      emit({ t: "started", model: "fake" });
      await gate;
      konsora(spec, "finish", "BE-01", "--summary", "Done.");
    });
    const session = await startRun(options(adapter), { task: "BE-01" });
    const id = session.run.id;
    const until = async (state: string) => {
      const deadline = Date.now() + 5000;
      while ((await store.read(id)).state !== state && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return (await store.read(id)).state;
    };
    expect(await until("running")).toBe("running");
    await session.setAwaitingApproval(true);
    expect((await store.read(id)).state).toBe("waiting_approval");
    await session.setAwaitingApproval(false);
    expect((await store.read(id)).state).toBe("running");
    release();
    expect((await session.done).state).toBe("succeeded");
  });

  it("cancels a real process that ignores SIGINT, leaving no orphans", async () => {
    const pids = join(data, "pids.json");
    const adapter = createClaudeAdapter({
      command: process.execPath,
      prefixArgs: [fakeClaude],
      env: { ...process.env, FAKE_CLAUDE_MODE: "ignore-int", FAKE_CLAUDE_PIDS: pids },
      killGraceMs: 300,
    });
    const unregistered: string[] = [];
    const registry: RunRegistry = {
      register: async () => ({ url: "http://127.0.0.1:9999", token: "t" }),
      unregister: (run) => unregistered.push(run),
    };
    const session = await startRun(options(adapter, { registry, interruptGraceMs: 300 }), {
      task: "BE-01",
    });
    const id = session.run.id;
    await until(async () => existsSync(pids) && (await store.read(id)).state === "running");
    const { self, child } = JSON.parse(readFileSync(pids, "utf8")) as {
      self: number;
      child: number;
    };
    expect(alive(self) && alive(child)).toBe(true);

    const run = await session.cancel();

    expect(unregistered[0]).toBe(id); // pending approvals denied as soon as it is cancelled
    expect(run.state).toBe("cancelled");
    expect(run.exit).toEqual({ code: null, signal: "SIGTERM" });
    await until(async () => !alive(self) && !alive(child), 3000);
    const t = await taskIn("BE-01");
    expect(t.state).toBe("todo");
    expect(t.notes?.at(-1)).toMatchObject({
      by: "konsora",
      run: id,
      text: expect.stringMatching(/was cancelled/),
    });
    const events = (await store.readEvents(id)) as { t: string }[];
    expect(events.map((e) => e.t)).toEqual(expect.arrayContaining(["cancel", "cancelled"]));
    // Cancelling again is harmless.
    expect((await session.cancel()).state).toBe("cancelled");
  });

  it("cancels a run that waits for an answer without a process", async () => {
    const seen: RunSpec[] = [];
    const adapter = fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: "s-9", model: "fake" });
        konsora(spec, "ask", "BE-01", "Which TTL?");
      },
      { exit: { code: 0, signal: null }, seen },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    await until(async () =>
      ((await store.readEvents(session.run.id)) as { t: string }[]).some(
        (e) => e.t === "waiting_answer",
      ),
    );
    const run = await session.cancel();
    expect(run.state).toBe("cancelled");
    expect(seen).toHaveLength(1);
    expect((await taskIn("BE-01")).state).toBe("todo");
  });

  it("refuses tasks that are not ready, without creating a run", async () => {
    const adapter = fakeAdapter(() => undefined);
    await expect(startRun(options(adapter), { task: "BE-02" })).rejects.toThrow(/blocked by BE-03/);
    await expect(startRun(options(adapter), { task: "BE-09" })).rejects.toThrow(RunError);
    await expect(
      startRun(options(adapter), { task: "BE-01", agent: { provider: "codex", model: "x" } }),
    ).rejects.toThrow(/asks for codex/);
    expect((await store.list()).runs).toEqual([]);
  });
});

describe("checks after finish (RUN-18)", () => {
  async function withChecks(
    checks: TasksDocument["project"]["checks"],
    acceptance?: Task["acceptance"],
  ) {
    const result = await mutate(
      root,
      { op: "set-checks", checks: checks ?? [] },
      { actor: "human", at },
    );
    if (!result.ok) throw new Error(result.error.message);
    if (acceptance) {
      const edit = await mutate(
        root,
        { op: "edit", task: "BE-01", changes: { acceptance } },
        { actor: "human", at },
      );
      if (!edit.ok) throw new Error(edit.error.message);
    }
  }

  const finishing = (extra: Script = () => undefined) =>
    fakeAdapter(async (spec, emit) => {
      emit({ t: "started", session: "s-1", model: "fake" });
      writeFileSync(join(spec.cwd, "feature.txt"), "feature\n");
      await extra(spec, emit);
      konsora(spec, "finish", "BE-01", "--summary", "Added feature.txt.");
    });

  it("runs the project's checks, then the criteria's, in order in the worktree, and saves checks.json", async () => {
    await withChecks(
      [
        { id: "lint", run: "test -f feature.txt && echo lint ok" },
        { id: "where", run: "pwd" },
      ],
      [
        { id: "ac1", text: "Has the feature", check: "grep -q feature feature.txt" },
        { id: "ac2", text: "Reads well" },
      ],
    );
    const session = await startRun(options(finishing()), { task: "BE-01" });
    const run = await session.done;
    expect(run).toMatchObject({
      state: "succeeded",
      check_attempts: 1,
      checks: [
        { id: "lint", source: "project", exit_code: 0, timed_out: false },
        { id: "where", source: "project", exit_code: 0 },
        { id: "ac1", source: "acceptance", exit_code: 0 },
      ],
    });
    const file = await store.readChecks(run.id);
    expect(file?.attempts).toHaveLength(1);
    expect(file?.attempts[0]?.results.map((r) => r.command)).toEqual([
      "test -f feature.txt && echo lint ok",
      "pwd",
      "grep -q feature feature.txt",
    ]);
    expect(file?.attempts[0]?.results[1]?.output).toBe(`${run.worktree}\n`);
    // The run went through checking, and every check has start and end events.
    const events = (await store.readEvents(run.id)) as { t: string; phase?: string; id?: string }[];
    expect(events.filter((e) => e.t === "check").map((e) => `${e.phase}:${e.id}`)).toEqual([
      "start:lint",
      "end:lint",
      "start:where",
      "end:where",
      "start:ac1",
      "end:ac1",
    ]);
    expect((await taskIn("BE-01")).state).toBe("review");
  });

  it("with a failing check, the task goes to review with a Konsora note saying which", async () => {
    await withChecks([
      { id: "unit", run: "echo 1 failing; exit 1" },
      { id: "slow", run: "sleep 30", timeout_s: 1 },
    ]);
    await human({ op: "set-checks", check_retries: 0 });
    const session = await startRun(options(finishing(), { checkKillGraceMs: 200 }), {
      task: "BE-01",
    });
    const run = await session.done;
    expect(run.state).toBe("succeeded");
    expect(run.checks).toMatchObject([
      { id: "unit", exit_code: 1, timed_out: false },
      { id: "slow", exit_code: null, timed_out: true },
    ]);
    const after = await taskIn("BE-01");
    expect(after.state).toBe("review");
    expect(after.notes?.at(-1)).toMatchObject({
      by: "konsora",
      kind: "note",
      run: run.id,
      text: expect.stringContaining("checks failed: unit (exit 1), slow (timed out)"),
    });
    expect((await store.readChecks(run.id))?.attempts[0]?.results[0]?.output).toBe("1 failing\n");
  });

  it("uses the checks approved at launch, not later edits", async () => {
    await withChecks([{ id: "first", run: "true" }]);
    const session = await startRun(
      options(
        finishing(async () => {
          await human({ op: "set-checks", checks: [{ id: "later", run: "exit 9" }] });
        }),
      ),
      { task: "BE-01" },
    );
    const run = await session.done;
    expect(run.checks?.map((c) => c.id)).toEqual(["first"]);
    expect((await taskIn("BE-01")).state).toBe("review");
  });

  it("cancelling during checking kills the check in progress and leaves the run cancelled", async () => {
    const pids = join(data, "check.pid");
    await withChecks([{ id: "hang", run: `sleep 60 & echo $! > ${pids}; sleep 60` }]);
    const session = await startRun(options(finishing(), { checkKillGraceMs: 200 }), {
      task: "BE-01",
    });
    await until(
      async () => (await store.read(session.run.id)).state === "checking" && existsSync(pids),
    );
    const run = await session.cancel();
    expect(run.state).toBe("cancelled");
    expect(run.checks).toMatchObject([{ id: "hang", exit_code: null, timed_out: false }]);
    const grandchild = Number(readFileSync(pids, "utf8"));
    await until(async () => !alive(grandchild), 3000);
    const after = await taskIn("BE-01");
    expect(after.state).toBe("todo");
    expect(after.notes?.at(-1)?.text).toContain("was cancelled");
  });

  it("runs the checks without Konsora's variables", async () => {
    const out = join(data, "env.txt");
    await withChecks([{ id: "env", run: `env > ${out}` }]);
    const session = await startRun(
      options(finishing(), {
        checkEnv: { PATH: process.env.PATH, KONSORA_RUN_TOKEN: "t", KONSORA_DAEMON_TOKEN: "h" },
        registry: {
          register: async () => ({ url: "http://127.0.0.1:1", token: "run-token" }),
          unregister: () => undefined,
        },
      }),
      { task: "BE-01" },
    );
    await session.done;
    const env = readFileSync(out, "utf8");
    expect(env).not.toContain("KONSORA_");
    expect(env).not.toContain("run-token");
  });
});

describe("project.setup before the agent (RUN-20)", () => {
  async function withSetup(setup: { run: string; timeout_s?: number }) {
    await human({ op: "set-checks", setup });
  }

  it("runs setup in the worktree before launching the agent, with its output in the run", async () => {
    await withSetup({ run: "echo installing; pwd; touch .deps-ready" });
    const seen: RunSpec[] = [];
    const adapter = fakeAdapter(
      (spec, emit) => {
        // The agent starts in a prepared worktree.
        emit({
          t: "message",
          text: existsSync(join(spec.cwd, ".deps-ready")) ? "ready" : "bare",
          final: false,
        });
        konsora(spec, "finish", "BE-01", "--summary", "Done.");
      },
      { seen },
    );
    const session = await startRun(options(adapter), { task: "BE-01" });
    const run = await session.done;
    expect(run.state).toBe("succeeded");
    expect(run.setup).toMatchObject({
      command: "echo installing; pwd; touch .deps-ready",
      exit_code: 0,
      timed_out: false,
    });
    const events = (await store.readEvents(run.id)) as {
      t: string;
      phase?: string;
      output?: string;
      text?: string;
    }[];
    expect(events[0]).toMatchObject({ t: "setup", phase: "start" });
    expect(events[1]).toMatchObject({
      t: "setup",
      phase: "end",
      output: `installing\n${run.worktree}\n`,
    });
    expect(events.find((e) => e.t === "message")?.text).toBe("ready");
    expect(seen).toHaveLength(1);
  });

  it("a failing setup leaves the run failed without launching the agent, and the task in todo with a note", async () => {
    await withSetup({ run: "echo npm ERR! missing lockfile; exit 1" });
    const seen: RunSpec[] = [];
    const session = await startRun(options(fakeAdapter(() => undefined, { seen })), {
      task: "BE-01",
    });
    const run = await session.done;
    expect(seen).toHaveLength(0);
    expect(run).toMatchObject({ state: "failed", setup: { exit_code: 1, timed_out: false } });
    expect(run.usage).toBeUndefined();
    const after = await taskIn("BE-01");
    expect(after.state).toBe("todo");
    expect(after.notes?.at(-1)).toMatchObject({
      by: "konsora",
      run: run.id,
      text: expect.stringContaining(
        "the setup command `echo npm ERR! missing lockfile; exit 1` exited with code 1",
      ),
    });
    const events = (await store.readEvents(run.id)) as { t: string; output?: string }[];
    expect(events.find((e) => e.t === "setup" && e.output)?.output).toBe(
      "npm ERR! missing lockfile\n",
    );
  });

  it("a setup past its timeout is stopped and fails the run", async () => {
    await withSetup({ run: "sleep 30", timeout_s: 1 });
    const seen: RunSpec[] = [];
    const session = await startRun(
      options(
        fakeAdapter(() => undefined, { seen }),
        { checkKillGraceMs: 200 },
      ),
      { task: "BE-01" },
    );
    const run = await session.done;
    expect(seen).toHaveLength(0);
    expect(run).toMatchObject({ state: "failed", setup: { exit_code: null, timed_out: true } });
    expect((await taskIn("BE-01")).notes?.at(-1)?.text).toContain("ran out of time");
  });

  it("cancelling during setup stops it and leaves the run cancelled", async () => {
    await withSetup({ run: "sleep 30" });
    const seen: RunSpec[] = [];
    const session = await startRun(
      options(
        fakeAdapter(() => undefined, { seen }),
        { checkKillGraceMs: 200 },
      ),
      { task: "BE-01" },
    );
    await until(async () =>
      ((await store.readEvents(session.run.id)) as { t: string }[]).some((e) => e.t === "setup"),
    );
    const run = await session.cancel();
    expect(run.state).toBe("cancelled");
    expect(seen).toHaveLength(0);
    expect((await taskIn("BE-01")).state).toBe("todo");
  });
});

describe("the fix loop with failed checks (RUN-19)", () => {
  async function setChecks(checks: TasksDocument["project"]["checks"], retries?: number) {
    await human({
      op: "set-checks",
      checks: checks ?? [],
      ...(retries !== undefined ? { check_retries: retries } : {}),
    });
  }

  /** An agent that finishes every turn; `fix` decides what it does when it gets a retry. */
  function agent(fix: (spec: RunSpec) => void, seen: RunSpec[]) {
    return fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: "s-1", model: "fake" });
        if (spec.resume) fix(spec);
        konsora(
          spec,
          "finish",
          "BE-01",
          "--summary",
          spec.resume ? "Fixed the checks." : "First try.",
        );
      },
      { seen, exit: { code: 0, signal: null } },
    );
  }

  it("gives a failed check back to the same agent in its session, and a green retry reaches review", async () => {
    await setChecks([
      { id: "lint", run: "true" },
      { id: "unit", run: "test -f fixed.txt || { echo 'expected fixed.txt'; exit 1; }" },
    ]);
    const seen: RunSpec[] = [];
    const session = await startRun(
      options(agent((spec) => writeFileSync(join(spec.cwd, "fixed.txt"), "ok\n"), seen)),
      { task: "BE-01" },
    );
    const run = await session.done;

    expect(seen).toHaveLength(2);
    expect(seen[1]?.resume).toBe("s-1");
    expect(seen[1]?.agent).toEqual(seen[0]?.agent);
    expect(seen[1]?.prompt).toContain(
      "Konsora ran the checks of BE-01 after you called `finish` (attempt 1), and one failed.",
    );
    expect(seen[1]?.prompt).toContain("expected fixed.txt");
    expect(seen[1]?.prompt).not.toContain("Project check lint");

    expect(run).toMatchObject({
      state: "succeeded",
      check_attempts: 2,
      summary: "Fixed the checks.",
      checks: [
        { id: "lint", exit_code: 0 },
        { id: "unit", exit_code: 0 },
      ],
    });
    const file = await store.readChecks(run.id);
    expect(file?.attempts.map((a) => a.results.map((r) => r.exit_code))).toEqual([
      [0, 1],
      [0, 0],
    ]);
    const events = (await store.readEvents(run.id)) as { t: string; attempt?: number }[];
    expect(events.filter((e) => e.t === "retry")).toEqual([
      expect.objectContaining({ attempt: 1, of: 2, failed: ["unit (exit 1)"] }),
    ]);
    // The run was back in running for the retry: it started a second agent turn.
    expect(events.filter((e) => e.t === "started")).toHaveLength(2);
    const after = await taskIn("BE-01");
    expect(after.state).toBe("review");
    expect(after.notes?.some((n) => n.by === "konsora" && n.text.includes("retry 1 of 2"))).toBe(
      true,
    );
  });

  it("once the retries run out, the task reaches review with the checks red and a note", async () => {
    await setChecks([{ id: "unit", run: "echo nope; exit 2" }], 2);
    const seen: RunSpec[] = [];
    const session = await startRun(options(agent(() => undefined, seen)), { task: "BE-01" });
    const run = await session.done;
    expect(seen).toHaveLength(3);
    expect(seen[2]?.prompt).toContain("This is the last try");
    expect(run).toMatchObject({ state: "succeeded", check_attempts: 3 });
    expect(run.checks).toMatchObject([{ id: "unit", exit_code: 2 }]);
    expect((await store.readChecks(run.id))?.attempts).toHaveLength(3);
    const after = await taskIn("BE-01");
    expect(after.state).toBe("review");
    expect(after.notes?.at(-1)).toMatchObject({
      by: "konsora",
      text: expect.stringContaining("They still fail after 2 retries"),
    });
  });

  it("with check_retries = 0 there is no retry at all", async () => {
    await setChecks([{ id: "unit", run: "exit 1" }], 0);
    const seen: RunSpec[] = [];
    const run = await (await startRun(options(agent(() => undefined, seen)), { task: "BE-01" }))
      .done;
    expect(seen).toHaveLength(1);
    expect(run.check_attempts).toBe(1);
    expect((await taskIn("BE-01")).state).toBe("review");
  });

  it("an intermediate task of a YOLO chain goes to done only with every check green", async () => {
    // BE-03 → BE-02 (YOLO): BE-03 is intermediate.
    await human({ op: "set-yolo", task: "BE-02", value: true });
    const yoloAgent = (seen: RunSpec[]) =>
      fakeAdapter(
        (spec, emit) => {
          emit({ t: "started", session: "s-1", model: "fake" });
          konsora(spec, "finish", "BE-03", "--summary", "Done.");
        },
        { seen, exit: { code: 0, signal: null } },
      );

    await setChecks([{ id: "unit", run: "exit 1" }], 0);
    const red = await (await startRun(options(yoloAgent([])), { task: "BE-03" })).done;
    expect(red.check_attempts).toBe(1);
    expect((await taskIn("BE-03")).state).toBe("review");

    // Sent back and run again with green checks: straight to done.
    await human({ op: "send-back", task: "BE-03", feedback: "Again." });
    await setChecks([{ id: "unit", run: "true" }]);
    await (await startRun(options(yoloAgent([])), { task: "BE-03" })).done;
    expect((await taskIn("BE-03")).state).toBe("done");
  });
});

describe("rebase runs for an integration conflict (RUN-24)", () => {
  /** BE-01 changes readme.txt on its branch, and main changes the same line meanwhile. */
  async function conflictingRun() {
    const first = await startRun(
      options(
        fakeAdapter(
          (spec, emit) => {
            emit({ t: "started", session: "s-1", model: "fake" });
            writeFileSync(join(spec.cwd, "readme.txt"), "hello from BE-01\n");
            konsora(spec, "finish", "BE-01", "--summary", "Greets from BE-01.");
          },
          { exit: { code: 0, signal: null } },
        ),
      ),
      { task: "BE-01" },
    );
    const run = await first.done;
    expect(run.state).toBe("succeeded");
    writeFileSync(join(root, "readme.txt"), "hello from main\n");
    git(root, "add", "readme.txt");
    git(root, "commit", "-q", "-m", "main moves on");
    const doc = await readTasks(root);
    if (!doc.ok) throw new Error(doc.error.message);
    const integration = await integrateRun({
      root,
      worktreesDir: join(data, "worktrees", "p-1"),
      document: doc.document,
      runId: run.id,
      store,
    });
    expect(integration).toMatchObject({ status: "conflict", files: ["readme.txt"] });
    return run;
  }

  /** An agent that rebases onto the tip named in its prompt and keeps both lines. */
  function rebasingAgent(seen: RunSpec[], finish = true) {
    return fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: spec.resume ?? "s-2", model: "fake" });
        const onto = /git rebase ([0-9a-f]{40})/.exec(spec.prompt)?.[1] as string;
        try {
          execFileSync("git", ["rebase", onto], { cwd: spec.cwd, env: gitEnv(), stdio: "pipe" });
        } catch {
          // The conflict: resolve it keeping both sides.
        }
        writeFileSync(join(spec.cwd, "readme.txt"), "hello from main\nhello from BE-01\n");
        git(spec.cwd, "add", "readme.txt");
        execFileSync("git", ["rebase", "--continue"], {
          cwd: spec.cwd,
          env: { ...gitEnv(), GIT_EDITOR: "true" },
          stdio: "pipe",
        });
        if (finish) konsora(spec, "finish", "BE-01", "--summary", "Rebased; kept both greetings.");
      },
      { seen, exit: { code: 0, signal: null } },
    );
  }

  it("rebases the conflicting run's branch in a new run, which then integrates cleanly", async () => {
    const conflicted = await conflictingRun();
    const tip = git(root, "rev-parse", "main");
    const seen: RunSpec[] = [];
    const session = await startRebaseRun(options(rebasingAgent(seen)), { run: conflicted.id });
    expect(session.run).toMatchObject({
      task: "BE-01",
      rebase_of: conflicted.id,
      worktree: conflicted.worktree,
      branch: conflicted.branch,
      base_commit: tip,
      agent: conflicted.agent,
    });
    expect((await taskIn("BE-01")).state).toBe("doing");
    const run = await session.done;

    // Same branch and worktree, the agent's session resumed, the files listed in the prompt.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe(conflicted.worktree);
    expect(seen[0]?.resume).toBe("s-1");
    expect(seen[0]?.prompt).toContain("Files that conflict:\n- `readme.txt`");
    expect(seen[0]?.prompt).toBe(run.prompt);
    expect(run).toMatchObject({ state: "succeeded", checks: [{ id: "test", exit_code: 0 }] });
    expect(await store.readDiff(run.id)).toContain("+hello from BE-01");

    const after = await taskIn("BE-01");
    expect(after.state).toBe("review");
    expect(
      after.notes?.some(
        (n) => n.by === "konsora" && n.text.includes(`rebases run ${conflicted.id}`),
      ),
    ).toBe(true);
    // The conflicting run is superseded, but its worktree is the new run's now.
    expect((await store.read(conflicted.id)).integration?.state).toBe("discarded");
    expect(existsSync(conflicted.worktree as string)).toBe(true);

    const doc = await readTasks(root);
    if (!doc.ok) throw new Error(doc.error.message);
    const merged = await integrateRun({
      root,
      worktreesDir: join(data, "worktrees", "p-1"),
      document: doc.document,
      runId: run.id,
      store,
    });
    expect(merged.status).toBe("merged");
    expect(readFileSync(join(root, "readme.txt"), "utf8")).toBe(
      "hello from main\nhello from BE-01\n",
    );
    expect(git(root, "log", "-1", "--format=%B")).toContain(`Konsora-Run: ${run.id}`);
  });

  it("a rebase run that fails returns the task to review with the conflict intact", async () => {
    const conflicted = await conflictingRun();
    const run = await (
      await startRebaseRun(options(rebasingAgent([], false)), { run: conflicted.id })
    ).done;
    expect(run.state).toBe("failed");
    const after = await taskIn("BE-01");
    expect(after.state).toBe("review");
    expect(after.notes?.at(-1)?.text).toContain(`run ${conflicted.id}'s conflict`);
    expect((await store.read(conflicted.id)).integration?.state).toBe("conflict");
  });

  it("refuses runs without a conflict, and conflicts that are gone", async () => {
    const conflicted = await conflictingRun();
    const other = (await store.list()).runs.find((r) => r.id !== conflicted.id);
    expect(other).toBeUndefined();
    // main goes back to what the run started from: nothing conflicts now.
    git(root, "revert", "--no-edit", "HEAD");
    await expect(
      startRebaseRun(options(rebasingAgent([])), { run: conflicted.id }),
    ).rejects.toMatchObject({ code: "no_conflict" });
    await human({ op: "send-back", task: "BE-01", feedback: "Redo." });
    const plain = await (
      await startRun(
        options(
          fakeAdapter(
            (spec) => {
              konsora(spec, "finish", "BE-01", "--summary", "x");
            },
            {
              exit: { code: 0, signal: null },
            },
          ),
        ),
        { task: "BE-01" },
      )
    ).done;
    await expect(
      startRebaseRun(options(rebasingAgent([])), { run: plain.id }),
    ).rejects.toBeInstanceOf(RunError);
    await expect(
      startRebaseRun(options(rebasingAgent([])), { run: plain.id }),
    ).rejects.toMatchObject({
      code: "not_rebasable",
    });
    // No rebase run was created by the refusals.
    expect((await store.list()).runs.filter((r) => r.rebase_of)).toEqual([]);
  });
});

describe("YOLO chains integrate their intermediate tasks (RUN-23)", () => {
  /** BE-03 → BE-02 (YOLO): BE-03 is an intermediate task of the chain. */
  function chainAgent(work: (spec: RunSpec) => void, seen: RunSpec[] = []) {
    return fakeAdapter(
      (spec, emit) => {
        emit({ t: "started", session: "s-1", model: "fake" });
        work(spec);
        konsora(spec, "finish", spec.mcp.env.KONSORA_TASK as string, "--summary", "Done.");
      },
      { seen, exit: { code: 0, signal: null } },
    );
  }

  it("a green intermediate task is integrated with one commit and goes to done; its worktree and branch go", async () => {
    await human({ op: "set-yolo", task: "BE-02", value: true });
    const before = git(root, "rev-parse", "main");
    const run = await (
      await startRun(
        options(chainAgent((spec) => writeFileSync(join(spec.cwd, "be03.txt"), "from BE-03\n"))),
        { task: "BE-03" },
      )
    ).done;

    expect(run).toMatchObject({ state: "succeeded", integration: { state: "merged" } });
    expect((await taskIn("BE-03")).state).toBe("done");
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
    const message = git(root, "log", "-1", "--format=%B", "main");
    expect(message).toContain("BE-03: Task BE-03");
    expect(message).toContain(`Konsora-Run: ${run.id}`);
    expect(readFileSync(join(root, "be03.txt"), "utf8")).toBe("from BE-03\n");
    expect(existsSync(run.worktree as string)).toBe(false);
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    const events = (await store.readEvents(run.id)) as { t: string; commit?: string }[];
    expect(events.find((e) => e.t === "integrated")?.commit).toBe(git(root, "rev-parse", "main"));

    // ac3: the dependent starts from a base that already has BE-03's commit.
    const seen: RunSpec[] = [];
    const next = await startRun(options(chainAgent(() => undefined, seen)), { task: "BE-02" });
    expect(next.run.base_commit).toBe(git(root, "rev-parse", "main"));
    await next.done;
    expect(existsSync(join(seen[0]?.cwd as string, "be03.txt"))).toBe(true);
    // The YOLO task itself still goes to review, without integrating.
    expect((await taskIn("BE-02")).state).toBe("review");
    expect((await store.read(next.run.id)).integration).toBeUndefined();
  });

  it("an intermediate task whose work conflicts stays in review with a note, never done", async () => {
    await human({ op: "set-yolo", task: "BE-02", value: true });
    const run = await (
      await startRun(
        options(
          chainAgent((spec) => {
            writeFileSync(join(spec.cwd, "readme.txt"), "hello from BE-03\n");
            // Meanwhile main changes the same line.
            writeFileSync(join(root, "readme.txt"), "hello from main\n");
            git(root, "commit", "-q", "-m", "main moves on", "--", "readme.txt");
          }),
        ),
        { task: "BE-03" },
      )
    ).done;

    expect(run).toMatchObject({ state: "succeeded", integration: { state: "conflict" } });
    const after = await taskIn("BE-03");
    expect(after.state).toBe("review");
    expect(after.notes?.at(-1)).toMatchObject({
      by: "konsora",
      run: run.id,
      text: expect.stringContaining("conflicts with main in readme.txt"),
    });
    expect(existsSync(run.worktree as string)).toBe(true);
    expect(readFileSync(join(root, "readme.txt"), "utf8")).toBe("hello from main\n");
    // The chain stops: BE-02 is blocked by BE-03 in review.
    await expect(
      startRun(options(chainAgent(() => undefined)), { task: "BE-02" }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("outside a YOLO chain nothing is integrated before accept", async () => {
    const run = await (
      await startRun(
        options(chainAgent((spec) => writeFileSync(join(spec.cwd, "be03.txt"), "x\n"))),
        { task: "BE-03" },
      )
    ).done;
    expect(run.integration).toBeUndefined();
    expect((await taskIn("BE-03")).state).toBe("review");
    expect(existsSync(join(root, "be03.txt"))).toBe(false);
  });
});
