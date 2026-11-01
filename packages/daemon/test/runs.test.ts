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
import WebSocket from "ws";
import { type RunningDaemon, startDaemon } from "../src/server.ts";

const cliBin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const at = "2026-11-02T10:00:00Z";
let data: string;
let root: string;
let daemon: RunningDaemon;
let projectId: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();

/** The agent's own plan writes go through Konsora in run mode, like its MCP would. */
const konsora = (spec: RunSpec, ...args: string[]) =>
  execFileSync(process.execPath, [cliBin, ...args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.mcp.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

type Behaviour = "finish" | "hang" | "ask" | "noop";
let behaviour: Behaviour = "finish";
const seen: RunSpec[] = [];

/** A fake Claude: "finish" edits a file and finishes; "hang" never ends until killed. */
const fake: AgentAdapter = {
  id: "claude",
  detect: async () => ({ installed: true, version: "0.0.0" }),
  models: async () => [],
  start(spec) {
    seen.push(spec);
    const queue = new EventQueue<RunEvent>();
    let resolveExit: (exit: RunExit) => void = () => undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    let ended = false;
    const end = (exit: RunExit) => {
      if (ended) return;
      ended = true;
      queue.push({ t: "finished", ok: exit.code === 0 });
      queue.close();
      resolveExit(exit);
    };
    const mode = behaviour;
    void (async () => {
      queue.push({ t: "started", session: "s-1", model: "fake" });
      if (mode === "noop") {
        konsora(spec, "finish", "BE-01", "--summary", "Checked: nothing to change.");
      }
      if (mode === "finish") {
        writeFileSync(join(spec.cwd, "app.txt"), "from the agent\n");
        queue.push({ t: "file", path: "app.txt", change: "modify" });
        konsora(spec, "finish", "BE-01", "--summary", "Changed app.txt.");
        queue.push({ t: "message", text: "Done.", final: true });
      }
      queue.push({ t: "turn_end", ok: true });
    })();
    if (mode === "ask") {
      konsora(spec, "ask", "BE-01", "Which TTL?");
    }
    return {
      events: queue,
      exited,
      send: (text) => {
        queue.push({ t: "message", text, final: false });
        konsora(spec, "finish", "BE-01", "--summary", "Used the answer.");
        queue.push({ t: "turn_end", ok: true });
      },
      endInput: () => {
        if (mode !== "hang") end({ code: 0, signal: null });
      },
      interrupt: async () => end({ code: null, signal: "SIGINT" }),
      kill: async () => end({ code: null, signal: "SIGKILL" }),
      sessionId: () => "s-1",
    };
  },
};

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

const plan: TasksDocument = {
  schema: "konsora/2",
  project: { name: "demo", base_branch: "main", defaults: { provider: "claude", model: "fake" } },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 2 },
  tasks: [task("BE-01"), task("BE-02", { deps: ["BE-01"] })],
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

async function launch(): Promise<Run> {
  const res = await api<{ run: Run }>(`/projects/${projectId}/runs`, {
    method: "POST",
    body: JSON.stringify({ task: "be-01" }),
  });
  expect(res.status).toBe(201);
  return res.body.run;
}

async function settled(id: string): Promise<Run> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { body } = await api<{ run: Run }>(`/projects/${projectId}/runs/${id}`);
    if (!["queued", "starting", "running", "waiting_approval", "checking"].includes(body.run.state))
      return body.run;
    if (Date.now() > deadline) throw new Error(`run still ${body.run.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function taskState(id: string): Promise<string | undefined> {
  const result = await readTasks(root);
  return result.ok ? result.document.tasks.find((t) => t.id === id)?.state : undefined;
}

beforeEach(async () => {
  behaviour = "finish";
  seen.length = 0;
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-runs-data-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-runs-proj-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  const init = await initTasks(root, plan);
  if (!init.ok) throw new Error(init.error.message);
  writeFileSync(join(root, "app.txt"), "original\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  daemon = await startDaemon({ dataDir: data, adapters: { claude: fake }, interruptGraceMs: 100 });
  const res = await api<{ project: { id: string } }>("/projects", {
    method: "POST",
    body: JSON.stringify({ path: root }),
  });
  projectId = res.body.project.id;
});

afterEach(async () => {
  await daemon.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("runs over HTTP", () => {
  it("launches, lists, reads, shows the diff of and cancels runs", async () => {
    const run = await launch();
    expect(run).toMatchObject({ task: "BE-01", state: "starting" });
    // The run's MCP gets the daemon's URL and its own token, never the human's.
    expect(seen[0]?.mcp.env.KONSORA_DAEMON_URL).toBe(daemon.url);
    expect(seen[0]?.mcp.env.KONSORA_RUN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(seen[0]?.mcp)).not.toContain(daemon.token);
    expect(seen[0]?.cwd.startsWith(join(data, "worktrees", projectId))).toBe(true);

    const done = await settled(run.id);
    expect(done.state).toBe("succeeded");
    expect(await taskState("BE-01")).toBe("review");

    const list = await api<{ runs: Run[] }>(`/projects/${projectId}/runs?task=BE-01`);
    expect(list.body.runs.map((r) => r.id)).toEqual([run.id]);
    const events = await api<{ events: { t: string }[] }>(
      `/projects/${projectId}/runs/${run.id}/events`,
    );
    expect(events.body.events.map((e) => e.t)).toEqual([
      "started",
      "file",
      "message",
      "turn_end",
      "finished",
    ]);
    const diff = await api<{ diff: string }>(`/projects/${projectId}/runs/${run.id}/diff`);
    expect(diff.body.diff).toContain("+from the agent");

    // A second launch of a task that is not ready is refused with the runner's reason.
    const again = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/runs`,
      {
        method: "POST",
        body: JSON.stringify({ task: "BE-01" }),
      },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_ready");

    // Cancel a hanging run: cancelled, task back to todo.
    await api(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "send-back", task: "BE-01", feedback: "Try again." }),
    });
    behaviour = "hang";
    const hanging = await launch();
    const cancelled = await api<{ run: Run }>(`/projects/${projectId}/runs/${hanging.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.state).toBe("cancelled");
    expect(await taskState("BE-01")).toBe("todo");
    const twice = await api<{ error: { code: string } }>(
      `/projects/${projectId}/runs/${hanging.id}/cancel`,
      {
        method: "POST",
      },
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("not_active");
  });

  it("validates requests and refuses unknown runs", async () => {
    expect((await api(`/projects/${projectId}/runs`, { method: "POST", body: "{}" })).status).toBe(
      400,
    );
    expect((await api(`/projects/${projectId}/runs/r-nope`)).status).toBe(404);
    expect((await api(`/projects/${projectId}/runs/r-01JC8Z3K2QX7M4V9T0B6N5R8PW`)).status).toBe(
      404,
    );
    const blocked = await api<{ error: { code: string } }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({ task: "BE-02" }),
    });
    expect(blocked.status).toBe(409);
    expect(seen).toHaveLength(0);
  });

  it.each<[string, { authorization?: string; origin?: string }]>([
    ["without a token", { authorization: "" }],
    ["with a wrong token", { authorization: `Bearer ${"b".repeat(64)}` }],
    ["from a foreign Origin", { origin: "http://evil.example" }],
  ])("refuses run routes %s with 403", async (_, headers) => {
    for (const [method, path] of [
      ["POST", `/projects/${projectId}/runs`],
      ["GET", `/projects/${projectId}/runs`],
      ["GET", `/projects/${projectId}/runs/r-01JC8Z3K2QX7M4V9T0B6N5R8PW/diff`],
      ["POST", `/projects/${projectId}/runs/r-01JC8Z3K2QX7M4V9T0B6N5R8PW/cancel`],
    ] as const) {
      const clean: Record<string, string> = { "content-type": "application/json" };
      if (headers.origin) clean.origin = headers.origin;
      if (headers.authorization) clean.authorization = headers.authorization;
      if (!("authorization" in headers)) clean.authorization = `Bearer ${daemon.token}`;
      const res = await fetch(`${daemon.url}/api${path}`, {
        method,
        headers: clean,
        ...(method === "POST" ? { body: JSON.stringify({ task: "BE-01" }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("run events over WebSocket", () => {
  it("sends run.event in order, and run.state, to the project's subscribers", async () => {
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
    const messages: { type: string; run?: unknown; event?: { t: string } }[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", token: daemon.token }));
    ws.send(JSON.stringify({ type: "subscribe", project: projectId }));
    const deadline = Date.now() + 3000;
    while (!messages.some((m) => m.type === "subscribed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const run = await launch();
    await settled(run.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();

    const events = messages.filter((m) => m.type === "run.event");
    expect(events.map((m) => m.event?.t)).toEqual([
      "started",
      "file",
      "message",
      "turn_end",
      "finished",
    ]);
    expect(events.every((m) => m.run === run.id)).toBe(true);
    const states = messages.filter((m) => m.type === "run.state").map((m) => (m.run as Run).state);
    expect(states[0]).toBe("queued");
    expect(states).toEqual(
      expect.arrayContaining(["starting", "running", "checking", "succeeded"]),
    );
    expect(states.at(-1)).toBe("succeeded");
  });
});

describe("accept integrates the run", () => {
  it("leaves exactly one new commit and marks the task done", async () => {
    const run = await settled((await launch()).id);
    const before = git(root, "rev-parse", "main");
    const res = await api<{ ok: boolean; integrated: { run: string; commit: string } }>(
      `/projects/${projectId}/ops`,
      { method: "POST", body: JSON.stringify({ op: "accept", task: "BE-01" }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.integrated.run).toBe(run.id);
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
    expect(res.body.integrated.commit).toBe(git(root, "rev-parse", "main"));
    expect(git(root, "log", "-1", "--format=%s", "main")).toBe("BE-01: Task BE-01");
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("from the agent\n");
    expect(await taskState("BE-01")).toBe("done");
    const after = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`);
    expect(after.body.run.integration).toEqual({ state: "merged" });
  });

  it("accepts a run that changed nothing without a commit, discarding its worktree", async () => {
    behaviour = "noop";
    const run = await settled((await launch()).id);
    expect(run.state).toBe("succeeded");
    const before = git(root, "rev-parse", "main");
    const res = await api<{ ok: boolean; discarded: string; integrated?: unknown }>(
      `/projects/${projectId}/ops`,
      { method: "POST", body: JSON.stringify({ op: "accept", task: "BE-01" }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(run.id);
    expect(res.body.integrated).toBeUndefined();
    expect(git(root, "rev-parse", "main")).toBe(before);
    expect(await taskState("BE-01")).toBe("done");
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    const after = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`);
    expect(after.body.run.integration).toEqual({ state: "discarded" });
  });

  it("answers 409 on a conflict and keeps the task in review", async () => {
    const run = await settled((await launch()).id);
    writeFileSync(join(root, "app.txt"), "from the human\n");
    git(root, "commit", "-q", "-m", "human", "--", "app.txt");
    const before = git(root, "rev-parse", "main");

    const res = await api<{ error: { code: string; files: string[]; message: string } }>(
      `/projects/${projectId}/ops`,
      { method: "POST", body: JSON.stringify({ op: "accept", task: "BE-01" }) },
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("integration_conflict");
    expect(res.body.error.files).toEqual(["app.txt"]);
    expect(res.body.error.message).toMatch(/stays in review/);
    expect(git(root, "rev-parse", "main")).toBe(before);
    expect(await taskState("BE-01")).toBe("review");
    const after = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`);
    expect(after.body.run.integration).toEqual({ state: "conflict" });
  });
});

describe("discarding runs", () => {
  it("discards a cancelled run: worktree and branch go, the run and its diff stay", async () => {
    behaviour = "hang";
    const run = await launch();
    const cancelled = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}/cancel`, {
      method: "POST",
    });
    const worktree = cancelled.body.run.worktree as string;
    expect(existsSync(worktree)).toBe(true);
    expect(git(root, "branch", "--list", "konsora/*")).not.toBe("");

    const res = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}/discard`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ state: "cancelled", integration: { state: "discarded" } });
    expect(existsSync(worktree)).toBe(false);
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    const kept = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`);
    expect(kept.status).toBe(200);
    const diff = await api<{ diff: string | null }>(`/projects/${projectId}/runs/${run.id}/diff`);
    expect(diff.body.diff).not.toBeNull();

    const again = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/runs/${run.id}/discard`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "not_discardable" });
    expect(again.body.error.message).toMatch(/already discarded/);
  });

  it("refuses to discard an active or an integrated run", async () => {
    behaviour = "hang";
    const live = await launch();
    const active = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/runs/${live.id}/discard`,
      { method: "POST" },
    );
    expect(active.status).toBe(409);
    expect(active.body.error.message).toMatch(/cancel it before discarding/);
    await api(`/projects/${projectId}/runs/${live.id}/cancel`, { method: "POST" });

    behaviour = "finish";
    const done = await settled((await launch()).id);
    await api(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "accept", task: "BE-01" }),
    });
    const merged = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/runs/${done.id}/discard`,
      { method: "POST" },
    );
    expect(merged.status).toBe(409);
    expect(merged.body.error.message).toMatch(/already merged/);
  });

  it("lists orphan worktrees and branches without deleting them", async () => {
    git(root, "branch", "konsora/BE-09/ORPHAN", "main");
    const res = await api<{ orphans: { branch?: string; reason: string }[] }>(
      `/projects/${projectId}/worktrees/orphans`,
    );
    expect(res.body.orphans).toEqual([{ branch: "konsora/BE-09/ORPHAN", reason: "no_run" }]);
    expect(git(root, "branch", "--list", "konsora/*")).toContain("konsora/BE-09/ORPHAN");
  });
});

describe("answers and approvals", () => {
  it("delivers the human's answer to the run that asked", async () => {
    behaviour = "ask";
    const run = await launch();
    const res = await api(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "answer", task: "BE-01", text: "Ten minutes." }),
    });
    expect(res.status).toBe(200);
    const done = await settled(run.id);
    expect(done.state).toBe("succeeded");
    const events = await api<{ events: { t: string; text?: string; delivery?: string }[] }>(
      `/projects/${projectId}/runs/${run.id}/events`,
    );
    const answer = events.body.events.find((e) => e.t === "answer");
    expect(answer?.delivery).toBe("stdin");
    expect(answer?.text).toContain("> Ten minutes.");
  });

  it("moves a run to waiting_approval while one of its approvals is pending", async () => {
    behaviour = "hang";
    const run = await launch();
    const state = async () =>
      (await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`)).body.run.state;
    const until = async (want: string) => {
      const deadline = Date.now() + 3000;
      while ((await state()) !== want && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return state();
    };
    expect(await until("running")).toBe("running");
    const asked = daemon.approvals.request(
      { run: run.id, project: projectId, task: "BE-01" },
      { tool_name: "Bash", input: { command: "rm -rf build" } },
      5000,
    );
    expect(await until("waiting_approval")).toBe("waiting_approval");
    const pending = daemon.approvals.pending()[0];
    daemon.approvals.decide(run.id, pending?.id as string, { behavior: "allow" });
    await asked;
    expect(await until("running")).toBe("running");
    await api(`/projects/${projectId}/runs/${run.id}/cancel`, { method: "POST" });
  });
});

describe("daemon start-up", () => {
  it("marks runs that were alive as interrupted, without relaunching them", async () => {
    behaviour = "hang";
    const run = await launch();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await daemon.close();
    // A new daemon on the same data dir (the old process's agent would be gone too).
    const count = seen.length;
    daemon = await startDaemon({ dataDir: data, adapters: { claude: fake } });
    const res = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}`);
    expect(res.body.run.state).toBe("interrupted");
    expect(seen).toHaveLength(count);
  });
});
