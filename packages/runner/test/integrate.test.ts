import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRunIdGenerator, type Run, type TasksDocument } from "@konsora/core";
import { initTasks, readTasks } from "@konsora/core/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../src/git.ts";
import { IntegrationError, integrateRun, integrationMessage } from "../src/integrate.ts";
import { RunStore } from "../src/run-store.ts";
import { prepareWorktree } from "../src/worktree.ts";

const at = "2026-11-02T10:00:00Z";
const nextId = createRunIdGenerator();
let root: string;
let data: string;
let worktreesDir: string;
let store: RunStore;
let plan: TasksDocument;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();

function write(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

function document(runId?: string): TasksDocument {
  return {
    schema: "konsora/2",
    project: { name: "demo", base_branch: "main" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 1 },
    tasks: [
      {
        id: "BE-01",
        title: "Add forecast cache",
        state: "todo",
        group: "BE",
        rank: "a",
        created: { at, by: "human" },
        updated_at: at,
        ...(runId
          ? {
              state: "review" as const,
              notes: [
                {
                  id: "n1",
                  at,
                  by: "agent:claude",
                  kind: "summary" as const,
                  text: "Cache for 10 minutes.\nTested.",
                  run: runId,
                },
              ],
            }
          : {}),
      },
    ],
  };
}

/** A succeeded run of BE-01 whose branch changes `files` (committed in its worktree). */
async function succeededRun(files: Record<string, string>): Promise<Run> {
  let run = await store.create({
    id: nextId(),
    task: "BE-01",
    task_hash: `sha256:${"d".repeat(64)}`,
    agent: { provider: "claude", model: "opus", permissions: "default" },
    state: "queued",
  });
  const prepared = await prepareWorktree({
    root,
    worktreesDir,
    document: document(),
    task: "BE-01",
    runId: run.id,
    store,
  });
  for (const [file, text] of Object.entries(files)) write(prepared.worktree, file, text);
  git(prepared.worktree, "add", "-A");
  git(prepared.worktree, "commit", "-q", "--allow-empty", "-m", "agent work");
  git(prepared.worktree, "commit", "-q", "--allow-empty", "-m", "more agent work");
  await store.transition(run.id, "starting", prepared);
  await store.transition(run.id, "running");
  await store.transition(run.id, "checking");
  run = await store.transition(run.id, "succeeded", {
    head_commit: git(prepared.worktree, "rev-parse", "HEAD"),
    summary: "fallback summary",
  });
  plan = document(run.id);
  // The plan file in the main checkout says the task is in review (uncommitted, as usual).
  rmSync(join(root, ".konsora", "tasks.json"));
  const init = await initTasks(root, plan);
  if (!init.ok) throw new Error(init.error.message);
  return run;
}

async function failure(promise: Promise<unknown>): Promise<IntegrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IntegrationError) return error;
    throw error;
  }
  throw new Error("expected an IntegrationError");
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-int-")));
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-int-data-")));
  worktreesDir = join(data, "worktrees", "p-1");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  const init = await initTasks(root, document());
  if (!init.ok) throw new Error(init.error.message);
  write(root, "src/app.txt", "line 1\nline 2\nline 3\n");
  write(root, "other.txt", "other\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("integrateRun", () => {
  it("adds exactly one commit with message and trailers, then removes the worktree and branch", async () => {
    const run = await succeededRun({
      "src/app.txt": "line 1\nline 2 cached\nline 3\n",
      "src/cache.txt": "cache\n",
    });
    const before = git(root, "rev-parse", "main");

    const result = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });

    expect(result.status).toBe("merged");
    const tip = git(root, "rev-parse", "main");
    expect(result.status === "merged" && result.commit).toBe(tip);
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
    expect(git(root, "rev-parse", "main^")).toBe(before);
    expect(git(root, "log", "-1", "--format=%B", "main")).toBe(
      `BE-01: Add forecast cache\n\nCache for 10 minutes.\nTested.\n\nKonsora-Task: BE-01\nKonsora-Run: ${run.id}`,
    );
    expect(git(root, "log", "-1", "--format=%(trailers:key=Konsora-Run,valueonly)", "main")).toBe(
      run.id,
    );
    expect(git(root, "diff", "--name-only", before, "main")).toBe("src/app.txt\nsrc/cache.txt");
    // The checkout follows: the files are there and nothing is left staged or dirty but the plan.
    expect(readFileSync(join(root, "src/cache.txt"), "utf8")).toBe("cache\n");
    expect(git(root, "status", "--porcelain", "--", "src")).toBe("");
    // Worktree and branch are gone; the run is kept.
    expect(existsSync(run.worktree as string)).toBe(false);
    expect(git(root, "branch", "--list", "konsora/*")).toBe("");
    expect(await store.read(run.id)).toMatchObject({
      state: "succeeded",
      integration: { state: "merged" },
    });
    // The plan is untouched: accepting the task is the daemon's next step.
    const tasks = await readTasks(root);
    expect(tasks.ok && tasks.document.tasks[0]?.state).toBe("review");
  });

  it("keeps local changes that the run does not touch, and refuses when they clash", async () => {
    const run = await succeededRun({ "src/app.txt": "line 1\nchanged\nline 3\n" });
    write(root, "other.txt", "my local edit\n");
    write(root, "notes.local", "untracked\n");
    write(root, "src/app.txt", "my uncommitted edit\n");
    const before = git(root, "rev-parse", "main");

    const clash = await failure(
      integrateRun({ root, worktreesDir, document: plan, runId: run.id, store }),
    );
    expect(clash.code).toBe("dirty");
    expect(clash.files).toEqual(["src/app.txt"]);
    expect(clash.message).toMatch(/Commit or stash your changes to src\/app.txt/);
    expect(git(root, "rev-parse", "main")).toBe(before);
    expect(readFileSync(join(root, "src/app.txt"), "utf8")).toBe("my uncommitted edit\n");

    git(root, "checkout", "-q", "--", "src/app.txt");
    const result = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });
    expect(result.status).toBe("merged");
    expect(readFileSync(join(root, "src/app.txt"), "utf8")).toBe("line 1\nchanged\nline 3\n");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("my local edit\n");
    expect(readFileSync(join(root, "notes.local"), "utf8")).toBe("untracked\n");
    expect(git(root, "status", "--porcelain")).toContain(" M other.txt");
  });

  it("works with the base branch outside the checkout, without touching it", async () => {
    const run = await succeededRun({ "src/cache.txt": "cache\n" });
    git(root, "checkout", "-q", "-b", "elsewhere");
    write(root, "src/cache.txt", "unrelated untracked file in the checkout\n");
    const before = git(root, "rev-parse", "main");
    const head = git(root, "rev-parse", "HEAD");

    const result = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });

    expect(result.status).toBe("merged");
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
    expect(git(root, "show", "main:src/cache.txt")).toBe("cache");
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, "src/cache.txt"), "utf8")).toBe(
      "unrelated untracked file in the checkout\n",
    );
    expect(existsSync(run.worktree as string)).toBe(false);
  });

  it("merges on top of a base branch that moved, if nothing conflicts", async () => {
    const run = await succeededRun({ "src/cache.txt": "cache\n" });
    write(root, "other.txt", "moved on\n");
    git(root, "commit", "-q", "-am", "someone else");
    const before = git(root, "rev-parse", "main");
    const result = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });
    expect(result.status).toBe("merged");
    expect(git(root, "rev-parse", "main^")).toBe(before);
    expect(git(root, "show", "main:other.txt")).toBe("moved on");
    expect(git(root, "show", "main:src/cache.txt")).toBe("cache");
  });

  it("leaves a conflict as integration conflict, with the base branch and checkout untouched", async () => {
    const run = await succeededRun({ "src/app.txt": "line 1\nfrom the agent\nline 3\n" });
    write(root, "src/app.txt", "line 1\nfrom the human\nline 3\n");
    git(root, "commit", "-q", "-am", "human edit");
    const before = git(root, "rev-parse", "main");
    const status = git(root, "status", "--porcelain");

    const result = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });

    expect(result).toMatchObject({ status: "conflict", files: ["src/app.txt"] });
    expect(git(root, "rev-parse", "main")).toBe(before);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "src/app.txt"), "utf8")).toBe(
      "line 1\nfrom the human\nline 3\n",
    );
    expect(await store.read(run.id)).toMatchObject({ integration: { state: "conflict" } });
    const tasks = await readTasks(root);
    expect(tasks.ok && tasks.document.tasks[0]?.state).toBe("review");
    // The work is kept for "ask the agent to rebase" or "resolve by hand".
    expect(existsSync(run.worktree as string)).toBe(true);
    expect(git(root, "rev-parse", "--verify", run.branch as string)).toBe(run.head_commit);

    // Resolved by hand on the branch, it integrates from conflict.
    git(run.worktree as string, "merge", "-q", "main", "-X", "ours", "-m", "resolve");
    const resolved = git(run.worktree as string, "rev-parse", "HEAD");
    await store.update(run.id, { head_commit: resolved });
    const retry = await integrateRun({ root, worktreesDir, document: plan, runId: run.id, store });
    expect(retry.status).toBe("merged");
    expect(git(root, "show", "main:src/app.txt")).toBe("line 1\nfrom the agent\nline 3");
    expect(git(root, "rev-list", "--count", `${before}..main`)).toBe("1");
  });

  it("refuses runs that cannot be integrated", async () => {
    const empty = await succeededRun({});
    expect(
      (await failure(integrateRun({ root, worktreesDir, document: plan, runId: empty.id, store })))
        .code,
    ).toBe("nothing_to_integrate");
    await store.integrate(empty.id, "discarded");
    expect(
      (await failure(integrateRun({ root, worktreesDir, document: plan, runId: empty.id, store })))
        .code,
    ).toBe("not_integrable");

    const sneaky = await succeededRun({ ".konsora/extra.txt": "plan change\n" });
    expect(
      (await failure(integrateRun({ root, worktreesDir, document: plan, runId: sneaky.id, store })))
        .code,
    ).toBe("plan_changes");
  });

  it("builds the message from the task, falling back to the run's summary", () => {
    const run = {
      id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
      task: "BE-01",
      summary: "From the run.",
    } as Run;
    expect(integrationMessage(document(), run)).toBe(
      "BE-01: Add forecast cache\n\nFrom the run.\n\nKonsora-Task: BE-01\nKonsora-Run: r-01JC8Z3K2QX7M4V9T0B6N5R8PW\n",
    );
  });
});
