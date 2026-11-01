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
  type RunEvent,
  type RunExit,
  type RunHandle,
  type RunSpec,
} from "../src/adapter.ts";
import { createClaudeAdapter } from "../src/claude.ts";
import { gitEnv } from "../src/git.ts";
import { RunStore } from "../src/run-store.ts";
import { RunError, type RunRegistry, type SupervisorOptions, startRun } from "../src/supervisor.ts";

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
    checks: [{ id: "test", run: "npm test" }],
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
        emit({ t: "usage", input_tokens: 100, output_tokens: 20, cost_usd: 0.25 });
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
      usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.25 },
      summary: "Added feature.txt and updated the readme.",
      checks: [],
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
      "message",
      "turn_end",
      "finished",
    ]);
    for (const event of events) expect(event.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(
      readFileSync(join(store.runDir(run.id), "raw.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(6);

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
