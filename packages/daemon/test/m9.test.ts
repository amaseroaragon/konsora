/**
 * M9 verification (RUN-25), end to end through the daemon with a fake agent (no quota): a DAG of
 * 6 tasks in YOLO with max_parallel = 2.
 *
 *   BE-01 → BE-02 → BE-03 ─┐
 *                          ├→ BE-06 (YOLO, final)
 *   BE-04 → BE-05 ─────────┘
 *
 * Every run writes `<task>.txt` and records, when it starts, how many runs are alive and whether
 * its worktree already has its dependencies' files (that is, they were integrated first).
 */
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
import type { Run, Task, TasksDocument } from "@konsora/core";
import { initTasks, readTasks } from "@konsora/core/store";
import {
  type AgentAdapter,
  EventQueue,
  gitEnv,
  type RunEvent,
  type RunExit,
  type RunSpec,
} from "@konsora/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueView } from "../src/queue.ts";
import { type RunningDaemon, startDaemon } from "../src/server.ts";

const cliBin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const at = "2026-11-08T10:00:00Z";
let data: string;
let root: string;
let daemon: RunningDaemon;
let projectId: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: "pipe" }).trim();

/** Like an agent, it tries again when the plan is locked for a moment ("try again shortly"). */
function konsora(spec: RunSpec, ...args: string[]): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(process.execPath, [cliBin, ...args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.mcp.env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (attempt >= 10 || !stderr.includes("is locked")) throw error;
      execFileSync("sleep", ["0.2"]);
    }
  }
}

const DEPS: Record<string, string[]> = {
  "BE-01": [],
  "BE-02": ["BE-01"],
  "BE-03": ["BE-02"],
  "BE-04": [],
  "BE-05": ["BE-04"],
  "BE-06": ["BE-03", "BE-05"],
};
const IDS = Object.keys(DEPS);

type Start = { task: string; live: number; depsIntegrated: boolean; rebase: boolean };
let starts: Start[] = [];
let live = 0;
let maxLive = 0;
/** Tasks whose agent waits for the test before finishing. */
let hold = new Set<string>();
const held = new Map<string, () => void>();
/** Extra work per task (e.g. a file both branches change). */
let extra: (task: string, cwd: string) => void = () => undefined;
/** How long each agent works, per task, in ms. */
let delay: (task: string) => number = () => 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rebases onto the tip in the prompt, keeping both sides of `shared.txt`. */
function rebase(spec: RunSpec): void {
  const onto = /git rebase ([0-9a-f]{40})/.exec(spec.prompt)?.[1] as string;
  try {
    git(spec.cwd, "rebase", onto);
  } catch {
    const ours = git(spec.cwd, "show", `${onto}:shared.txt`);
    const theirs = git(spec.cwd, "show", "REBASE_HEAD:shared.txt");
    writeFileSync(join(spec.cwd, "shared.txt"), `${ours}\n${theirs}\n`);
    git(spec.cwd, "add", "shared.txt");
    execFileSync("git", ["rebase", "--continue"], {
      cwd: spec.cwd,
      env: { ...gitEnv(), GIT_EDITOR: "true" },
      stdio: "pipe",
    });
  }
}

const fake: AgentAdapter = {
  id: "claude",
  detect: async () => ({ installed: true, version: "0.0.0" }),
  models: async () => [{ id: "fake", label: "Fake", efforts: [] }],
  start(spec) {
    const task = spec.mcp.env.KONSORA_TASK as string;
    const isRebase = spec.prompt.includes("rebase the branch and resolve the conflicts");
    live += 1;
    maxLive = Math.max(maxLive, live);
    starts.push({
      task,
      live,
      depsIntegrated: (DEPS[task] ?? []).every((dep) => existsSync(join(spec.cwd, `${dep}.txt`))),
      rebase: isRebase,
    });
    const queue = new EventQueue<RunEvent>();
    let resolveExit: (exit: RunExit) => void = () => undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    let ended = false;
    const end = (exit: RunExit) => {
      if (ended) return;
      ended = true;
      live -= 1;
      queue.push({ t: "finished", ok: exit.code === 0 });
      queue.close();
      resolveExit(exit);
    };
    queue.push({ t: "started", session: `s-${task}`, model: "fake" });
    const work = () => {
      if (isRebase) rebase(spec);
      else {
        writeFileSync(join(spec.cwd, `${task}.txt`), `${task}\n`);
        extra(task, spec.cwd);
      }
      konsora(spec, "finish", task, "--summary", `Did ${task}.`);
      queue.push({ t: "turn_end", ok: true });
    };
    void (async () => {
      await sleep(delay(task));
      if (hold.has(task) && !isRebase) held.set(task, work);
      else work();
    })();
    return {
      events: queue,
      exited,
      send: () => undefined,
      endInput: () => end({ code: 0, signal: null }),
      interrupt: async () => end({ code: null, signal: "SIGINT" }),
      kill: async () => end({ code: null, signal: "SIGKILL" }),
      sessionId: () => `s-${task}`,
    };
  },
};

function task(id: string): Task {
  const deps = DEPS[id] ?? [];
  return {
    id,
    title: `Task ${id}`,
    state: "todo",
    group: "BE",
    ...(deps.length ? { deps } : {}),
    rank: id.toLowerCase().replace("-", ""),
    created: { at, by: "human" },
    updated_at: at,
  };
}

const plan: TasksDocument = {
  schema: "konsora/2",
  project: {
    name: "m9",
    base_branch: "main",
    defaults: { provider: "claude", model: "fake" },
    checks: [{ id: "files", run: "ls *.txt" }],
  },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 6 },
  tasks: IDS.map(task),
};

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${daemon.url}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const op = (body: Record<string, unknown>) =>
  api<{ error?: { code: string } }>(`/projects/${projectId}/ops`, {
    method: "POST",
    body: JSON.stringify(body),
  });

async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(25);
  }
}

async function states(): Promise<Record<string, string>> {
  const result = await readTasks(root);
  if (!result.ok) throw new Error(result.error.message);
  return Object.fromEntries(result.document.tasks.map((t) => [t.id, t.state]));
}

async function start(): Promise<void> {
  daemon = await startDaemon({ dataDir: data, adapters: { claude: fake }, interruptGraceMs: 100 });
}

/** The Konsora commits on main after the initial one, as task ids, oldest first. */
function integrated(): string[] {
  return git(root, "log", "--reverse", "--format=%s", "main")
    .split("\n")
    .slice(1)
    .map((subject) => subject.split(":")[0] as string);
}

function topological(order: string[]): boolean {
  return order.every((id, i) => (DEPS[id] ?? []).every((dep) => order.indexOf(dep) < i));
}

beforeEach(async () => {
  starts = [];
  live = 0;
  maxLive = 0;
  hold = new Set();
  held.clear();
  extra = () => undefined;
  delay = () => 300;
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-m9-data-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-m9-proj-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  const init = await initTasks(root, plan);
  if (!init.ok) throw new Error(init.error.message);
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  await start();
  const res = await api<{ project: { id: string } }>("/projects", {
    method: "POST",
    body: JSON.stringify({ path: root }),
  });
  projectId = res.body.project.id;
  expect((await op({ op: "set-yolo", task: "BE-06", value: true })).status).toBe(200);
});

/** The human queues the whole DAG; nothing runs that is not queued. */
async function enqueueAll(): Promise<void> {
  const res = await api(`/projects/${projectId}/queue`, {
    method: "POST",
    body: JSON.stringify({ items: IDS.map((t) => ({ task: t })) }),
  });
  expect(res.status).toBe(201);
}

afterEach(async () => {
  held.clear();
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("M9: a 6-task DAG in YOLO with max_parallel = 2 (RUN-25)", { timeout: 60_000 }, () => {
  it("never runs more than 2 at once, starts nothing before its deps are integrated, and ends with the final task in review", async () => {
    await enqueueAll();
    await until(async () => (await states())["BE-06"] === "review");
    expect(await states()).toEqual({
      "BE-01": "done",
      "BE-02": "done",
      "BE-03": "done",
      "BE-04": "done",
      "BE-05": "done",
      "BE-06": "review",
    });
    // ac1
    expect(maxLive).toBe(2);
    expect(starts.every((s) => s.live <= 2)).toBe(true);
    expect(starts.map((s) => s.task).sort()).toEqual(IDS);
    expect(starts.filter((s) => !s.depsIntegrated)).toEqual([]);
    // ac2: five intermediate commits in topological order, then the human accepts the final one.
    const before = integrated();
    expect(before).toHaveLength(5);
    expect(topological(before)).toBe(true);
    expect((await op({ op: "accept", task: "BE-06" })).status).toBe(200);
    const after = integrated();
    expect(after).toHaveLength(6);
    expect(after.at(-1)).toBe("BE-06");
    expect(topological(after)).toBe(true);
    for (const id of IDS) expect(readFileSync(join(root, `${id}.txt`), "utf8")).toBe(`${id}\n`);
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    await until(
      async () =>
        (await api<QueueView>(`/projects/${projectId}/queue`)).body.queue.entries.length === 0,
    );
  });

  it("a restart midway leaves the live runs interrupted and the queue paused, launching nothing", async () => {
    // Both first tasks are held mid-run when the daemon stops.
    hold = new Set(["BE-01", "BE-04"]);
    await enqueueAll();
    await until(() => held.size === 2);
    expect(starts.map((s) => s.task)).toEqual(["BE-01", "BE-04"]);

    await daemon.close();
    starts = [];
    await start();
    await sleep(500);
    await daemon.scheduler.idle();

    const view = (await api<QueueView>(`/projects/${projectId}/queue`)).body;
    expect(view.queue.state).toBe("paused");
    expect(view.queue.entries).toHaveLength(6);
    const runs = (await api<{ runs: Run[] }>(`/projects/${projectId}/runs`)).body.runs;
    expect(runs.map((r) => [r.task, r.state])).toEqual([
      ["BE-01", "interrupted"],
      ["BE-04", "interrupted"],
    ]);
    expect(starts).toEqual([]);
    expect(Object.values(await states()).filter((s) => s === "doing")).toHaveLength(2);
  });

  it("a conflict between the two branches stops the chain until the agent rebases it", async () => {
    // Both first tasks change shared.txt; BE-04 finishes last, so its integration conflicts.
    extra = (id, cwd) => {
      if (id === "BE-01" || id === "BE-04") writeFileSync(join(cwd, "shared.txt"), `${id}\n`);
    };
    delay = (id) => (id === "BE-04" ? 1200 : 300);
    await enqueueAll();

    await until(async () => (await states())["BE-04"] === "review");
    const runs = (await api<{ runs: Run[] }>(`/projects/${projectId}/runs?task=BE-04`)).body.runs;
    const conflicted = runs.at(-1) as Run;
    expect(conflicted.integration?.state).toBe("conflict");
    await until(async () => (await states())["BE-03"] === "done");
    await daemon.scheduler.idle();
    // The chain waits for BE-04: BE-05 and BE-06 have not started.
    expect(starts.some((s) => s.task === "BE-05" || s.task === "BE-06")).toBe(false);

    const rebased = await api<{ run: Run }>(`/projects/${projectId}/runs/${conflicted.id}/rebase`, {
      method: "POST",
    });
    expect(rebased.status).toBe(201);
    await until(async () => (await states())["BE-06"] === "review");

    expect(starts.filter((s) => s.rebase).map((s) => s.task)).toEqual(["BE-04"]);
    expect(starts.filter((s) => !s.depsIntegrated)).toEqual([]);
    expect(maxLive).toBeLessThanOrEqual(2);
    const order = integrated();
    expect(order).toHaveLength(5);
    expect(topological(order)).toBe(true);
    expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("BE-01\nBE-04\n");
  });
});
