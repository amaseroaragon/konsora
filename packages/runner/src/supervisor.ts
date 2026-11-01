/**
 * The run supervisor (docs/arquitectura.md §5, "Ciclo de vida de un run"): takes one task from
 * ready to a closed run.
 *
 * 1. Prepare: the task must be ready with no active run. The run is created (`queued`, which
 *    claims the task), moves to `starting`, gets its worktree and branch, and its prompt.
 * 2. Launch: the run is registered with the daemon (its permission token), the task goes to
 *    `doing` as `konsora`, and the adapter starts with Konsora's MCP in run mode.
 * 3. Supervise: every event goes to `events.jsonl` (with `at`) and every raw line to
 *    `raw.jsonl`; `run.json` follows the state (`running ⇄ waiting_approval`), the session id and
 *    the usage. After each turn the plan says what comes next: the task is in review (the agent
 *    called `finish`) → close the agent's input; it waits for an answer → keep it open; else →
 *    close it, the agent is done without finishing.
 * 4. Close (the process exited): commit what is left as `wip` (never `.konsora/`), record
 *    `head_commit` and `diff.patch` = `base_commit..HEAD` without `.konsora/`, usage and exit.
 *    Finished → `checking` → `succeeded` (checks arrive in M8). Not finished → `failed`, and the
 *    task goes back to `todo` with a runner note. The worktree stays until integrate or discard.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSpec,
  blockers,
  buildRunPrompt,
  indexTasks,
  isReady,
  isWaiting,
  newRunId,
  type Run,
  type RunId,
  type RunState,
  type Task,
  taskHash,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import type { AgentAdapter, McpServerSpec, RunEvent, RunHandle } from "./adapter.ts";
import { type Git, systemGit } from "./git.ts";
import { RunStore } from "./run-store.ts";
import { prepareWorktree, WorktreeError } from "./worktree.ts";

/** Where the daemon registers runs for permission approvals (`Approvals.registerRun`). */
export interface RunRegistry {
  /** Returns the daemon's URL and this run's own token, for the run's MCP. */
  register(info: { run: RunId; task: string }): Promise<{ url: string; token: string }>;
  /** Forgets the run; its pending approvals are denied. */
  unregister(run: RunId): void;
}

export type SupervisorOptions = {
  /** The project's main checkout. */
  root: string;
  /** `~/.local/share/konsora/worktrees/<project-id>`. */
  worktreesDir: string;
  /** A private folder outside the project; each run gets `<privateDir>/<run-id>`. */
  privateDir: string;
  adapter: AgentAdapter;
  /** How to launch `konsora mcp` (the supervisor adds the run-mode environment). */
  mcp: Pick<McpServerSpec, "command" | "args">;
  /** The daemon's approvals; without it, permission requests are denied. */
  registry?: RunRegistry;
  store?: RunStore;
  git?: Git;
  now?: () => Date;
};

export type RunSession = {
  /** The run as created (`starting`). */
  readonly run: Run;
  /** Resolves with the closed run (`succeeded` or `failed`). Never rejects. */
  readonly done: Promise<Run>;
  /** The daemon calls this while one of the run's approvals is pending, and when it resolves. */
  setAwaitingApproval(waiting: boolean): Promise<void>;
};

export class RunError extends Error {
  readonly code:
    | "not_found"
    | "not_ready"
    | "no_agent"
    | "wrong_provider"
    | "invalid_plan"
    /** The run was created but could not start; it is left `failed`. */
    | "launch_failed";
  constructor(code: RunError["code"], message: string) {
    super(message);
    this.name = "RunError";
    this.code = code;
  }
}

const ACTOR = "konsora";
const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function startRun(
  options: SupervisorOptions,
  input: { task: string; agent?: AgentSpec },
): Promise<RunSession> {
  const store = options.store ?? new RunStore(options.root);
  const git = options.git ?? systemGit;
  const now = () => timestamp(options.now?.() ?? new Date());

  // ── Prepare ────────────────────────────────────────────────────────────────
  const plan = await readTasks(options.root);
  if (!plan.ok) throw new RunError("invalid_plan", plan.error.message);
  const index = indexTasks(plan.document);
  const task = index.get(input.task);
  if (!task) throw new RunError("not_found", `Task ${input.task} does not exist`);
  if (!isReady(task, index)) {
    const waiting = blockers(task, index);
    throw new RunError(
      "not_ready",
      waiting.length > 0
        ? `${task.id} is blocked by ${waiting.join(", ")}; finish those first`
        : `${task.id} is ${task.state}; only a ready todo task can be run`,
    );
  }
  const agent = input.agent ?? task.agent ?? plan.document.project.defaults;
  if (!agent) {
    throw new RunError("no_agent", `Choose an agent for ${task.id}, or set project.defaults`);
  }
  if (agent.provider !== options.adapter.id) {
    throw new RunError(
      "wrong_provider",
      `${task.id} asks for ${agent.provider}, but this runner uses ${options.adapter.id}`,
    );
  }
  const runAgent: AgentSpec = { ...agent, permissions: agent.permissions ?? "default" };

  const created = await store.create({
    id: newRunId(),
    task: task.id,
    task_hash: taskHash(task),
    agent: runAgent,
    state: "queued",
  });
  const id = created.id;
  let run = await store.transition(id, "starting", { started_at: now() });
  const privateDir = join(options.privateDir, id);

  const abort = async (message: string): Promise<never> => {
    await store.appendEvent(id, { at: now(), t: "error", message, retryable: false });
    await store.transition(id, "failed", { finished_at: now() });
    await rm(privateDir, { recursive: true, force: true });
    throw new RunError("launch_failed", message);
  };

  try {
    const prepared = await prepareWorktree({
      root: options.root,
      worktreesDir: options.worktreesDir,
      document: plan.document,
      task: task.id,
      runId: id,
      store,
      git,
    });
    run = await store.update(id, {
      ...prepared,
      prompt: buildRunPrompt(plan.document, task.id, { branch: prepared.branch }),
    });
  } catch (error) {
    if (error instanceof WorktreeError) return abort(error.message);
    await store.transition(id, "failed", { finished_at: now() }).catch(() => undefined);
    throw error;
  }

  // ── Launch ─────────────────────────────────────────────────────────────────
  let registered: { url: string; token: string } | null = null;
  try {
    registered = options.registry
      ? await options.registry.register({ run: id, task: task.id })
      : null;
  } catch {
    return abort("The daemon could not register the run for permission approvals");
  }
  const started = await mutate(
    options.root,
    { op: "start", task: task.id, text: `Konsora run ${id} started.` },
    { actor: ACTOR, at: now(), run: id },
  );
  if (!started.ok) {
    if (registered) options.registry?.unregister(id);
    return abort(`${task.id} could not move to doing: ${started.error.message}`);
  }

  const env: Record<string, string> = {
    KONSORA_AGENT: options.adapter.id,
    KONSORA_PROJECT: options.root,
    KONSORA_RUN: id,
    KONSORA_TASK: task.id,
    ...(registered
      ? { KONSORA_DAEMON_URL: registered.url, KONSORA_RUN_TOKEN: registered.token }
      : {}),
  };
  const handle = options.adapter.start(
    {
      prompt: run.prompt as string,
      cwd: run.worktree as string,
      agent: runAgent,
      ...(plan.document.project.checks ? { checks: plan.document.project.checks } : {}),
      mcp: { command: options.mcp.command, args: [...options.mcp.args], env },
      privateDir,
    },
    { raw: (line) => void store.appendRaw(id, line).catch(() => undefined) },
  );

  const supervision = new Supervision(options, store, git, handle, run, now);
  return {
    run,
    done: supervision.run().finally(async () => {
      if (registered) options.registry?.unregister(id);
      await rm(privateDir, { recursive: true, force: true });
    }),
    setAwaitingApproval: (waiting) => supervision.setAwaitingApproval(waiting),
  };
}

class Supervision {
  readonly #options: SupervisorOptions;
  readonly #store: RunStore;
  readonly #git: Git;
  readonly #handle: RunHandle;
  readonly #id: RunId;
  readonly #task: string;
  readonly #worktree: string;
  readonly #base: string;
  readonly #now: () => string;
  #state: RunState;
  #usage = { input_tokens: 0, output_tokens: 0, cost: 0, priced: false };
  /** Serializes `run.json` updates coming from events and from the daemon. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    options: SupervisorOptions,
    store: RunStore,
    git: Git,
    handle: RunHandle,
    run: Run,
    now: () => string,
  ) {
    this.#options = options;
    this.#store = store;
    this.#git = git;
    this.#handle = handle;
    this.#id = run.id;
    this.#task = run.task;
    this.#worktree = run.worktree as string;
    this.#base = run.base_commit as string;
    this.#state = run.state;
    this.#now = now;
  }

  async run(): Promise<Run> {
    let finished: Extract<RunEvent, { t: "finished" }> | undefined;
    for await (const event of this.#handle.events) {
      await this.#store.appendEvent(this.#id, { at: this.#now(), ...event });
      if (event.t === "started") {
        await this.#serial(async () => {
          if (this.#state === "starting") await this.#move("running");
          if (event.session) await this.#store.update(this.#id, { session_id: event.session });
        });
      } else if (event.t === "permission") {
        await this.setAwaitingApproval(true);
      } else if (event.t === "tool" && event.phase === "end") {
        await this.setAwaitingApproval(false);
      } else if (event.t === "usage") {
        this.#usage.input_tokens += event.input_tokens ?? 0;
        this.#usage.output_tokens += event.output_tokens ?? 0;
        if (event.cost_usd !== undefined) {
          this.#usage.cost += event.cost_usd;
          this.#usage.priced = true;
        }
      } else if (event.t === "turn_end") {
        await this.#afterTurn();
      } else if (event.t === "finished") {
        finished = event;
      }
    }
    const exit = await this.#handle.exited;
    return this.#serial(() => this.#close(exit, finished));
  }

  setAwaitingApproval(waiting: boolean): Promise<void> {
    return this.#serial(async () => {
      if (waiting && this.#state === "running") await this.#move("waiting_approval");
      if (!waiting && this.#state === "waiting_approval") await this.#move("running");
    });
  }

  /** The turn ended: keep the agent's input open only while it waits for the human's answer. */
  async #afterTurn(): Promise<void> {
    const task = await this.#readTask();
    if (task?.state === "doing" && isWaiting(task)) return;
    this.#handle.endInput();
  }

  async #close(
    exit: { code: number | null; signal: string | null },
    finished: Extract<RunEvent, { t: "finished" }> | undefined,
  ): Promise<Run> {
    const problems: string[] = [];
    let head: string | undefined;
    try {
      await this.#commitLeftovers();
      await this.#dropPlanChanges();
      head = await this.#gitOut(["rev-parse", "HEAD"]);
      const diff = await this.#git.run(
        ["diff", "--binary", `${this.#base}..${head}`, "--", ".", ":(exclude).konsora"],
        { cwd: this.#worktree },
      );
      if (diff.code !== 0) throw new Error("git diff failed");
      await this.#store.writeDiff(this.#id, diff.stdout);
    } catch {
      problems.push("the worktree's changes could not be collected");
    }

    const task = await this.#readTask();
    const summary = task
      ? [...(task.notes ?? [])].reverse().find((n) => n.kind === "summary" && n.run === this.#id)
      : undefined;
    const agentFinished = task !== null && (task.state === "review" || task.state === "done");
    const fields = {
      finished_at: this.#now(),
      exit,
      usage: {
        input_tokens: this.#usage.input_tokens,
        output_tokens: this.#usage.output_tokens,
        cost_usd: this.#usage.priced ? Math.round(this.#usage.cost * 1e6) / 1e6 : null,
      },
      checks: [],
      ...(head ? { head_commit: head } : {}),
      ...(summary
        ? { summary: summary.text }
        : finished?.summary
          ? { summary: finished.summary }
          : {}),
    };

    if (this.#state === "waiting_approval") await this.#move("running");
    if (agentFinished && problems.length === 0) {
      if (this.#state === "starting") await this.#move("running");
      await this.#move("checking");
      // Checks run here from M8.
      return this.#store.transition(this.#id, "succeeded", fields);
    }

    const reason = agentFinished
      ? problems.join("; ")
      : exit.code === 0 && exit.signal === null
        ? "the agent stopped without calling finish"
        : exit.signal
          ? `the agent was stopped by ${exit.signal} before calling finish`
          : `the agent exited with code ${exit.code} before calling finish`;
    await this.#store.appendEvent(this.#id, {
      at: this.#now(),
      t: "error",
      message: `Run failed: ${reason}`,
      retryable: false,
    });
    if (task?.state === "doing") {
      await mutate(
        this.#options.root,
        {
          op: "pause",
          task: this.#task,
          text: `Konsora run ${this.#id} failed: ${reason}. Its work is kept on its branch for review.`,
        },
        { actor: ACTOR, at: this.#now(), run: this.#id },
      );
    }
    const run = await this.#store.transition(this.#id, "failed", fields);
    this.#state = run.state;
    return run;
  }

  /** Commits whatever the agent left uncommitted, except `.konsora/`. */
  async #commitLeftovers(): Promise<void> {
    const add = await this.#git.run(["add", "-A", "--", ".", ":(exclude).konsora"], {
      cwd: this.#worktree,
    });
    if (add.code !== 0) throw new Error("git add failed");
    const staged = await this.#git.run(["diff", "--cached", "--quiet"], { cwd: this.#worktree });
    if (staged.code === 0) return;
    await this.#commit(`wip: ${this.#task} (Konsora run ${this.#id})`);
  }

  /**
   * If the agent committed changes to `.konsora/` anyway, a last commit puts it back as it was at
   * `base_commit`, so the branch (and its integration) never carries plan changes.
   */
  async #dropPlanChanges(): Promise<void> {
    const changed = await this.#git.run(["diff", "--quiet", this.#base, "HEAD", "--", ".konsora"], {
      cwd: this.#worktree,
    });
    if (changed.code === 0) return;
    await this.#git.run(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".konsora"], {
      cwd: this.#worktree,
    });
    await this.#git.run(["reset", "-q", this.#base, "--", ".konsora"], { cwd: this.#worktree });
    await this.#commit(`konsora: keep .konsora/ out of run ${this.#id}`);
  }

  async #commit(message: string): Promise<void> {
    const ident = await this.#git.run(["var", "GIT_COMMITTER_IDENT"], { cwd: this.#worktree });
    const identity =
      ident.code === 0 ? [] : ["-c", "user.name=Konsora", "-c", "user.email=konsora@localhost"];
    const commit = await this.#git.run(
      [...identity, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message],
      { cwd: this.#worktree },
    );
    if (commit.code !== 0) throw new Error("git commit failed");
  }

  async #gitOut(args: string[]): Promise<string> {
    const result = await this.#git.run(args, { cwd: this.#worktree });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout.trim();
  }

  async #readTask(): Promise<Task | null> {
    const plan = await readTasks(this.#options.root);
    return plan.ok ? (plan.document.tasks.find((t) => t.id === this.#task) ?? null) : null;
  }

  async #move(to: RunState): Promise<void> {
    const run = await this.#store.transition(this.#id, to);
    this.#state = run.state;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
