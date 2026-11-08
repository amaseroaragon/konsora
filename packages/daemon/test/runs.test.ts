import { execFile, execFileSync } from "node:child_process";
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
import { promisify } from "node:util";
import { applyOp, type Op, type Run, type Task, type TasksDocument } from "@konsora/core";
import { initTasks, readTasks } from "@konsora/core/store";
import {
  type AgentAdapter,
  EventQueue,
  gitEnv,
  type PermissionDecision,
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

type Behaviour =
  | "finish"
  | "hang"
  | "ask"
  | "noop"
  | "permission"
  | "limits"
  | "rebase"
  | "rebase-stop";
let behaviour: Behaviour = "finish";
const seen: RunSpec[] = [];
/** What the fake was told about its approval requests ("permission" behaviour). */
const decisions: ({ id: string } & PermissionDecision)[] = [];

/** A fake Claude: "finish" edits a file and finishes; "hang" never ends until killed. */
const fake: AgentAdapter = {
  id: "claude",
  detect: async () => ({ installed: true, version: "0.0.0" }),
  models: async () => [{ id: "fake", label: "Fake", efforts: ["low", "high"] }],
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
      if (mode === "ask") await konsora(spec, "ask", "BE-01", "Which TTL?");
      if (mode === "permission") {
        // Like Codex: it asks through its own protocol and waits for the decision.
        queue.push({
          t: "permission",
          id: "codex-1",
          tool: "shell",
          detail: "git push",
          input: { command: "git push", cwd: spec.cwd },
        });
        return;
      }
      if (mode === "noop") {
        await konsora(spec, "finish", "BE-01", "--summary", "Checked: nothing to change.");
      }
      if (mode === "limits") {
        queue.push({
          t: "usage",
          input_tokens: 10,
          output_tokens: 2,
          rate_limits: {
            status: "allowed",
            windows: [{ window: "five_hour", utilization: 0.4, resets_at: 1794011580 }],
          },
        });
        await konsora(spec, "finish", "BE-01", "--summary", "Reported usage.");
      }
      if (mode === "rebase" || mode === "rebase-stop") {
        // Rebase onto the tip named in the prompt and keep both sides of the conflict.
        const onto = /git rebase ([0-9a-f]{40})/.exec(spec.prompt)?.[1] as string;
        try {
          execFileSync("git", ["rebase", onto], { cwd: spec.cwd, env: gitEnv(), stdio: "pipe" });
        } catch {
          writeFileSync(join(spec.cwd, "app.txt"), "from the human\nfrom the agent\n");
          execFileSync("git", ["add", "app.txt"], { cwd: spec.cwd, env: gitEnv() });
          execFileSync("git", ["rebase", "--continue"], {
            cwd: spec.cwd,
            env: { ...gitEnv(), GIT_EDITOR: "true" },
            stdio: "pipe",
          });
        }
        if (mode === "rebase") await konsora(spec, "finish", "BE-01", "--summary", "Rebased.");
      }
      if (mode === "finish") {
        const author = spec.agent.provider === "codex" ? "codex" : "the agent";
        writeFileSync(join(spec.cwd, "app.txt"), `from ${author}\n`);
        queue.push({ t: "file", path: "app.txt", change: "modify" });
        await konsora(spec, "finish", "BE-01", "--summary", "Changed app.txt.");
        queue.push({ t: "message", text: "Done.", final: true });
      }
      queue.push({ t: "turn_end", ok: true });
    })();
    return {
      events: queue,
      exited,
      send: (text) => {
        queue.push({ t: "message", text, final: false });
        void konsora(spec, "finish", "BE-01", "--summary", "Used the answer.").then(() =>
          queue.push({ t: "turn_end", ok: true }),
        );
      },
      endInput: () => {
        if (mode !== "hang") end({ code: 0, signal: null });
      },
      answerPermission: (id, decision) => {
        decisions.push({ id, ...decision });
        if (decision.behavior !== "allow") return;
        queue.push({ t: "tool", phase: "end", name: "shell", summary: "pushed", ok: true });
        void konsora(spec, "finish", "BE-01", "--summary", "Pushed after approval.").then(() =>
          queue.push({ t: "turn_end", ok: true }),
        );
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

/** Waits until the agent's question is in the plan (the fake agent asks asynchronously). */
async function asked(id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await readTasks(root);
    const notes = result.ok ? result.document.tasks.find((t) => t.id === id)?.notes : undefined;
    if (notes?.some((n) => n.kind === "question")) return;
    if (Date.now() > deadline) throw new Error(`${id} has no question`);
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
  decisions.length = 0;
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

describe("checks over HTTP and WebSocket (DMN-07)", () => {
  const setChecks = {
    op: "set-checks",
    checks: [
      { id: "app", run: "grep -q agent app.txt" },
      { id: "boom", run: "echo boom; exit 1" },
    ],
    check_retries: 1,
  };

  it("sets the project's checks through /ops, and only as a human", async () => {
    const res = await api<{ ok: boolean }>(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify(setChecks),
    });
    expect(res.status).toBe(200);
    const after = await readTasks(root);
    expect(after.ok && after.document.project).toMatchObject({
      checks: setChecks.checks,
      check_retries: 1,
    });
    const bad = await api<{ error: { code: string } }>(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "set-checks", check_retries: 9 }),
    });
    expect(bad.status).toBe(400);
    // The same op from an agent (CLI or MCP apply it with the agent's role) is forbidden.
    if (!after.ok) throw new Error("plan");
    const asAgent = applyOp(after.document, setChecks as Op, { actor: "agent:claude", at });
    expect(asAgent.ok ? "ok" : asAgent.error.code).toBe("forbidden");
  });

  it("sends each check's start and end and checking ↔ running live, and serves checks.json", async () => {
    await api(`/projects/${projectId}/ops`, { method: "POST", body: JSON.stringify(setChecks) });
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
    const messages: {
      type: string;
      run?: unknown;
      event?: { t: string; phase?: string; id?: string };
    }[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", token: daemon.token }));
    ws.send(JSON.stringify({ type: "subscribe", project: projectId }));
    const deadline = Date.now() + 3000;
    while (!messages.some((m) => m.type === "subscribed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const run = await settled((await launch()).id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();

    const checks = messages
      .filter((m) => m.type === "run.event" && m.event?.t === "check")
      .map((m) => `${m.event?.phase}:${m.event?.id}`);
    // Two attempts (one retry), each with both checks.
    expect(checks).toEqual([
      "start:app",
      "end:app",
      "start:boom",
      "end:boom",
      "start:app",
      "end:app",
      "start:boom",
      "end:boom",
    ]);
    const states = messages
      .filter((m) => m.type === "run.state")
      .map((m) => (m.run as Run).state)
      .filter((state, i, all) => state !== all[i - 1]);
    expect(states).toEqual(
      expect.arrayContaining(["running", "checking", "running", "checking", "succeeded"]),
    );
    const i = states.indexOf("checking");
    expect(states.slice(i, i + 3)).toEqual(["checking", "running", "checking"]);

    const res = await api<{ checks: { run: string; attempts: { results: unknown[] }[] } }>(
      `/projects/${projectId}/runs/${run.id}/checks`,
    );
    expect(res.status).toBe(200);
    expect(res.body.checks.run).toBe(run.id);
    expect(res.body.checks.attempts).toHaveLength(2);
    expect(res.body.checks.attempts[1]?.results).toEqual([
      expect.objectContaining({ id: "app", source: "project", exit_code: 0, output: "" }),
      expect.objectContaining({
        id: "boom",
        command: "echo boom; exit 1",
        exit_code: 1,
        timed_out: false,
        output: "boom\n",
      }),
    ]);
    expect(await taskState("BE-01")).toBe("review");
  });

  it("answers null before the checks ran, and 404 for an unknown run", async () => {
    behaviour = "hang";
    const run = await launch();
    const res = await api<{ checks: null }>(`/projects/${projectId}/runs/${run.id}/checks`);
    expect(res.body.checks).toBeNull();
    await api(`/projects/${projectId}/runs/${run.id}/cancel`, { method: "POST" });
    const missing = await api(`/projects/${projectId}/runs/r-01JC8Z3K2QX7M4V9T0B6N5R8PW/checks`);
    expect(missing.status).toBe(404);
  });
});

describe("rate limits (DMN-06)", () => {
  it("a run's usage reaches GET /api/limits and every client as limits.updated", async () => {
    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
    const messages: { type: string; limits?: { provider: string; source: string }[] }[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ws.once("open", resolve));
    // Authenticated but not subscribed to any project: limits describe the account.
    ws.send(JSON.stringify({ type: "auth", token: daemon.token }));
    const before = await api<{ limits: { provider: string; source: string }[] }>("/limits");
    expect(before.body.limits).toEqual([
      {
        provider: "claude",
        source: "none",
        windows: [],
        unavailable: "This provider has no way to read its limits without a run",
      },
    ]);

    behaviour = "limits";
    const run = await settled((await launch()).id);
    const deadline = Date.now() + 3000;
    while (!messages.some((m) => m.limits?.[0]?.source === "run") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    ws.close();
    const update = messages.findLast((m) => m.type === "limits.updated");
    expect(update?.limits?.[0]).toMatchObject({ provider: "claude", source: "run", run: run.id });

    const after = await api<{ limits: unknown[] }>("/limits");
    expect(after.body.limits).toEqual([
      expect.objectContaining({
        provider: "claude",
        source: "run",
        run: run.id,
        at: expect.stringMatching(/Z$/),
        windows: [{ window: "five_hour", utilization: 0.4, resets_at: "2026-11-07T00:33:00Z" }],
      }),
    ]);
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
    await asked("BE-01");
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

describe("approvals asked through the agent's protocol (Codex)", () => {
  type Pending = { id: string; run: string; tool: string; input: Record<string, unknown> };
  const pendingFor = async (run: string) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const { body } = await api<{ approvals: Pending[] }>("/approvals");
      const mine = body.approvals.filter((a) => a.run === run);
      if (mine.length > 0 || Date.now() > deadline) return mine;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const stateOf = async (run: string) =>
    (await api<{ run: Run }>(`/projects/${projectId}/runs/${run}`)).body.run.state;

  it("shows the request in GET /api/approvals with the run waiting, and delivers the decision", async () => {
    behaviour = "permission";
    const run = await launch();
    const [pending] = await pendingFor(run.id);
    expect(pending).toMatchObject({ tool: "shell", input: { command: "git push" } });
    expect(await stateOf(run.id)).toBe("waiting_approval");

    const res = await api(`/runs/${run.id}/permissions/${pending?.id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(200);
    const done = await settled(run.id);
    expect(decisions).toEqual([{ id: "codex-1", behavior: "allow" }]);
    expect(done.state).toBe("succeeded");
    const events = await api<{ events: { t: string; state?: string }[] }>(
      `/projects/${projectId}/runs/${run.id}/events`,
    );
    expect(events.body.events.map((e) => e.t)).toContain("permission_decision");
  });

  it("passes a denial back to the agent and the run goes back to running", async () => {
    behaviour = "permission";
    const run = await launch();
    const [pending] = await pendingFor(run.id);
    await api(`/runs/${run.id}/permissions/${pending?.id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "deny", message: "Not now." }),
    });
    const deadline = Date.now() + 3000;
    while (decisions.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(decisions).toEqual([{ id: "codex-1", behavior: "deny", message: "Not now." }]);
    const until = Date.now() + 3000;
    while ((await stateOf(run.id)) !== "running" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await stateOf(run.id)).toBe("running");
    await api(`/projects/${projectId}/runs/${run.id}/cancel`, { method: "POST" });
  });

  it("denies a pending request when the run is cancelled", async () => {
    behaviour = "permission";
    const run = await launch();
    expect(await pendingFor(run.id)).toHaveLength(1);
    await api(`/projects/${projectId}/runs/${run.id}/cancel`, { method: "POST" });
    expect((await settled(run.id)).state).toBe("cancelled");
    expect(decisions).toEqual([{ id: "codex-1", behavior: "deny", message: "The run has ended." }]);
    expect((await api<{ approvals: Pending[] }>("/approvals")).body.approvals).toEqual([]);
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

  it("resumes an interrupted run on request, in its session, and refuses it twice (RUN-27)", async () => {
    behaviour = "hang";
    const run = await launch();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await daemon.close();
    daemon = await startDaemon({ dataDir: data, adapters: { claude: fake } });
    behaviour = "finish";
    const count = seen.length;

    const res = await api<{ run: Run }>(`/projects/${projectId}/runs/${run.id}/resume`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: run.id, state: "starting" });
    const done = await settled(run.id);
    expect(done.state).toBe("succeeded");
    expect(await taskState("BE-01")).toBe("review");
    expect(seen).toHaveLength(count + 1);
    expect(seen.at(-1)).toMatchObject({ cwd: run.worktree, resume: "s-1" });
    expect((await api<{ runs: Run[] }>(`/projects/${projectId}/runs`)).body.runs).toHaveLength(1);

    const again = await api<{ error: { code: string } }>(
      `/projects/${projectId}/runs/${run.id}/resume`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_resumable");
  });
});

describe("the agent catalog", () => {
  const codexFake = (installed: boolean): AgentAdapter => ({
    ...fake,
    id: "codex",
    profiles: ["default"],
    detect: async () =>
      installed
        ? {
            installed: true,
            version: "0.166.0",
            expected_version: "0.166.0",
            version_matches: true,
            transport: "app-server",
          }
        : { installed: false },
    models: async () => [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high"] },
    ],
  });

  async function restart(codexInstalled: boolean) {
    await daemon.close();
    daemon = await startDaemon({
      dataDir: data,
      adapters: { claude: { ...fake, openModels: false }, codex: codexFake(codexInstalled) },
    });
  }

  type Entry = { provider: string; installed: boolean; models: unknown[]; profiles: string[] };

  it("lists Claude and Codex with version, models, efforts and profiles", async () => {
    await restart(true);
    const res = await api<{ agents: Entry[] }>("/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([
      {
        provider: "claude",
        installed: true,
        version: "0.0.0",
        models: [{ id: "fake", label: "Fake", efforts: ["low", "high"] }],
        open_models: false,
        profiles: ["default"],
      },
      {
        provider: "codex",
        installed: true,
        version: "0.166.0",
        expected_version: "0.166.0",
        version_matches: true,
        transport: "app-server",
        models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high"] }],
        open_models: false,
        profiles: ["default"],
      },
    ]);
  });

  it.each([
    [
      "a model it does not declare",
      true,
      { provider: "claude", model: "opus" },
      /no model "opus"; use "fake"/,
    ],
    [
      "an effort the model does not take",
      true,
      { provider: "codex", model: "gpt-6-luna", effort: "max" },
      /does not take effort "max"; use "low", "medium", "high" or none/,
    ],
    [
      "a profile it does not implement",
      true,
      { provider: "codex", model: "gpt-6-luna", permissions: "trusted" },
      /no permission profile "trusted"; use "default"/,
    ],
    [
      "a provider that is not installed",
      false,
      { provider: "codex", model: "gpt-6-luna" },
      /codex is not installed/,
    ],
  ])("refuses to launch with %s (422) and creates no run", async (_, installed, agent, reason) => {
    await restart(installed);
    const res = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/runs`,
      { method: "POST", body: JSON.stringify({ task: "BE-01", agent }) },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_agent");
    expect(res.body.error.message).toMatch(reason);
    const runs = await api<{ runs: Run[] }>(`/projects/${projectId}/runs`);
    expect(runs.body.runs).toEqual([]);
    expect(await taskState("BE-01")).toBe("todo");
  });

  it("launches with an agent the catalog declares", async () => {
    await restart(true);
    const res = await api<{ run: Run }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        task: "BE-01",
        agent: { provider: "claude", model: "fake", effort: "high" },
      }),
    });
    expect(res.status).toBe(201);
    expect((await settled(res.body.run.id)).state).toBe("succeeded");
  });
});

describe("asking the agent to rebase a conflict (RUN-24)", () => {
  async function conflict(): Promise<Run> {
    const run = await settled((await launch()).id);
    writeFileSync(join(root, "app.txt"), "from the human\n");
    git(root, "commit", "-q", "-m", "human", "--", "app.txt");
    const res = await api<{ error: { code: string } }>(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "accept", task: "BE-01" }),
    });
    expect(res.body.error.code).toBe("integration_conflict");
    return run;
  }

  it("rebases in a new run on the same branch, and accept then integrates it", async () => {
    const conflicted = await conflict();
    behaviour = "rebase";
    const res = await api<{ run: Run }>(`/projects/${projectId}/runs/${conflicted.id}/rebase`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    expect(res.body.run).toMatchObject({ rebase_of: conflicted.id, branch: conflicted.branch });
    const rebased = await settled(res.body.run.id);
    expect(rebased.state).toBe("succeeded");
    expect(seen.at(-1)?.prompt).toContain("- `app.txt`");
    expect(await taskState("BE-01")).toBe("review");

    const before = git(root, "rev-parse", "main");
    const accepted = await api<{ integrated: { run: string } }>(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "accept", task: "BE-01" }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.integrated.run).toBe(rebased.id);
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("from the human\nfrom the agent\n");
    const old = await api<{ run: Run }>(`/projects/${projectId}/runs/${conflicted.id}`);
    expect(old.body.run.integration).toEqual({ state: "discarded" });
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
  });

  it("after a failed rebase the conflict is still there, and discarding the rebase keeps its branch", async () => {
    const conflicted = await conflict();
    behaviour = "rebase-stop";
    const res = await api<{ run: Run }>(`/projects/${projectId}/runs/${conflicted.id}/rebase`, {
      method: "POST",
    });
    const failed = await settled(res.body.run.id);
    expect(failed.state).toBe("failed");
    expect(await taskState("BE-01")).toBe("review");

    const accept = await api<{ error: { code: string; run: string } }>(
      `/projects/${projectId}/ops`,
      { method: "POST", body: JSON.stringify({ op: "accept", task: "BE-01" }) },
    );
    expect(accept.body.error).toMatchObject({ code: "integration_conflict", run: conflicted.id });

    await api(`/projects/${projectId}/runs/${failed.id}/discard`, { method: "POST" });
    expect(existsSync(conflicted.worktree as string)).toBe(true);
    expect(git(root, "branch", "--list", "konsora/*")).not.toBe("");
  });

  it("refuses to rebase a run that is not in conflict", async () => {
    const run = await settled((await launch()).id);
    const res = await api<{ error: { code: string } }>(
      `/projects/${projectId}/runs/${run.id}/rebase`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_rebasable");
  });
});

describe("variants of a task (RUN-28)", () => {
  const codexFake: AgentAdapter = { ...fake, id: "codex" };
  const agents = [
    { provider: "claude", model: "fake" },
    { provider: "codex", model: "fake" },
  ];

  async function withCodex(): Promise<void> {
    await daemon.close();
    daemon = await startDaemon({
      dataDir: data,
      adapters: { claude: fake, codex: codexFake },
      interruptGraceMs: 100,
    });
  }

  /** The group settles the task right after its last variant closes. */
  async function taskBecomes(state: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while ((await taskState("BE-01")) !== state) {
      if (Date.now() > deadline) throw new Error(`BE-01 never became ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function launchVariants(): Promise<Run[]> {
    const res = await api<{ runs: Run[] }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({ task: "BE-01", agents }),
    });
    expect(res.status).toBe(201);
    return res.body.runs;
  }

  it("runs two agents in separate worktrees and the task reaches review with both", async () => {
    await withCodex();
    const [a, b] = (await launchVariants()) as [Run, Run];
    expect(a.variant_of).toBe(a.id);
    expect(b.variant_of).toBe(a.id);
    expect([a.agent.provider, b.agent.provider]).toEqual(["claude", "codex"]);
    expect(a.worktree).not.toBe(b.worktree);
    const done = [await settled(a.id), await settled(b.id)];
    expect(done.map((r) => r.state)).toEqual(["succeeded", "succeeded"]);
    await taskBecomes("review");
    expect(readFileSync(join(a.worktree as string, "app.txt"), "utf8")).toBe("from the agent\n");
    expect(readFileSync(join(b.worktree as string, "app.txt"), "utf8")).toBe("from codex\n");
  });

  it("choosing one and accepting leaves one commit with its work and removes both worktrees", async () => {
    await withCodex();
    const [a, b] = (await launchVariants()) as [Run, Run];
    await settled(a.id);
    await settled(b.id);
    await taskBecomes("review");
    const head = git(root, "rev-parse", "main");

    const early = await api<{ error: { code: string; message: string } }>(
      `/projects/${projectId}/ops`,
      { method: "POST", body: JSON.stringify({ op: "accept", task: "BE-01" }) },
    );
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("variant_not_chosen");
    expect(await taskState("BE-01")).toBe("review");

    const chosen = await api<{ run: Run }>(`/projects/${projectId}/runs/${b.id}/choose`, {
      method: "POST",
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.run.integration).toEqual({ state: "pending" });
    const loser = (await api<{ run: Run }>(`/projects/${projectId}/runs/${a.id}`)).body.run;
    expect(loser.integration).toEqual({ state: "discarded" });
    expect(existsSync(a.worktree as string)).toBe(false);
    expect(
      (await api<{ diff: string }>(`/projects/${projectId}/runs/${a.id}/diff`)).body.diff,
    ).toContain("+from the agent");

    const accepted = await api<{ integrated: { run: string } }>(`/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "accept", task: "BE-01" }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.integrated.run).toBe(b.id);
    expect(git(root, "rev-list", "--count", `${head}..main`)).toBe("1");
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("from codex\n");
    expect(existsSync(b.worktree as string)).toBe(false);
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    expect(await taskState("BE-01")).toBe("done");
  });

  it("refuses variants that do not fit in max_parallel, creating nothing", async () => {
    await withCodex();
    await api("/settings/parallel", { method: "PUT", body: JSON.stringify({ max_parallel: 1 }) });
    const res = await api<{ error: { code: string } }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({ task: "BE-01", agents }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_slots");
    expect((await api<{ runs: Run[] }>(`/projects/${projectId}/runs`)).body.runs).toEqual([]);
    const one = await api(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({ task: "BE-01", agents: [agents[0]] }),
    });
    expect(one.status).toBe(400);
  });
});
