import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunIdGenerator, type Run, type Task, type TasksDocument } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Git, gitEnv, systemGit } from "../src/git.ts";
import { RunStore } from "../src/run-store.ts";
import {
  branchFor,
  findOrphanWorktrees,
  prepareWorktree,
  removeWorktree,
  runGitWritePaths,
  WorktreeError,
} from "../src/worktree.ts";

const at = "2026-11-02T10:00:00Z";
const nextId = createRunIdGenerator();
let root: string;
let data: string;
let worktreesDir: string;
let store: RunStore;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: gitEnv(), encoding: "utf8" }).trim();
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

function doc(...tasks: Task[]): TasksDocument {
  return {
    schema: "konsora/2",
    project: { name: "P", base_branch: "main" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 9 },
    tasks,
  };
}

const plan = doc(
  task("BE-01"),
  task("BE-02", { deps: ["BE-03"] }),
  task("BE-03"),
  task("BE-04", { state: "doing" }),
);

async function queued(taskId: string): Promise<Run> {
  return store.create({
    id: nextId(),
    task: taskId,
    task_hash: `sha256:${"c".repeat(64)}`,
    agent: { provider: "claude", model: "opus", permissions: "default" },
    state: "queued",
  });
}

async function failure(promise: Promise<unknown>): Promise<WorktreeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorktreeError) return error;
    throw error;
  }
  throw new Error("expected a WorktreeError");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "konsora-repo-")));
  data = realpathSync(mkdtempSync(join(tmpdir(), "konsora-data-")));
  worktreesDir = join(data, "worktrees", "p-123");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, ".konsora"));
  writeFileSync(join(root, ".konsora", ".gitignore"), "runs/\n");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "a.txt"), "feature\n");
  git("commit", "-q", "-am", "feature work");
  store = new RunStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe("prepareWorktree", () => {
  it("creates the worktree and branch from the base branch head without touching the checkout", async () => {
    writeFileSync(join(root, "a.txt"), "uncommitted\n");
    const statusBefore = git("status", "--porcelain");
    const headBefore = git("rev-parse", "HEAD");
    const mainHead = git("rev-parse", "main");
    const run = await queued("BE-01");

    const prepared = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-01",
      runId: run.id,
      store,
    });

    expect(prepared.base_commit).toBe(mainHead);
    expect(prepared.branch).toBe(branchFor("BE-01", run.id));
    expect(prepared.branch).toMatch(/^konsora\/BE-01\/[0-9A-Z]{12}$/);
    expect(prepared.worktree).toBe(join(worktreesDir, `BE-01-${run.id.slice(2, 14)}`));
    expect(git("rev-parse", prepared.branch)).toBe(mainHead);
    expect(readFileSync(join(prepared.worktree, "a.txt"), "utf8")).toBe("one\n");
    expect(git("-C", prepared.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(prepared.branch);
    // Private: the worktrees folder and the worktree's new files are the user's only.
    expect(statSync(worktreesDir).mode & 0o077).toBe(0);
    expect(statSync(join(prepared.worktree, "a.txt")).mode & 0o077).toBe(0);
    // The main checkout is exactly as it was.
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(git("status", "--porcelain")).toBe(statusBefore);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it.each([
    ["a task that does not exist", "BE-09", "not_found", /does not exist/],
    ["a blocked task", "BE-02", "not_ready", /blocked by BE-03/],
    ["a task already in progress", "BE-04", "not_ready", /BE-04 is doing/],
  ])("rejects %s with an actionable error", async (_, taskId, code, message) => {
    const error = await failure(
      prepareWorktree({ root, worktreesDir, document: plan, task: taskId, runId: nextId(), store }),
    );
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(existsSync(worktreesDir)).toBe(false);
  });

  it("rejects a task that has another active run", async () => {
    const first = await queued("BE-01");
    const error = await failure(
      prepareWorktree({
        root,
        worktreesDir,
        document: plan,
        task: "BE-01",
        runId: nextId(),
        store,
      }),
    );
    expect(error.code).toBe("active_run");
    expect(error.message).toContain(first.id);
    expect(error.message).toMatch(/cancel it/);
  });

  it("rejects a missing base branch and an existing branch", async () => {
    const missing = { ...plan, project: { ...plan.project, base_branch: "trunk" } };
    const run = await queued("BE-01");
    const error = await failure(
      prepareWorktree({
        root,
        worktreesDir,
        document: missing,
        task: "BE-01",
        runId: run.id,
        store,
      }),
    );
    expect(error.code).toBe("base_branch_missing");
    expect(error.message).toMatch(/project\.base_branch/);

    git("branch", branchFor("BE-01", run.id), "main");
    const taken = await failure(
      prepareWorktree({ root, worktreesDir, document: plan, task: "BE-01", runId: run.id, store }),
    );
    expect(taken.code).toBe("branch_exists");
  });

  it("cleans up when git fails", async () => {
    const run = await queued("BE-01");
    const failing: Git = {
      run: (args, options) =>
        args[0] === "worktree" && args[1] === "add"
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: boom" })
          : systemGit.run(args, options),
    };
    const error = await failure(
      prepareWorktree({
        root,
        worktreesDir,
        document: plan,
        task: "BE-01",
        runId: run.id,
        store,
        git: failing,
      }),
    );
    expect(error.code).toBe("git_failed");
    expect(error.detail).toContain("boom");
    expect(git("branch", "--list", "konsora/*")).toBe("");
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and the branch, and is idempotent", async () => {
    const run = await queued("BE-01");
    const prepared = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-01",
      runId: run.id,
      store,
    });
    writeFileSync(join(prepared.worktree, "dirty.txt"), "agent work\n");

    const input = { root, worktreesDir, worktree: prepared.worktree, branch: prepared.branch };
    expect(await removeWorktree(input)).toEqual({ worktree: true, branch: true });
    expect(existsSync(prepared.worktree)).toBe(false);
    expect(git("branch", "--list", "konsora/*")).toBe("");
    expect(git("worktree", "list", "--porcelain")).not.toContain(prepared.worktree);

    expect(await removeWorktree(input)).toEqual({ worktree: false, branch: false });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  it("refuses paths outside the worktrees folder and non-Konsora branches", async () => {
    const outside = await failure(
      removeWorktree({ root, worktreesDir, worktree: root, branch: "konsora/BE-01/X" }),
    );
    expect(outside.code).toBe("unsafe_path");
    const parent = await failure(
      removeWorktree({
        root,
        worktreesDir,
        worktree: join(worktreesDir, ".."),
        branch: "konsora/BE-01/X",
      }),
    );
    expect(parent.code).toBe("unsafe_path");
    const branch = await failure(
      removeWorktree({ root, worktreesDir, worktree: join(worktreesDir, "x"), branch: "main" }),
    );
    expect(branch.code).toBe("unsafe_path");
    expect(git("rev-parse", "--verify", "main")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("findOrphanWorktrees", () => {
  it("lists worktrees and branches that no run needs", async () => {
    // Needed: an active run.
    const active = await queued("BE-01");
    const activeWt = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-01",
      runId: active.id,
      store,
    });
    await store.transition(active.id, "starting", activeWt);

    // Needed: a finished run waiting for integration.
    const waiting = await queued("BE-03");
    const waitingWt = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-03",
      runId: waiting.id,
      store,
    });
    await store.transition(waiting.id, "starting", waitingWt);
    await store.transition(waiting.id, "running");
    await store.transition(waiting.id, "checking");
    await store.transition(waiting.id, "succeeded");
    await store.integrate(waiting.id, "pending");

    // Orphan: its run was discarded but the cleanup never happened.
    const closed = await queued("BE-03");
    const closedWt = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-03",
      runId: closed.id,
      store,
    });
    await store.transition(closed.id, "cancelled", closedWt);
    await store.integrate(closed.id, "discarded");

    // Orphans: a worktree without run, a deleted folder, a stray folder, a stray branch.
    git(
      "worktree",
      "add",
      "-q",
      "-b",
      "konsora/BE-09/AAAA",
      join(worktreesDir, "BE-09-AAAA"),
      "main",
    );
    git(
      "worktree",
      "add",
      "-q",
      "-b",
      "konsora/BE-08/BBBB",
      join(worktreesDir, "BE-08-BBBB"),
      "main",
    );
    rmSync(join(worktreesDir, "BE-08-BBBB"), { recursive: true, force: true });
    mkdirSync(join(worktreesDir, "leftover"));
    git("branch", "konsora/BE-07/CCCC", "main");
    // Not Konsora's: ignored.
    git("branch", "unrelated", "main");

    const orphans = await findOrphanWorktrees({ root, worktreesDir, store });
    expect(orphans).toEqual(
      expect.arrayContaining([
        { worktree: closedWt.worktree, branch: closedWt.branch, reason: "run_closed" },
        {
          worktree: join(worktreesDir, "BE-09-AAAA"),
          branch: "konsora/BE-09/AAAA",
          reason: "no_run",
        },
        {
          worktree: join(worktreesDir, "BE-08-BBBB"),
          branch: "konsora/BE-08/BBBB",
          reason: "missing_dir",
        },
        { worktree: join(worktreesDir, "leftover"), reason: "stray_dir" },
        { branch: "konsora/BE-07/CCCC", reason: "no_run" },
      ]),
    );
    expect(orphans).toHaveLength(5);
    const listed = JSON.stringify(orphans);
    expect(listed).not.toContain(activeWt.worktree);
    expect(listed).not.toContain(waitingWt.worktree);
    expect(listed).not.toContain("unrelated");
  });

  it("returns nothing for a repo without Konsora worktrees", async () => {
    expect(await findOrphanWorktrees({ root, worktreesDir, store })).toEqual([]);
  });
});

describe("runGitWritePaths", () => {
  it("opens the worktree's git dir, the objects and the run branch's ref folders, nothing else", async () => {
    const run = await queued("BE-01");
    const prepared = await prepareWorktree({
      root,
      worktreesDir,
      document: plan,
      task: "BE-01",
      runId: run.id,
      store,
    });
    const common = join(root, ".git");
    const paths = await runGitWritePaths(prepared.worktree, prepared.branch);
    expect(paths).toEqual([
      join(common, "worktrees", `BE-01-${run.id.slice(2, 14)}`),
      join(common, "objects"),
      join(common, "refs", "heads", "konsora", "BE-01"),
      join(common, "logs", "refs", "heads", "konsora", "BE-01"),
    ]);
    // Never the repo's config, hooks, HEAD or the base branch.
    for (const path of paths) {
      expect(path).not.toBe(common);
      expect(path).not.toMatch(/config|hooks|refs\/heads$|refs\/heads\/main/);
    }
  });

  it("returns nothing for the main checkout or a branch outside konsora/<task>/<id>", async () => {
    expect(await runGitWritePaths(root, "feature")).toEqual([]);
    expect(await runGitWritePaths(root, "konsora/BE-01/01ABCDEFGHJK")).toEqual([]);
    expect(await runGitWritePaths(root, "konsora/../main/01ABCDEFGHJK")).toEqual([]);
    expect(await runGitWritePaths(join(root, "missing"), "konsora/BE-01/01ABCDEFGHJK")).toEqual([]);
  });
});
