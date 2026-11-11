/**
 * The local git operations behind a block's merge (M12). Konsora only merges a block's branch
 * into its base when the human asks, never pushes, and never leaves the repository half-merged:
 *
 * 1. The merge is computed without touching any working tree (`git merge-tree --write-tree`); a
 *    conflict is reported with its files and nothing changes.
 * 2. The result becomes a commit with `git commit-tree`: one parent for a squash, two for a merge.
 * 3. The base branch then moves to it: with `git merge --ff-only` in the worktree that has it
 *    checked out (git refuses, changing nothing, if local changes would be overwritten), or with a
 *    compare-and-swap `git update-ref` when no worktree has it checked out.
 */
import { execFile } from "node:child_process";
import type { MergeStrategy } from "@konsora/core";

export type GitErrorCode =
  | "not_a_repo"
  | "no_branch"
  | "no_base"
  | "nothing_to_merge"
  | "conflict"
  | "dirty"
  | "git_failed";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly files: string[];
  constructor(code: GitErrorCode, message: string, files: string[] = []) {
    super(message);
    this.code = code;
    this.files = files;
  }
}

type Run = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          reject(new GitError("git_failed", `Could not run git: ${error.message}`));
          return;
        }
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function ok(cwd: string, args: string[], what: string): Promise<string> {
  const run = await git(cwd, args);
  if (run.code !== 0)
    throw new GitError("git_failed", `${what} failed: ${run.stderr.trim() || run.stdout.trim()}`);
  return run.stdout.trim();
}

async function resolveBranch(cwd: string, branch: string): Promise<string | undefined> {
  const run = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return run.code === 0 ? run.stdout.trim() : undefined;
}

async function ensureRepo(cwd: string) {
  const run = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (run.code !== 0 || run.stdout.trim() !== "true")
    throw new GitError("not_a_repo", "The project folder is not inside a git repository");
}

/** The branch checked out in the project's worktree, if any (not on a detached HEAD). */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const run = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return run.code === 0 ? run.stdout.trim() || undefined : undefined;
}

/** Local branches, for choosing a block's base. Empty outside a repository. */
export async function localBranches(cwd: string): Promise<string[]> {
  const run = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return run.code === 0 ? run.stdout.split("\n").filter(Boolean).sort() : [];
}

/** Worktree paths by the branch they have checked out. */
async function checkouts(cwd: string): Promise<Map<string, string>> {
  const out = await ok(cwd, ["worktree", "list", "--porcelain"], "git worktree list");
  const byBranch = new Map<string, string>();
  let path: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path)
      byBranch.set(line.slice("branch refs/heads/".length), path);
  }
  return byBranch;
}

export type MergeInput = {
  branch: string;
  base: string;
  strategy: MergeStrategy;
  message: string;
};

/** Merges `branch` into `base` as described above and returns the new commit on `base`. */
export async function mergeBranch(cwd: string, input: MergeInput): Promise<{ commit: string }> {
  await ensureRepo(cwd);
  const head = await resolveBranch(cwd, input.branch);
  if (!head) throw new GitError("no_branch", `Branch ${input.branch} does not exist`);
  const base = await resolveBranch(cwd, input.base);
  if (!base) throw new GitError("no_base", `Base branch ${input.base} does not exist`);
  const merged = await git(cwd, ["merge-base", "--is-ancestor", head, base]);
  if (merged.code === 0)
    throw new GitError(
      "nothing_to_merge",
      `${input.branch} has nothing that ${input.base} does not have already`,
    );

  const tree = await git(cwd, ["merge-tree", "--write-tree", "--name-only", base, head]);
  if (tree.code === 1) {
    // First line: the tree; then the conflicted files, until a blank line.
    const [, ...rest] = tree.stdout.split("\n");
    const files = rest.slice(0, Math.max(0, rest.indexOf(""))).filter(Boolean);
    throw new GitError(
      "conflict",
      `${input.branch} conflicts with ${input.base}; nothing was changed`,
      files,
    );
  }
  if (tree.code !== 0)
    throw new GitError("git_failed", `git merge-tree failed: ${tree.stderr.trim()}`);
  const treeId = tree.stdout.split("\n")[0]?.trim() ?? "";

  const parents = input.strategy === "merge" ? ["-p", base, "-p", head] : ["-p", base];
  const commit = await ok(
    cwd,
    ["commit-tree", treeId, ...parents, "-m", input.message],
    "git commit-tree (is your git user.name and user.email set?)",
  );

  const worktree = (await checkouts(cwd)).get(input.base);
  if (worktree) {
    const ff = await git(worktree, ["merge", "--ff-only", commit]);
    if (ff.code !== 0)
      throw new GitError(
        "dirty",
        `${input.base} is checked out in ${worktree} and git refused to update it (commit or stash your local changes first): ${ff.stderr.trim() || ff.stdout.trim()}`,
      );
  } else {
    await ok(
      cwd,
      [
        "update-ref",
        "-m",
        `konsora: merge ${input.branch}`,
        `refs/heads/${input.base}`,
        commit,
        base,
      ],
      "git update-ref",
    );
  }
  return { commit };
}
