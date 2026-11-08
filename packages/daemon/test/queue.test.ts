import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { QueueFile, Run, Task, TasksDocument } from "@konsora/core";
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
import WebSocket from "ws";
import type { QueueView } from "../src/queue.ts";
import { type RunningDaemon, startDaemon } from "../src/server.ts";

const cliBin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const at = "2026-11-08T10:00:00Z";
let data: string;
let root: string;
let daemon: RunningDaemon;
let projectId: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();

/**
 * The agent's plan writes, through the CLI as its MCP would. Asynchronous on purpose: the daemon
 * runs in this same process, and a synchronous call would freeze it while it holds the plan's
 * lock, so the CLI could never get it (DMN-10).
 */
const konsora = async (spec: RunSpec, ...args: string[]) =>
  (
    await promisify(execFile)(process.execPath, [cliBin, ...args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.mcp.env },
      encoding: "utf8",
    })
  ).stdout;

/** Agents that work until the test releases their task; they record how many run at once. */
const gates = new Map<string, () => void>();
let live = 0;
let maxLive = 0;
const started: string[] = [];

function gatedAdapter(id: "claude" | "codex"): AgentAdapter {
  return {
    id,
    detect: async () => ({ installed: true, version: "0.0.0" }),
    models: async () => [{ id: "fake", label: "Fake", efforts: [] }],
    start(spec: RunSpec) {
      const task = spec.mcp.env.KONSORA_TASK as string;
      started.push(task);
      live += 1;
      maxLive = Math.max(maxLive, live);
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
      gates.set(task, async () => {
        writeFileSync(join(spec.cwd, `${task}.txt`), `${task}\n`);
        await konsora(spec, "finish", task, "--summary", `Did ${task}.`);
        queue.push({ t: "turn_end", ok: true });
      });
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
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "todo",
    group: "BE",
    rank: id.toLowerCase().replace("-", ""),
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}

// BE-01, BE-02, BE-03 independent; BE-04 depends on BE-01.
const plan: TasksDocument = {
  schema: "konsora/2",
  project: { name: "demo", base_branch: "main", defaults: { provider: "claude", model: "fake" } },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 4 },
  tasks: [task("BE-01"), task("BE-02"), task("BE-03"), task("BE-04", { deps: ["BE-01"] })],
};

const codex = { provider: "codex", model: "fake" } as const;

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

async function start(): Promise<void> {
  daemon = await startDaemon({
    dataDir: data,
    adapters: { claude: gatedAdapter("claude"), codex: gatedAdapter("codex") },
    interruptGraceMs: 100,
  });
}

async function enqueue(items: { task: string; agent?: unknown }[]) {
  return api<QueueView & { added: string[]; already: string[] }>(`/projects/${projectId}/queue`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

async function view(): Promise<QueueView> {
  return (await api<QueueView>(`/projects/${projectId}/queue`)).body;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function taskState(id: string): Promise<string | undefined> {
  const result = await readTasks(root);
  return result.ok ? result.document.tasks.find((t) => t.id === id)?.state : undefined;
}

/** Lets the scheduler react, then gives it a moment to (not) launch anything more. */
async function quiet(): Promise<void> {
  await daemon.scheduler.idle();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await daemon.scheduler.idle();
}

function release(id: string): void {
  const open = gates.get(id);
  if (!open) throw new Error(`${id} is not running`);
  gates.delete(id);
  open();
}

beforeEach(async () => {
  gates.clear();
  live = 0;
  maxLive = 0;
  started.length = 0;
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-queue-data-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-queue-proj-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  const init = await initTasks(root, plan);
  if (!init.ok) throw new Error(init.error.message);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  await start();
  const res = await api<{ project: { id: string } }>("/projects", {
    method: "POST",
    body: JSON.stringify({ path: root }),
  });
  projectId = res.body.project.id;
});

afterEach(async () => {
  // Agents still waiting for their gate are left alone: the daemon is gone.
  gates.clear();
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Real runs with git worktrees: slow when the whole suite runs in parallel.
describe("the queue (DMN-08)", { timeout: 30_000 }, () => {
  it("launches at most max_parallel runs, and the rest as they become ready", async () => {
    const res = await enqueue(["BE-04", "BE-03", "BE-02", "BE-01"].map((t) => ({ task: t })));
    expect(res.status).toBe(201);
    expect(res.body.added).toEqual(["BE-04", "BE-03", "BE-02", "BE-01"]);
    await quiet();
    // Topological order, then rank: BE-01 and BE-02 take the two default slots.
    expect(started).toEqual(["BE-01", "BE-02"]);
    const waiting = await view();
    expect(waiting.limits).toEqual({ max_parallel: 2, per_provider: {} });
    expect(waiting.usage.total).toBe(2);
    expect(Object.fromEntries(waiting.status.map((s) => [s.task, s.wait.kind]))).toEqual({
      "BE-01": "running",
      "BE-02": "running",
      "BE-03": "slot",
      "BE-04": "blocked",
    });

    // BE-01 finishes (review): BE-03 takes its slot; BE-04 waits for the human's accept.
    release("BE-01");
    await until(() => started.includes("BE-03"));
    await quiet();
    expect(await taskState("BE-01")).toBe("review");
    expect(started).toEqual(["BE-01", "BE-02", "BE-03"]);
    const after = await view();
    expect(after.queue.entries.map((e) => e.task)).toEqual(["BE-04", "BE-03", "BE-02"]);
    expect(after.status.find((s) => s.task === "BE-04")?.wait).toEqual({
      kind: "blocked",
      deps: ["BE-01"],
    });

    const accepted = await api(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "accept", task: "BE-01" }),
    });
    expect(accepted.status).toBe(200);
    await quiet();
    expect(started).not.toContain("BE-04"); // no free slot yet
    release("BE-02");
    await until(() => started.includes("BE-04"));
    release("BE-03");
    release("BE-04");
    await until(async () => (await view()).queue.entries.length === 0);
    expect(maxLive).toBe(2);
    expect(started).toEqual(["BE-01", "BE-02", "BE-03", "BE-04"]);
  });

  it("respects the per-provider limit", async () => {
    const limits = await api<{ limits: unknown }>("/settings/parallel", {
      method: "PUT",
      body: JSON.stringify({ max_parallel: 3, per_provider: { claude: 1 } }),
    });
    expect(limits.body.limits).toEqual({ max_parallel: 3, per_provider: { claude: 1 } });
    await enqueue([{ task: "BE-01" }, { task: "BE-02" }, { task: "BE-03", agent: codex }]);
    await quiet();
    expect(started.sort()).toEqual(["BE-01", "BE-03"]);
    expect((await view()).status.find((s) => s.task === "BE-02")?.wait).toEqual({
      kind: "slot",
      limit: "provider",
    });
    release("BE-01");
    await until(() => started.includes("BE-02"));
    expect(maxLive).toBe(2);
    expect(
      JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).parallel.per_provider,
    ).toEqual({ claude: 1 });
  });

  it("only runs what is queued, refuses proposals and lets the human pause, remove and clear", async () => {
    const proposal = await api(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "propose", title: "Later", group: "BE" }),
    });
    expect(proposal.status).toBe(200);
    const refused = await enqueue([{ task: "BE-05" }]);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "not_approved", task: "BE-05" } });

    await api(`/projects/${projectId}/queue/pause`, { method: "POST" });
    await enqueue([{ task: "BE-02" }, { task: "BE-03" }]);
    await quiet();
    expect(started).toEqual([]);
    expect((await view()).status.map((s) => s.wait.kind)).toEqual(["paused", "paused"]);

    const removed = await api<QueueView>(`/projects/${projectId}/queue/BE-02`, {
      method: "DELETE",
    });
    expect(removed.body.queue.entries.map((e) => e.task)).toEqual(["BE-03"]);
    await api(`/projects/${projectId}/queue/resume`, { method: "POST" });
    await until(() => started.length === 1);
    await quiet();
    expect(started).toEqual(["BE-03"]); // never BE-01, BE-02 or BE-04: they are not queued

    const cleared = await api<QueueView>(`/projects/${projectId}/queue/clear`, {
      method: "POST",
    });
    expect(cleared.body.queue.entries).toEqual([]);
  });

  it("survives a restart paused: live runs become interrupted and nothing launches", async () => {
    await enqueue(["BE-01", "BE-02", "BE-03"].map((t) => ({ task: t })));
    await quiet();
    expect(started).toEqual(["BE-01", "BE-02"]);
    const saved = JSON.parse(
      readFileSync(join(data, "projects", projectId, "queue.json"), "utf8"),
    ) as QueueFile;
    expect(saved.entries.filter((e) => e.run).map((e) => e.task)).toEqual(["BE-01", "BE-02"]);

    await daemon.close();
    gates.clear();
    started.length = 0;
    await start();
    await quiet();

    const restarted = await view();
    expect(restarted.queue.state).toBe("paused");
    expect(restarted.queue.entries.map((e) => e.task)).toEqual(["BE-01", "BE-02", "BE-03"]);
    const runs = (await api<{ runs: Run[] }>(`/projects/${projectId}/runs`)).body.runs;
    expect(runs.map((r) => r.state)).toEqual(["interrupted", "interrupted"]);
    expect(started).toEqual([]);
    expect(restarted.status.map((s) => [s.task, s.wait.kind])).toEqual([
      ["BE-01", "running"],
      ["BE-02", "running"],
      ["BE-03", "paused"],
    ]);

    // Resumed: interrupted runs hold their tasks but no slot, so BE-03 launches.
    await api(`/projects/${projectId}/queue/resume`, { method: "POST" });
    await until(() => started.includes("BE-03"));
    await quiet();
    expect(started).toEqual(["BE-03"]);
  });

  it("tells subscribers about the queue over WebSocket", async () => {
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
    const messages: { type: string; task?: string; exits?: { reason: string }[] }[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", token: daemon.token }));
    ws.send(JSON.stringify({ type: "subscribe", project: projectId }));
    await until(() => messages.some((m) => m.type === "subscribed"));

    await enqueue([{ task: "BE-01" }]);
    await until(() => messages.some((m) => m.type === "queue.launched"));
    release("BE-01");
    await until(() => messages.some((m) => m.type === "queue.exited"));
    await api("/settings/parallel", { method: "PUT", body: JSON.stringify({ max_parallel: 3 }) });
    await until(() => messages.some((m) => m.type === "queue.limits"));
    ws.close();

    expect(messages.find((m) => m.type === "queue.launched")?.task).toBe("BE-01");
    expect(messages.find((m) => m.type === "queue.exited")?.exits).toEqual([
      expect.objectContaining({ task: "BE-01", reason: "succeeded" }),
    ]);
    expect(messages.filter((m) => m.type === "queue.updated").length).toBeGreaterThanOrEqual(3);
  });

  it("rejects invalid limits", async () => {
    const res = await api<{ error: { code: string } }>("/settings/parallel", {
      method: "PUT",
      body: JSON.stringify({ max_parallel: 0 }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_settings");
  });
});
