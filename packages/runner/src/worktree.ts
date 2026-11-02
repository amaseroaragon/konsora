/**
 * One worktree and branch per run (docs/arquitectura.md §5, "Preparar"), outside the repo in
 * `~/.local/share/konsora/worktrees/<project-id>/`. The caller passes that directory: the
 * project id belongs to the daemon's registry.
 *
 * - `prepareWorktree` checks that the task is ready and has no other active run, pins
 *   `base_commit` to the head of `project.base_branch` and runs
 *   `git worktree add -b konsora/<task>/<short> <worktree> <base_commit>` under umask 077.
 *   The main checkout (its HEAD, index and files) is never touched.
 * - `removeWorktree` deletes a run's worktree and branch; it is idempotent and refuses anything
 *   outside the worktrees directory or the `konsora/` branch namespace.
 * - `findOrphanWorktrees` lists Konsora worktrees and branches that no run needs any more.
 */
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  blockers,
  indexTasks,
  isActiveRunState,
  isReady,
  type Run,
  type RunId,
  RunIdSchema,
  type TasksDocument,
} from "@konsora/core";
import { type Git, systemGit } from "./git.ts";
import type { RunStore } from "./run-store.ts";

export const BRANCH_PREFIX = "konsora/";

export type WorktreeErrorCode =
  | "not_found"
  | "not_ready"
  | "active_run"
  | "base_branch_missing"
  | "branch_exists"
  | "path_exists"
  | "unsafe_path"
  | "git_failed";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  /** Git's own output, for logs; never shown to agents. */
  readonly detail: string | undefined;
  constructor(code: WorktreeErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.detail = detail;
  }
}

/** `<task>/<short>`: the first 12 ULID characters (time + 2 random) are unique per task. */
function shortId(runId: RunId): string {
  return runId.slice(2, 14);
}

export function branchFor(task: string, runId: RunId): string {
  return `${BRANCH_PREFIX}${task}/${shortId(runId)}`;
}

export function worktreeNameFor(task: string, runId: RunId): string {
  return `${task}-${shortId(runId)}`;
}

export type PrepareWorktreeInput = {
  /** The project's main checkout. */
  root: string;
  /** `~/.local/share/konsora/worktrees/<project-id>`; created (0700) if missing. */
  worktreesDir: string;
  document: TasksDocument;
  task: string;
  /** The run being prepared: it may already exist in `store` (queued) without counting as "another" run. */
  runId: RunId;
  store: RunStore;
  git?: Git;
};

export type PreparedWorktree = { worktree: string; branch: string; base_commit: string };

export async function prepareWorktree(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
  const git = input.git ?? systemGit;
  if (!RunIdSchema.safeParse(input.runId).success) {
    throw new WorktreeError("not_found", `"${input.runId}" is not a run id`);
  }
  const index = indexTasks(input.document);
  const task = index.get(input.task);
  if (!task) throw new WorktreeError("not_found", `Task ${input.task} does not exist`);
  if (!isReady(task, index)) {
    const waiting = blockers(task, index);
    throw new WorktreeError(
      "not_ready",
      waiting.length > 0
        ? `${task.id} is blocked by ${waiting.join(", ")}; finish those first`
        : `${task.id} is ${task.state}; only a ready todo task can be run`,
    );
  }
  const active = await input.store.activeRun(task.id);
  if (active && active.id !== input.runId) {
    throw new WorktreeError(
      "active_run",
      `${task.id} already has an active run (${active.id}, ${active.state}); wait for it or cancel it`,
    );
  }

  const baseBranch = input.document.project.base_branch;
  const base = await git.run(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`],
    { cwd: input.root },
  );
  if (base.code !== 0) {
    throw new WorktreeError(
      "base_branch_missing",
      `Base branch "${baseBranch}" does not exist in this repository; fix project.base_branch`,
      base.stderr,
    );
  }
  const baseCommit = base.stdout.trim();

  const branch = branchFor(task.id, input.runId);
  const taken = await git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: input.root,
  });
  if (taken.code === 0) {
    throw new WorktreeError("branch_exists", `Branch ${branch} already exists; use a new run`);
  }

  const dir = await ensurePrivateDir(input.worktreesDir);
  const worktree = join(dir, worktreeNameFor(task.id, input.runId));
  if (await lstat(worktree).catch(() => null)) {
    throw new WorktreeError(
      "path_exists",
      `The worktree folder for ${task.id} (${worktreeNameFor(task.id, input.runId)}) already exists; use a new run`,
    );
  }

  const added = await git.run(["worktree", "add", "-b", branch, worktree, baseCommit], {
    cwd: input.root,
    umask: 0o077,
  });
  if (added.code !== 0) {
    // Never leave half a worktree or a dangling branch behind.
    await removeWorktree({ root: input.root, worktreesDir: dir, worktree, branch, git }).catch(
      () => undefined,
    );
    throw new WorktreeError(
      "git_failed",
      `git could not create the worktree for ${task.id}`,
      added.stderr,
    );
  }
  return { worktree, branch, base_commit: baseCommit };
}

export type RemoveWorktreeInput = {
  root: string;
  worktreesDir: string;
  worktree: string;
  branch: string;
  git?: Git;
};

export type RemovedWorktree = { worktree: boolean; branch: boolean };

/**
 * Removes a run's worktree (even with uncommitted changes: it is only called after integrating
 * or discarding) and its branch. Calling it again is a no-op.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<RemovedWorktree> {
  const git = input.git ?? systemGit;
  if (!input.branch.startsWith(BRANCH_PREFIX)) {
    throw new WorktreeError(
      "unsafe_path",
      `Refusing to delete ${input.branch}: not a Konsora branch`,
    );
  }
  const dir = await realpath(input.worktreesDir).catch(() => resolve(input.worktreesDir));
  const worktree = resolve(input.worktree);
  if (!isInside(dir, worktree) && !isInside(resolve(input.worktreesDir), worktree)) {
    throw new WorktreeError(
      "unsafe_path",
      "Refusing to delete a folder outside Konsora's worktrees",
    );
  }

  const removed: RemovedWorktree = { worktree: false, branch: false };
  const registered = (await listWorktrees(git, input.root)).some(
    (w) => w.path === worktree || w.path === input.worktree,
  );
  if (registered) {
    const result = await git.run(["worktree", "remove", "--force", "--force", worktree], {
      cwd: input.root,
    });
    if (result.code !== 0) {
      throw new WorktreeError(
        "git_failed",
        "git could not remove the run's worktree",
        result.stderr,
      );
    }
    removed.worktree = true;
  }
  if (await lstat(worktree).catch(() => null)) {
    await rm(worktree, { recursive: true, force: true });
    removed.worktree = true;
  }
  await git.run(["worktree", "prune"], { cwd: input.root });

  const exists = await git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`], {
    cwd: input.root,
  });
  if (exists.code === 0) {
    const result = await git.run(["branch", "-D", input.branch], { cwd: input.root });
    if (result.code !== 0) {
      throw new WorktreeError("git_failed", `git could not delete ${input.branch}`, result.stderr);
    }
    removed.branch = true;
  }
  return removed;
}

export type OrphanReason =
  /** No run references it. */
  | "no_run"
  /** Its run was already integrated or discarded. */
  | "run_closed"
  /** Registered in git, but its folder is gone (`git worktree prune` would drop it). */
  | "missing_dir"
  /** A folder in the worktrees directory that git does not know. */
  | "stray_dir";

export type OrphanWorktree = { worktree?: string; branch?: string; reason: OrphanReason };

export type FindOrphansInput = { root: string; worktreesDir: string; store: RunStore; git?: Git };

/** Konsora worktrees and `konsora/` branches that no run needs any more. Never writes. */
export async function findOrphanWorktrees(input: FindOrphansInput): Promise<OrphanWorktree[]> {
  const git = input.git ?? systemGit;
  const dir = await realpath(input.worktreesDir).catch(() => resolve(input.worktreesDir));
  const { runs } = await input.store.list();
  const byPath = new Map<string, Run>();
  const byBranch = new Map<string, Run>();
  for (const run of runs) {
    if (run.worktree) byPath.set(resolve(run.worktree), run);
    if (run.branch) byBranch.set(run.branch, run);
  }
  const needs = (run: Run | undefined): OrphanReason | null => {
    if (!run) return "no_run";
    if (isActiveRunState(run.state)) return null;
    const integration = run.integration?.state;
    return integration === "merged" || integration === "discarded" ? "run_closed" : null;
  };

  const orphans: OrphanWorktree[] = [];
  const seenPaths = new Set<string>();
  const seenBranches = new Set<string>();
  for (const entry of await listWorktrees(git, input.root)) {
    const branch = entry.branch?.startsWith(BRANCH_PREFIX) ? entry.branch : undefined;
    if (!branch && !isInside(dir, entry.path)) continue;
    seenPaths.add(entry.path);
    if (branch) seenBranches.add(branch);
    const run = byPath.get(entry.path) ?? (branch ? byBranch.get(branch) : undefined);
    const reason = entry.prunable ? "missing_dir" : needs(run);
    if (reason) orphans.push({ worktree: entry.path, ...(branch ? { branch } : {}), reason });
  }

  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const path = join(dir, name);
    if (!seenPaths.has(path)) orphans.push({ worktree: path, reason: "stray_dir" });
  }

  const refs = await git.run(
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`],
    { cwd: input.root },
  );
  for (const branch of refs.stdout.split("\n").filter(Boolean).sort()) {
    if (seenBranches.has(branch)) continue;
    const reason = needs(byBranch.get(branch));
    if (reason) orphans.push({ branch, reason });
  }
  return orphans;
}

type WorktreeEntry = { path: string; branch?: string; prunable: boolean };

async function listWorktrees(git: Git, root: string): Promise<WorktreeEntry[]> {
  const result = await git.run(["worktree", "list", "--porcelain", "-z"], { cwd: root });
  if (result.code !== 0) {
    throw new WorktreeError("git_failed", "git could not list worktrees", result.stderr);
  }
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of result.stdout.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = null;
    } else if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), prunable: false };
    } else if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (current && (field === "prunable" || field.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function ensurePrivateDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorktreeError("unsafe_path", "Konsora's worktrees folder is not a plain directory");
  }
  return realpath(path);
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const RUN_BRANCH = /^konsora\/[A-Za-z0-9][A-Za-z0-9-]*\/[0-9A-Z]{12}$/;

/**
 * What in the repo's git directory a run must be able to write to commit on its own branch from
 * inside a sandbox (Codex `workspace-write` protects `.git`, and a linked worktree keeps its index
 * and HEAD in the main repo's `.git/worktrees/<name>`, outside the worktree):
 *
 * - the worktree's own git dir (index, HEAD, its reflog, COMMIT_EDITMSG),
 * - the shared `objects/` (new blobs, trees and commits),
 * - `refs/heads/konsora/<task>/` and `logs/refs/heads/konsora/<task>/` (the run's branch and its
 *   reflog; the folder, because git writes `<ref>.lock` next to the ref).
 *
 * Never the main checkout, `config`, `hooks`, `HEAD`, `packed-refs` or any other branch, so the
 * agent cannot move the base branch. Only paths that exist are returned, and nothing at all
 * unless `worktree` is a linked worktree of a `konsora/<task>/<short>` branch: the caller then
 * keeps the provider's default sandbox, which asks before writing git metadata.
 */
export async function runGitWritePaths(
  worktree: string,
  branch: string,
  git: Git = systemGit,
): Promise<string[]> {
  if (!RUN_BRANCH.test(branch)) return [];
  const result = await git
    .run(["rev-parse", "--absolute-git-dir", "--git-common-dir"], { cwd: worktree })
    .catch(() => null);
  if (!result || result.code !== 0) return [];
  const [gitDirLine, commonLine] = result.stdout.split("\n").map((line) => line.trim());
  if (!gitDirLine || !commonLine) return [];
  const gitDir = await realpath(gitDirLine).catch(() => null);
  const commonDir = await realpath(resolve(worktree, commonLine)).catch(() => null);
  if (!gitDir || !commonDir || !isInside(join(commonDir, "worktrees"), gitDir)) return [];
  const task = branch.split("/")[1] as string;
  const candidates = [
    gitDir,
    join(commonDir, "objects"),
    join(commonDir, "refs", "heads", "konsora", task),
    join(commonDir, "logs", "refs", "heads", "konsora", task),
  ];
  const present = await Promise.all(
    candidates.map(async (path) =>
      (await lstat(path).catch(() => null))?.isDirectory() ? path : null,
    ),
  );
  return present.filter((path): path is string => path !== null);
}
