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
  buildAnswerMessage,
  buildRunPrompt,
  indexTasks,
  isReady,
  isWaiting,
  type Note,
  newRunId,
  type Run,
  type RunId,
  type RunState,
  type Task,
  taskHash,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import type {
  AgentAdapter,
  McpServerSpec,
  PermissionDecision,
  RunEvent,
  RunHandle,
} from "./adapter.ts";
import { type Git, systemGit } from "./git.ts";
import { RunStore } from "./run-store.ts";
import { UsageTally } from "./usage.ts";
import { prepareWorktree, WorktreeError } from "./worktree.ts";

/** Where the daemon registers runs for permission approvals (`Approvals.registerRun`). */
export interface RunRegistry {
  /** Returns the daemon's URL and this run's own token, for the run's MCP. */
  register(info: { run: RunId; task: string }): Promise<{ url: string; token: string }>;
  /** Forgets the run; its pending approvals are denied. */
  unregister(run: RunId): void;
  /**
   * Records an approval the agent asked for through its own protocol (Codex) and resolves with
   * the human's decision: deny if the run was unregistered, it ran out of time or it was
   * abandoned. Never rejects.
   */
  requestPermission?(request: {
    run: RunId;
    task: string;
    tool: string;
    input: Record<string, unknown>;
    tool_use_id?: string;
  }): Promise<PermissionDecision>;
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
  /** How long `cancel` waits after SIGINT before killing the agent. Default 5000 ms. */
  interruptGraceMs?: number;
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
  /**
   * The daemon calls this after the human answers the run's question (op `answer`): the answer
   * goes to the live agent through its input, or resumes its session (`--resume`) if it ended.
   */
  deliverAnswer(): Promise<"stdin" | "resume">;
  /**
   * Cancels the run: its pending approvals are denied, the agent gets SIGINT (and its input is
   * closed), and if it does not exit in time, SIGTERM to its process group and then SIGKILL.
   * The run ends `cancelled` and the task goes back to `todo`. Resolves with the closed run.
   */
  cancel(): Promise<Run>;
};

export class RunError extends Error {
  readonly code:
    | "not_found"
    | "not_ready"
    | "no_agent"
    | "wrong_provider"
    | "invalid_plan"
    /** `deliverAnswer` found no answer to the agent's question in the plan. */
    | "no_answer"
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
  const launch: Launch = (prompt, resume) =>
    options.adapter.start(
      {
        prompt,
        cwd: run.worktree as string,
        agent: runAgent,
        ...(plan.document.project.checks ? { checks: plan.document.project.checks } : {}),
        mcp: { command: options.mcp.command, args: [...options.mcp.args], env },
        privateDir,
        ...(resume ? { resume } : {}),
      },
      { raw: (line) => void store.appendRaw(id, line).catch(() => undefined) },
    );

  const release = () => {
    if (registered) options.registry?.unregister(id);
  };
  const supervision = new Supervision(options, store, git, launch, run, now, release);
  return {
    run,
    done: supervision.run().finally(async () => {
      release();
      await rm(privateDir, { recursive: true, force: true });
    }),
    setAwaitingApproval: (waiting) => supervision.setAwaitingApproval(waiting),
    deliverAnswer: () => supervision.deliverAnswer(),
    cancel: () => supervision.cancel(),
  };
}

/** Starts the agent: the run's prompt first, then an answer when resuming a session. */
type Launch = (prompt: string, resume?: string) => RunHandle;

class Supervision {
  readonly #options: SupervisorOptions;
  readonly #store: RunStore;
  readonly #git: Git;
  readonly #launch: Launch;
  readonly #id: RunId;
  readonly #task: string;
  readonly #prompt: string;
  readonly #worktree: string;
  readonly #base: string;
  readonly #now: () => string;
  #state: RunState;
  #session: string | undefined;
  readonly #usage = new UsageTally();
  /** Serializes `run.json` updates coming from events and from the daemon. */
  #chain: Promise<unknown> = Promise.resolve();
  /** The agent's process, while it is alive. */
  #handle: RunHandle | null = null;
  /** An answer that arrived while no process was alive, waiting to resume the session. */
  #pendingAnswer: string | null = null;
  /** Wakes a run that waits, without a process, for the human's answer. */
  #wake: (() => void) | null = null;
  #cancelled = false;
  /** Ids of the answer notes already handed to the agent. */
  readonly #delivered = new Set<string>();
  readonly #release: () => void;
  #done: Promise<Run> | null = null;

  constructor(
    options: SupervisorOptions,
    store: RunStore,
    git: Git,
    launch: Launch,
    run: Run,
    now: () => string,
    release: () => void,
  ) {
    this.#release = release;
    this.#options = options;
    this.#store = store;
    this.#git = git;
    this.#launch = launch;
    this.#id = run.id;
    this.#task = run.task;
    this.#prompt = run.prompt as string;
    this.#worktree = run.worktree as string;
    this.#base = run.base_commit as string;
    this.#state = run.state;
    this.#session = run.session_id;
    this.#now = now;
  }

  run(): Promise<Run> {
    this.#done ??= this.#supervise();
    return this.#done;
  }

  async #supervise(): Promise<Run> {
    let prompt = this.#prompt;
    let resume: string | undefined;
    for (;;) {
      const handle = this.#launch(prompt, resume);
      this.#handle = handle;
      const finished = await this.#drain(handle);
      const exit = await handle.exited;
      this.#handle = null;

      // The agent's process is gone while its question is still open: wait for the answer and
      // resume the same session with it.
      const task = await this.#readTask();
      if (!this.#cancelled && task && this.#expectsAnswer(task) && this.#session) {
        await this.#log({ t: "waiting_answer" });
        const answer = await this.#nextAnswer();
        if (answer === null) return this.#serial(() => this.#close(exit, finished));
        await this.#log({ t: "answer", delivery: "resume", session: this.#session, text: answer });
        prompt = answer;
        resume = this.#session;
        continue;
      }
      return this.#serial(() => this.#close(exit, finished));
    }
  }

  /** Feeds the agent's events into the run until its process ends. */
  async #drain(handle: RunHandle): Promise<Extract<RunEvent, { t: "finished" }> | undefined> {
    let finished: Extract<RunEvent, { t: "finished" }> | undefined;
    for await (const event of handle.events) {
      await this.#log(event);
      if (event.t === "started") {
        await this.#serial(async () => {
          if (this.#state === "starting") await this.#move("running");
          if (event.session) {
            this.#session = event.session;
            await this.#store.update(this.#id, { session_id: event.session });
          }
        });
      } else if (event.t === "permission") {
        await this.setAwaitingApproval(true);
        this.#askPermission(handle, event);
      } else if (event.t === "tool" && event.phase === "end") {
        await this.setAwaitingApproval(false);
      } else if (event.t === "usage") {
        this.#usage.add(event);
      } else if (event.t === "turn_end") {
        await this.#afterTurn(handle);
      } else if (event.t === "finished") {
        finished = event;
      }
    }
    return finished;
  }

  /**
   * The human answered the agent's question (op `answer` in the plan): send it to the live
   * process, or resume the session with it if the process has ended.
   */
  async deliverAnswer(): Promise<"stdin" | "resume"> {
    const task = await this.#readTask();
    const message = task ? buildAnswerMessage(task) : null;
    const note = task ? latestAnswer(task) : undefined;
    if (!message || !note) {
      throw new RunError("no_answer", `${this.#task} has no answer to deliver`);
    }
    this.#delivered.add(note.id);
    if (this.#handle) {
      this.#handle.send(message);
      await this.#log({ t: "answer", delivery: "stdin", text: message });
      return "stdin";
    }
    this.#pendingAnswer = message;
    this.#wake?.();
    return "resume";
  }

  /** The next answer to resume with, or `null` if the run is cancelled meanwhile. */
  #nextAnswer(): Promise<string | null> {
    return new Promise((resolve) => {
      const take = () => {
        if (this.#cancelled) {
          this.#wake = null;
          resolve(null);
          return true;
        }
        if (this.#pendingAnswer === null) return false;
        const answer = this.#pendingAnswer;
        this.#pendingAnswer = null;
        this.#wake = null;
        resolve(answer);
        return true;
      };
      if (!take()) this.#wake = () => void take();
    });
  }

  async cancel(): Promise<Run> {
    if (!this.#cancelled) {
      this.#cancelled = true;
      await this.#log({ t: "cancel" });
      this.#release(); // pending approvals are denied right away
      this.#wake?.();
      const handle = this.#handle;
      if (handle) {
        await handle.interrupt();
        handle.endInput();
        const grace = this.#options.interruptGraceMs ?? 5000;
        const timer = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), grace).unref(),
        );
        if ((await Promise.race([handle.exited, timer])) === "timeout") await handle.kill();
      }
    }
    return this.run();
  }

  /**
   * The agent waits for the human: its question is open, or answered in the plan but not yet
   * delivered (the daemon delivers right after writing the answer, which can race a turn's end).
   */
  #expectsAnswer(task: Task): boolean {
    if (task.state !== "doing") return false;
    if (isWaiting(task)) return true;
    const answer = latestAnswer(task);
    return answer !== undefined && !this.#delivered.has(answer.id);
  }

  #log(event: Record<string, unknown>): Promise<void> {
    return this.#store.appendEvent(this.#id, { at: this.#now(), ...event });
  }

  /** Hands an approval the agent asked for to the daemon, and its decision back to the agent. */
  #askPermission(handle: RunHandle, event: Extract<RunEvent, { t: "permission" }>): void {
    if (!handle.answerPermission) return;
    const answer = (decision: PermissionDecision) => {
      void this.#log({ t: "permission_decision", id: event.id, behavior: decision.behavior });
      handle.answerPermission?.(event.id, decision);
    };
    const registry = this.#options.registry;
    if (this.#cancelled) {
      answer({ behavior: "deny", message: "The run was cancelled." });
      return;
    }
    if (!registry?.requestPermission) {
      answer({ behavior: "deny", message: "Nobody can approve it: the run has no daemon." });
      return;
    }
    registry
      .requestPermission({
        run: this.#id,
        task: this.#task,
        tool: event.tool,
        input: event.input ?? { detail: event.detail },
        tool_use_id: event.id,
      })
      .then(answer, () => answer({ behavior: "deny", message: "The approval failed." }));
  }

  setAwaitingApproval(waiting: boolean): Promise<void> {
    return this.#serial(async () => {
      if (waiting && this.#state === "running") await this.#move("waiting_approval");
      if (!waiting && this.#state === "waiting_approval") await this.#move("running");
    });
  }

  /** The turn ended: keep the agent's input open only while it waits for the human's answer. */
  async #afterTurn(handle: RunHandle): Promise<void> {
    if (this.#pendingAnswer !== null && !this.#cancelled) return;
    const task = await this.#readTask();
    if (task && this.#expectsAnswer(task)) return;
    handle.endInput();
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
      usage: this.#usage.toRunUsage(),
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

    if (this.#cancelled && !agentFinished) {
      await this.#log({ t: "cancelled" });
      if (task?.state === "doing") {
        await mutate(
          this.#options.root,
          {
            op: "pause",
            task: this.#task,
            text: `Konsora run ${this.#id} was cancelled. Its work is kept on its branch.`,
          },
          { actor: ACTOR, at: this.#now(), run: this.#id },
        );
      }
      const run = await this.#store.transition(this.#id, "cancelled", fields);
      this.#state = run.state;
      return run;
    }

    const reason = agentFinished
      ? problems.join("; ")
      : exit.code === 0 && exit.signal === null
        ? "the agent stopped without calling finish"
        : exit.signal
          ? `the agent was stopped by ${exit.signal} before calling finish`
          : `the agent exited with code ${exit.code} before calling finish`;
    await this.#log({ t: "error", message: `Run failed: ${reason}`, retryable: false });
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

/** The latest `answer` note, if no question came after it. */
function latestAnswer(task: Task): Note | undefined {
  const notes = task.notes ?? [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i] as Note;
    if (note.kind === "question") return undefined;
    if (note.kind === "answer") return note;
  }
  return undefined;
}
