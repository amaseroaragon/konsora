/**
 * Review runs (RUN-29, model in `@konsora/core`, CORE-13): a second agent reviews the work of a
 * succeeded run, in that run's worktree, with the `readonly` profile, and leaves its verdict as a
 * `review` note through Konsora's MCP (`KONSORA_REVIEW=1`). It has no setup, no checks and no
 * `complete`; it never changes the task's state nor the worktree.
 *
 * - Every approval the agent asks for is denied on the spot: nothing that needs one is read-only.
 * - One turn: once it ends, the agent's input is closed.
 * - Closing: `succeeded` if the agent left its `review` note, else `failed`. If the worktree's
 *   HEAD or files changed anyway, the run fails and a Konsora note says so.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSpec,
  buildReviewPrompt,
  indexTasks,
  isReviewRun,
  newRunId,
  READONLY_PROFILE,
  type Run,
  type RunId,
  type RunState,
  type Task,
  taskHash,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import type { RunEvent, RunHandle } from "./adapter.ts";
import { type Git, systemGit } from "./git.ts";
import { RunStore } from "./run-store.ts";
import { RunError, type RunSession, type SupervisorOptions } from "./supervisor.ts";
import { UsageTally } from "./usage.ts";

const ACTOR = "konsora";
const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
const READ_ONLY = "This is a read-only review run: Konsora denies anything that needs an approval.";

/** Starts a review of `input.run` with `input.agent` (its profile becomes `readonly`). */
export async function startReviewRun(
  options: SupervisorOptions,
  input: { run: RunId; agent: AgentSpec },
): Promise<RunSession> {
  const store = options.store ?? new RunStore(options.root);
  const git = options.git ?? systemGit;
  const now = () => timestamp(options.now?.() ?? new Date());

  const plan = await readTasks(options.root);
  if (!plan.ok) throw new RunError("invalid_plan", plan.error.message);
  const reviewed = await store.read(input.run);
  const integration = reviewed.integration?.state;
  if (isReviewRun(reviewed) || reviewed.state !== "succeeded") {
    throw new RunError(
      "not_reviewable",
      `Run ${reviewed.id} is ${isReviewRun(reviewed) ? "a review" : reviewed.state}; only the work of a succeeded run can be reviewed`,
    );
  }
  if (integration === "merged" || integration === "discarded") {
    throw new RunError(
      "not_reviewable",
      `Run ${reviewed.id} was already ${integration}; there is no work left to review`,
    );
  }
  const { worktree, branch } = reviewed;
  const onBranch = worktree
    ? await git.run(["symbolic-ref", "-q", "HEAD"], { cwd: worktree }).catch(() => null)
    : null;
  if (!worktree || onBranch?.code !== 0 || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
    throw new RunError(
      "not_reviewable",
      `The worktree of run ${reviewed.id} is gone or left its branch; it cannot be reviewed`,
    );
  }
  const task = indexTasks(plan.document).get(reviewed.task);
  if (!task) throw new RunError("not_found", `Task ${reviewed.task} does not exist`);
  if (task.state !== "review") {
    throw new RunError(
      "not_reviewable",
      `${task.id} is ${task.state}; a review runs while the task is in review`,
    );
  }
  const agent: AgentSpec = { ...input.agent, permissions: READONLY_PROFILE };
  if (agent.provider !== options.adapter.id) {
    throw new RunError(
      "wrong_provider",
      `The reviewer uses ${agent.provider}, but this runner uses ${options.adapter.id}`,
    );
  }
  const prompt = buildReviewPrompt(plan.document, task.id, {
    run: reviewed,
    diff: await store.readDiff(reviewed.id),
  });
  // Before anything starts: what the review must leave as it is.
  const before = await snapshot(git, worktree);

  const created = await store.create({
    id: newRunId(),
    task: task.id,
    task_hash: taskHash(task),
    agent,
    state: "queued",
    kind: "review",
    review_of: reviewed.id,
  });
  const id = created.id;
  await store.transition(id, "starting", { started_at: now() });
  const run = await store.update(id, {
    worktree,
    ...(branch ? { branch } : {}),
    ...(reviewed.base_commit ? { base_commit: reviewed.base_commit } : {}),
    ...(reviewed.head_commit ? { head_commit: reviewed.head_commit } : {}),
    prompt,
  });
  const privateDir = join(options.privateDir, id);

  let handle: RunHandle;
  try {
    handle = options.adapter.start(
      {
        prompt,
        cwd: worktree,
        agent,
        mcp: {
          command: options.mcp.command,
          args: [...options.mcp.args],
          env: {
            KONSORA_AGENT: options.adapter.id,
            KONSORA_PROJECT: options.root,
            KONSORA_RUN: id,
            KONSORA_TASK: task.id,
            KONSORA_REVIEW: "1",
          },
        },
        privateDir,
      },
      { raw: (line) => void store.appendRaw(id, line).catch(() => undefined) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The reviewer could not start";
    await store.appendEvent(id, { at: now(), t: "error", message, retryable: false });
    await store.transition(id, "failed", { finished_at: now() });
    await rm(privateDir, { recursive: true, force: true });
    throw new RunError("launch_failed", message);
  }

  const review = new ReviewSupervision(options, store, git, now, run, handle, before);
  return {
    run,
    done: review.run().finally(() => rm(privateDir, { recursive: true, force: true })),
    setAwaitingApproval: async () => undefined,
    deliverAnswer: async () => {
      throw new RunError("no_answer", `Review run ${id} takes no answers`);
    },
    cancel: () => review.cancel(),
  };
}

type Snapshot = { head: string; status: string };

async function snapshot(git: Git, worktree: string): Promise<Snapshot> {
  const head = await git.run(["rev-parse", "HEAD"], { cwd: worktree });
  const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktree,
  });
  if (head.code !== 0 || status.code !== 0) {
    throw new RunError("not_reviewable", "git could not read the worktree to review");
  }
  return { head: head.stdout.trim(), status: status.stdout };
}

class ReviewSupervision {
  readonly #options: SupervisorOptions;
  readonly #store: RunStore;
  readonly #git: Git;
  readonly #now: () => string;
  readonly #run: Run;
  readonly #handle: RunHandle;
  readonly #before: Snapshot;
  readonly #usage = new UsageTally();
  #state: RunState;
  #cancelled = false;
  #done: Promise<Run> | null = null;

  constructor(
    options: SupervisorOptions,
    store: RunStore,
    git: Git,
    now: () => string,
    run: Run,
    handle: RunHandle,
    before: Snapshot,
  ) {
    this.#options = options;
    this.#store = store;
    this.#git = git;
    this.#now = now;
    this.#run = run;
    this.#handle = handle;
    this.#before = before;
    this.#state = run.state;
  }

  run(): Promise<Run> {
    this.#done ??= this.#supervise();
    return this.#done;
  }

  async cancel(): Promise<Run> {
    if (!this.#cancelled) {
      this.#cancelled = true;
      await this.#log({ t: "cancel" });
      await this.#handle.interrupt();
      this.#handle.endInput();
      const grace = this.#options.interruptGraceMs ?? 5000;
      const timer = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), grace).unref(),
      );
      if ((await Promise.race([this.#handle.exited, timer])) === "timeout") {
        await this.#handle.kill();
      }
    }
    return this.run();
  }

  async #supervise(): Promise<Run> {
    for await (const event of this.#handle.events) {
      await this.#log(event);
      if (event.t === "started") {
        if (this.#state === "starting") await this.#move("running");
        if (event.session || event.transport) {
          await this.#store.update(this.#run.id, {
            ...(event.session ? { session_id: event.session } : {}),
            ...(event.transport ? { transport: event.transport } : {}),
          });
        }
      } else if (event.t === "permission") {
        this.#handle.answerPermission?.(event.id, { behavior: "deny", message: READ_ONLY });
        await this.#log({ t: "permission_decision", id: event.id, behavior: "deny" });
      } else if (event.t === "usage") {
        this.#usage.add(event);
      } else if (event.t === "turn_end") {
        this.#handle.endInput(); // one turn: the review is all it does
      }
    }
    const exit = await this.#handle.exited;
    return this.#close(exit);
  }

  async #close(exit: { code: number | null; signal: string | null }): Promise<Run> {
    const id = this.#run.id;
    const task = await this.#readTask();
    const note = (task?.notes ?? []).findLast((n) => n.kind === "review" && n.run === id);
    const after = await snapshot(this.#git, this.#run.worktree as string).catch(() => null);
    const touched =
      !after || after.head !== this.#before.head || after.status !== this.#before.status;
    const fields = {
      finished_at: this.#now(),
      exit,
      usage: this.#usage.toRunUsage(),
      ...(note ? { summary: `${note.verdict}: ${note.text}`.slice(0, 20_000) } : {}),
    };
    if (this.#state === "starting") await this.#move("running");
    if (touched) {
      const message = `the review changed the worktree of run ${this.#run.review_of}`;
      await this.#log({ t: "error", message: `Run failed: ${message}`, retryable: false });
      await mutate(
        this.#options.root,
        {
          op: "note",
          task: this.#run.task,
          text: `Konsora review run ${id} changed the worktree of run ${this.#run.review_of}, which a review must not do. Check that run's worktree before accepting.`,
        },
        { actor: ACTOR, at: this.#now(), run: id },
      ).catch(() => undefined);
      return this.#finish("failed", fields);
    }
    if (note) return this.#finish("succeeded", fields);
    if (this.#cancelled) {
      await this.#log({ t: "cancelled" });
      return this.#finish("cancelled", fields);
    }
    await this.#log({
      t: "error",
      message: "Run failed: the reviewer stopped without leaving its review",
      retryable: false,
    });
    return this.#finish("failed", fields);
  }

  async #finish(
    to: "succeeded" | "failed" | "cancelled",
    fields: Parameters<RunStore["transition"]>[2],
  ): Promise<Run> {
    // A review is never integrated: once closed, there is nothing more to decide about it.
    const run = await this.#store.transition(this.#run.id, to, fields);
    this.#state = run.state;
    return run;
  }

  async #readTask(): Promise<Task | null> {
    const plan = await readTasks(this.#options.root);
    return plan.ok ? (plan.document.tasks.find((t) => t.id === this.#run.task) ?? null) : null;
  }

  async #move(to: RunState): Promise<void> {
    const run = await this.#store.transition(this.#run.id, to);
    this.#state = run.state;
  }

  #log(event: RunEvent | Record<string, unknown>): Promise<void> {
    return this.#store.appendEvent(this.#run.id, { at: this.#now(), ...event });
  }
}
