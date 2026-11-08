/**
 * Integration on accept (docs/arquitectura.md §5, "Integrar"): a run's work becomes exactly one
 * commit on `project.base_branch`, locally. Never push, never force.
 *
 * - The result is computed first with `git merge-tree --write-tree` (no side effects), so a
 *   conflict leaves the base branch, the index and every file exactly as they were.
 * - The commit is `<task-id>: <title>`, the task's summary as body, and the trailers
 *   `Konsora-Task:` and `Konsora-Run:`; its only parent is the base branch's current tip.
 * - Base branch checked out in the main checkout → `git merge --ff-only` to that commit, after
 *   refusing if files the run touches have uncommitted changes there (other local changes stay).
 *   Not checked out → `update-ref` guarded by the old tip, without touching any working tree.
 * - Success: `integration.state = merged`, the run's worktree and branch are removed, the run is
 *   kept. Conflict: `integration.state = conflict`, nothing else changes.
 *
 * It never changes the plan: the daemon accepts the task only after a successful integration.
 */
import {
  indexTasks,
  type Run,
  type RunId,
  type TasksDocument,
  transitionIntegration,
} from "@konsora/core";
import { type Git, systemGit } from "./git.ts";
import type { RunStore } from "./run-store.ts";
import { removeWorktree } from "./worktree.ts";

export type IntegrationErrorCode =
  | "not_found"
  | "not_integrable"
  | "plan_changes"
  | "nothing_to_integrate"
  | "base_branch_missing"
  | "checked_out_elsewhere"
  | "dirty"
  | "moved"
  | "git_failed";

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  /** For `dirty`: the files with uncommitted changes that the run also touches. */
  readonly files: string[];
  readonly detail: string | undefined;
  constructor(code: IntegrationErrorCode, message: string, files: string[] = [], detail?: string) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.files = files;
    this.detail = detail;
  }
}

export type IntegrationResult =
  | { status: "merged"; commit: string; run: Run }
  | { status: "conflict"; files: string[]; run: Run };

export type IntegrateInput = {
  /** The project's main checkout. */
  root: string;
  worktreesDir: string;
  document: TasksDocument;
  runId: RunId;
  store: RunStore;
  git?: Git;
};

const PLAN = ".konsora";

export function integrationMessage(document: TasksDocument, run: Run): string {
  const task = indexTasks(document).get(run.task);
  const title = task?.title ?? run.task;
  const summary =
    [...(task?.notes ?? [])].reverse().find((n) => n.kind === "summary" && n.run === run.id)
      ?.text ?? run.summary;
  return [
    `${run.task}: ${title}`,
    ...(summary?.trim() ? ["", summary.trim()] : []),
    "",
    `Konsora-Task: ${run.task}`,
    `Konsora-Run: ${run.id}`,
    "",
  ].join("\n");
}

/** The integration in progress per main checkout, so two never race on the same base branch. */
const inProgress = new Map<string, Promise<unknown>>();

/**
 * Integrates a run's work into the base branch. Integrations into the same checkout run one at a
 * time (parallel runs of a YOLO chain finish together): each reads the base branch's tip only once
 * the previous one has moved it, so none fails with `moved` because of another.
 */
export function integrateRun(input: IntegrateInput): Promise<IntegrationResult> {
  const key = input.root;
  const previous = inProgress.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => integrateNow(input));
  const settled = next.catch(() => undefined);
  inProgress.set(key, settled);
  void settled.then(() => {
    if (inProgress.get(key) === settled) inProgress.delete(key);
  });
  return next;
}

async function integrateNow(input: IntegrateInput): Promise<IntegrationResult> {
  const git = input.git ?? systemGit;
  const root = input.root;
  let run = await input.store.read(input.runId);
  const state = run.integration?.state;
  if (run.state !== "succeeded" || (state && state !== "pending" && state !== "conflict")) {
    throw new IntegrationError(
      "not_integrable",
      state === "merged" || state === "discarded"
        ? `Run ${run.id} was already ${state}`
        : `Run ${run.id} is ${run.state}; only a succeeded run can be integrated`,
    );
  }
  const head = run.head_commit;
  const base = run.base_commit;
  if (!head || !base || !run.branch || !run.worktree) {
    throw new IntegrationError("not_integrable", `Run ${run.id} has no commits to integrate`);
  }
  const out = async (args: string[], what: string): Promise<string> => {
    const result = await git.run(args, { cwd: root });
    if (result.code !== 0) {
      throw new IntegrationError("git_failed", `git could not ${what}`, [], result.stderr);
    }
    return result.stdout;
  };

  const baseBranch = input.document.project.base_branch;
  const baseRef = `refs/heads/${baseBranch}`;
  const tipResult = await git.run(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
    cwd: root,
  });
  if (tipResult.code !== 0) {
    throw new IntegrationError(
      "base_branch_missing",
      `Base branch "${baseBranch}" does not exist; fix project.base_branch`,
    );
  }
  const tip = tipResult.stdout.trim();

  // Where is the base branch checked out?
  const current = await git.run(["symbolic-ref", "-q", "HEAD"], { cwd: root });
  const inCheckout = current.code === 0 && current.stdout.trim() === baseRef;
  if (!inCheckout && (await checkedOutElsewhere(git, root, baseRef))) {
    throw new IntegrationError(
      "checked_out_elsewhere",
      `${baseBranch} is checked out in another worktree; integrate from there or switch it away`,
    );
  }
  // Merge without side effects.
  const merged = await git.run(
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, head],
    { cwd: root },
  );
  if (merged.code === 1) {
    const files = merged.stdout.split("\n").slice(1).filter(Boolean);
    run = await setIntegration(input.store, run, "conflict");
    return { status: "conflict", files, run };
  }
  if (merged.code !== 0) {
    throw new IntegrationError("git_failed", "git could not merge the run", [], merged.stderr);
  }
  const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
  // What the commit would change on the base branch (after a rebase or merge of the base into the
  // run's branch, base_commit..head also holds the base's own commits).
  const touched = (await out(["diff", "--name-only", "-z", tip, tree, "--"], "compare the result"))
    .split("\0")
    .filter(Boolean);
  if (touched.length === 0) {
    throw new IntegrationError(
      "nothing_to_integrate",
      `${baseBranch} already has every change of run ${run.id}; discard it instead`,
    );
  }
  // The plan never travels through a run.
  if (touched.some((file) => file === PLAN || file.startsWith(`${PLAN}/`))) {
    throw new IntegrationError(
      "plan_changes",
      `Run ${run.id} changes ${PLAN}/; Konsora will not integrate plan changes from a branch`,
    );
  }
  if (inCheckout) {
    const dirty = await dirtyFiles(git, root);
    const clash = touched.filter((file) => dirty.has(file));
    if (clash.length > 0) {
      throw new IntegrationError(
        "dirty",
        `Commit or stash your changes to ${clash.join(", ")} first: the run changes them too`,
        clash,
      );
    }
  }

  if (!run.integration) run = await setIntegration(input.store, run, "pending");

  const commitResult = await git.run(["commit-tree", tree, "-p", tip, "-F", "-"], {
    cwd: root,
    input: integrationMessage(input.document, run),
  });
  if (commitResult.code !== 0) {
    throw new IntegrationError(
      "git_failed",
      "git could not create the commit (is user.name/user.email set?)",
      [],
      commitResult.stderr,
    );
  }
  const commit = commitResult.stdout.trim();

  if (inCheckout) {
    const ff = await git.run(["merge", "--ff-only", "--quiet", commit], { cwd: root });
    if (ff.code !== 0) {
      throw new IntegrationError(
        "moved",
        `${baseBranch} or your local changes moved while integrating; try again`,
        [],
        ff.stderr,
      );
    }
  } else {
    const update = await git.run(
      ["update-ref", "-m", `konsora: integrate ${run.id}`, baseRef, commit, tip],
      { cwd: root },
    );
    if (update.code !== 0) {
      throw new IntegrationError(
        "moved",
        `${baseBranch} moved while integrating; try again`,
        [],
        update.stderr,
      );
    }
  }

  run = await setIntegration(input.store, run, "merged");
  await removeWorktree({
    root,
    worktreesDir: input.worktreesDir,
    worktree: run.worktree as string,
    branch: run.branch as string,
    git,
  });
  return { status: "merged", commit, run };
}

async function setIntegration(
  store: RunStore,
  run: Run,
  to: "pending" | "conflict" | "merged",
): Promise<Run> {
  if (run.integration?.state === to) return run;
  if (to !== "pending" && !run.integration) run = await store.integrate(run.id, "pending");
  const check = transitionIntegration(run, to);
  if (!check.ok) throw new IntegrationError("not_integrable", check.error.message);
  return store.integrate(run.id, to);
}

async function dirtyFiles(git: Git, root: string): Promise<Set<string>> {
  const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
  });
  if (status.code !== 0) {
    throw new IntegrationError(
      "git_failed",
      "git could not read the checkout's status",
      [],
      status.stderr,
    );
  }
  const files = new Set<string>();
  const fields = status.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string;
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    // Renames and copies carry the original path in the next field.
    if (entry[0] === "R" || entry[0] === "C") files.add(fields[++i] as string);
  }
  return files;
}

async function checkedOutElsewhere(git: Git, root: string, ref: string): Promise<boolean> {
  const list = await git.run(["worktree", "list", "--porcelain", "-z"], { cwd: root });
  if (list.code !== 0) return false;
  return list.stdout.split("\0").some((field) => field === `branch ${ref}`);
}
