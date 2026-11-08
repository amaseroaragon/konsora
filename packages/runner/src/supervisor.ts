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
 *    the usage. After each turn the plan says what comes next: the agent called `finish` (the
 *    task keeps doing, with this run's summary) → close the agent's input; it waits for an answer → keep it open; else →
 *    close it, the agent is done without finishing.
 * 4. Close (the process exited): commit what is left as `wip` (never `.konsora/`), record
 *    `head_commit` and `diff.patch` = `base_commit..HEAD` without `.konsora/`, usage and exit.
 *    Finished → `checking`: the checks approved at launch run in the worktree (`checks.ts`,
 *    `checks.json`), then `complete` moves the task to review (or done in a YOLO chain with every
 *    check green) → `succeeded`. Cancelled while checking → `cancelled`. Not finished → `failed`, and the
 *    task goes back to `todo` with a runner note. The worktree stays until integrate or discard.
 */
import { realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSpec,
  blockers,
  buildAnswerMessage,
  buildRebasePrompt,
  buildResumePrompt,
  buildRetryPrompt,
  buildRunPrompt,
  type CheckAttempt,
  checkPassed,
  checkRetries,
  checkSummary,
  checksPassed,
  indexTasks,
  isReady,
  isWaiting,
  type Note,
  newRunId,
  type PlannedCheck,
  plannedChecks,
  plannedSetup,
  type Run,
  type RunCheckResult,
  type RunId,
  type RunSetupResult,
  type RunState,
  RunStateSchema,
  resumeStep,
  runAgentFor,
  skipsReview,
  type Task,
  type TasksDocument,
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
import { runCheck, runChecks } from "./checks.ts";
import { type Git, systemGit } from "./git.ts";
import { IntegrationError, integrateRun } from "./integrate.ts";
import { RunStore } from "./run-store.ts";
import { UsageTally } from "./usage.ts";
import { prepareWorktree, removeWorktree, runGitWritePaths, WorktreeError } from "./worktree.ts";

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
  /** The environment the checks' is derived from (minus `KONSORA_*`). Default `process.env`. */
  checkEnv?: NodeJS.ProcessEnv;
  /** Between SIGTERM and SIGKILL when a check times out or is cancelled. Default 5000 ms. */
  checkKillGraceMs?: number;
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
    /** `startRebaseRun`: the run is not a succeeded run whose integration conflicts. */
    | "not_rebasable"
    /** `startRebaseRun`: the run's branch integrates cleanly now; integrate it again instead. */
    | "no_conflict"
    /** `resumeRun`: the run is not interrupted, or its worktree or task cannot take it back. */
    | "not_resumable"
    /** The run was created but could not start; it is left `failed`. */
    | "launch_failed";
  constructor(code: RunError["code"], message: string) {
    super(message);
    this.name = "RunError";
    this.code = code;
  }
}

const ACTOR = "konsora";
const NO_EXIT = { code: null, signal: null };
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
  const agent = runAgentFor(task, plan.document, input.agent);
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

  return launchRun(options, store, git, now, plan.document, run, {
    taskOp: { op: "start", task: task.id, text: `Konsora run ${id} started.` },
    setup: plannedSetup(plan.document),
  });
}

/**
 * Asks the agent to rebase a run whose integration conflicts (M9, RUN-24): a new run of the same
 * task on the same branch and worktree, resuming the agent's session when there is one, with
 * `buildRebasePrompt` (the conflicting files and the current tip of `base_branch`). The task goes
 * from review to doing; the checks run as in any run and it comes back to review. No setup: the
 * worktree is already prepared. If this run succeeds, the conflicting run is discarded (its
 * worktree and branch now belong to this one); if it fails or is cancelled, the task returns to
 * review and the conflicting run stays as it was, to resolve by hand.
 */
export async function startRebaseRun(
  options: SupervisorOptions,
  input: { run: RunId },
): Promise<RunSession> {
  const store = options.store ?? new RunStore(options.root);
  const git = options.git ?? systemGit;
  const now = () => timestamp(options.now?.() ?? new Date());

  const plan = await readTasks(options.root);
  if (!plan.ok) throw new RunError("invalid_plan", plan.error.message);
  const conflicted = await store.read(input.run);
  const { worktree, branch, head_commit: head } = conflicted;
  if (conflicted.state !== "succeeded" || conflicted.integration?.state !== "conflict") {
    throw new RunError(
      "not_rebasable",
      `Run ${conflicted.id} has no integration conflict; only a conflicting run can be rebased`,
    );
  }
  if (!worktree || !branch || !head) {
    throw new RunError("not_rebasable", `Run ${conflicted.id} has no branch to rebase`);
  }
  const task = indexTasks(plan.document).get(conflicted.task);
  if (!task) throw new RunError("not_found", `Task ${conflicted.task} does not exist`);
  if (task.state !== "review") {
    throw new RunError(
      "not_ready",
      `${task.id} is ${task.state}; a rebase run needs the task in review`,
    );
  }
  if (conflicted.agent.provider !== options.adapter.id) {
    throw new RunError(
      "wrong_provider",
      `Run ${conflicted.id} used ${conflicted.agent.provider}, but this runner uses ${options.adapter.id}`,
    );
  }
  const onBranch = await git
    .run(["symbolic-ref", "-q", "HEAD"], { cwd: worktree })
    .catch(() => null);
  if (onBranch?.code !== 0 || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
    throw new RunError(
      "not_rebasable",
      `The worktree of run ${conflicted.id} is gone or left its branch; resolve the conflict by hand`,
    );
  }
  const baseBranch = plan.document.project.base_branch;
  const tipResult = await git.run(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`],
    { cwd: options.root },
  );
  if (tipResult.code !== 0) {
    throw new RunError("not_rebasable", `Base branch "${baseBranch}" does not exist`);
  }
  const tip = tipResult.stdout.trim();
  const merged = await git.run(
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, head],
    { cwd: options.root },
  );
  if (merged.code === 0) {
    throw new RunError(
      "no_conflict",
      `Run ${conflicted.id} integrates cleanly into ${baseBranch} now; accept the task again`,
    );
  }
  if (merged.code !== 1) {
    throw new RunError("not_rebasable", "git could not compare the run with the base branch");
  }
  const files = merged.stdout.split("\n").slice(1).filter(Boolean);

  const created = await store.create({
    id: newRunId(),
    task: task.id,
    task_hash: taskHash(task),
    agent: conflicted.agent,
    state: "queued",
    rebase_of: conflicted.id,
  });
  await store.transition(created.id, "starting", { started_at: now() });
  const run = await store.update(created.id, {
    worktree,
    branch,
    base_commit: tip,
    prompt: buildRebasePrompt(plan.document, task.id, { branch, onto: tip, files }),
  });
  return launchRun(options, store, git, now, plan.document, run, {
    taskOp: {
      op: "rebase",
      task: task.id,
      text: `Konsora run ${run.id} rebases run ${conflicted.id} onto ${baseBranch} to resolve its conflict${files.length ? ` in ${files.join(", ")}` : ""}.`,
    },
    setup: null,
    ...(conflicted.session_id ? { resume: conflicted.session_id } : {}),
    rebaseOf: conflicted.id,
  });
}

type LaunchPlan = {
  /**
   * What moves the task to doing: `start` (todo) or `rebase` (review); a resumed run only notes
   * it (`note`), since its task is still doing.
   */
  taskOp: { op: "start" | "rebase" | "note"; task: string; text: string };
  setup: { command: string; timeout_s: number } | null;
  /** A session to resume on the first launch. */
  resume?: string;
  rebaseOf?: RunId;
  /** What a resumed run carries over from before its interruption. */
  resumed?: Resumed;
};

/** A resumed run (RUN-27): where it goes back to, and what it had done so far. */
type Resumed = {
  /** `checks`: the agent had finished, only the checks run again. */
  step: "agent" | "checks";
  /** The first message to the agent (`buildResumePrompt`, or the run's own prompt). */
  prompt: string;
  /** Check attempts already in `checks.json`, and the summary of the last one. */
  attempts: number;
  lastChecks: RunCheckResult[];
  /** Summary notes that a recorded check attempt already checked. */
  checkedSummaries: string[];
  /** The `usage` events logged before the interruption. */
  usage: Extract<RunEvent, { t: "usage" }>[];
  exit: { code: number | null; signal: string | null };
};

/**
 * Resumes a run left `interrupted` by a daemon that stopped (RUN-27), for the human: in the same
 * worktree and branch, with the same agent. Its task must still be doing. If it was interrupted
 * while `checking`, the agent had finished and only the checks run again; otherwise the agent
 * resumes its session with `buildResumePrompt` (or, with no session, starts over with the run's
 * own prompt). `project.setup` runs again only if it had not finished. Nothing changes when the
 * run cannot be resumed.
 */
export async function resumeRun(
  options: SupervisorOptions,
  input: { run: RunId },
): Promise<RunSession> {
  const store = options.store ?? new RunStore(options.root);
  const git = options.git ?? systemGit;
  const now = () => timestamp(options.now?.() ?? new Date());

  const plan = await readTasks(options.root);
  if (!plan.ok) throw new RunError("invalid_plan", plan.error.message);
  const run = await store.read(input.run);
  if (run.state !== "interrupted") {
    throw new RunError(
      "not_resumable",
      `Run ${run.id} is ${run.state}; only an interrupted run can be resumed`,
    );
  }
  const { worktree, branch, base_commit: base, prompt } = run;
  if (!worktree || !branch || !base || !prompt) {
    throw new RunError(
      "not_resumable",
      `Run ${run.id} was interrupted before its worktree was ready; discard it and run the task again`,
    );
  }
  const onBranch = await git
    .run(["symbolic-ref", "-q", "HEAD"], { cwd: worktree })
    .catch(() => null);
  if (onBranch?.code !== 0 || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
    throw new RunError(
      "not_resumable",
      `The worktree of run ${run.id} is gone or left its branch; discard the run and run the task again`,
    );
  }
  const task = indexTasks(plan.document).get(run.task);
  if (!task) throw new RunError("not_found", `Task ${run.task} does not exist`);
  if (task.state !== "doing") {
    throw new RunError(
      "not_resumable",
      `${task.id} is ${task.state}, no longer doing; discard run ${run.id} instead`,
    );
  }
  if (run.agent.provider !== options.adapter.id) {
    throw new RunError(
      "wrong_provider",
      `Run ${run.id} used ${run.agent.provider}, but this runner uses ${options.adapter.id}`,
    );
  }

  // What the run had done before it stopped: its log, its check attempts and its summaries.
  const events = (await store.readEvents(run.id)) as Record<string, unknown>[];
  const stopped = events.findLast((e) => e.t === "interrupted");
  const from = RunStateSchema.safeParse(stopped?.from);
  const step = resumeStep(from.success ? from.data : undefined);
  const checksFile = await store.readChecks(run.id);
  const attempts = checksFile?.attempts ?? [];
  const lastAttempt = attempts.at(-1);
  const checkedSummaries = lastAttempt
    ? (task.notes ?? [])
        .filter((n) => n.kind === "summary" && n.run === run.id && n.at <= lastAttempt.started_at)
        .map((n) => n.id)
    : [];
  const usage = events.filter((e) => e.t === "usage") as Extract<RunEvent, { t: "usage" }>[];
  const session = run.session_id;
  const message = session ? buildResumePrompt(task.id) : prompt;
  const setup =
    !run.setup && !run.rebase_of && step === "agent" ? plannedSetup(plan.document) : null;

  const started = await store.transition(run.id, "starting");
  await store.appendEvent(run.id, {
    at: now(),
    t: "resumed",
    from: from.success ? from.data : null,
    step,
    ...(step === "agent" ? { prompt: message, ...(session ? { session } : {}) } : {}),
  });
  return launchRun(options, store, git, now, plan.document, started, {
    taskOp: {
      op: "note",
      task: task.id,
      text:
        step === "checks"
          ? `Konsora run ${run.id} resumed after Konsora restarted: its checks run again.`
          : `Konsora run ${run.id} resumed after Konsora restarted${session ? ", in the agent's session" : ", from its prompt (the agent had no session to resume)"}.`,
    },
    setup,
    ...(session ? { resume: session } : {}),
    ...(run.rebase_of ? { rebaseOf: run.rebase_of } : {}),
    resumed: {
      step,
      prompt: message,
      attempts: attempts.length,
      lastChecks: run.checks ?? (lastAttempt ? checkSummary(lastAttempt) : []),
      checkedSummaries,
      usage,
      exit: run.exit ?? { code: null, signal: null },
    },
  });
}

/** Registers a prepared (`starting`) run, moves its task to doing and supervises the agent. */
async function launchRun(
  options: SupervisorOptions,
  store: RunStore,
  git: Git,
  now: () => string,
  document: TasksDocument,
  prepared: Run,
  how: LaunchPlan,
): Promise<RunSession> {
  const run = prepared;
  const id = run.id;
  const task = { id: run.task };
  const runAgent = run.agent;
  const plan = { document };
  const privateDir = join(options.privateDir, id);
  const abort = async (message: string): Promise<never> => {
    await store.appendEvent(id, { at: now(), t: "error", message, retryable: false });
    await store.transition(id, "failed", { finished_at: now() });
    await rm(privateDir, { recursive: true, force: true });
    throw new RunError("launch_failed", message);
  };

  // ── Launch ─────────────────────────────────────────────────────────────────
  const gitWritePaths = await runGitWritePaths(run.worktree as string, run.branch as string, git);
  let registered: { url: string; token: string } | null = null;
  try {
    registered = options.registry
      ? await options.registry.register({ run: id, task: task.id })
      : null;
  } catch {
    return abort("The daemon could not register the run for permission approvals");
  }
  const started = await mutate(options.root, how.taskOp, { actor: ACTOR, at: now(), run: id });
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
        ...(gitWritePaths.length ? { gitWritePaths } : {}),
        ...(resume ? { resume } : {}),
      },
      { raw: (line) => void store.appendRaw(id, line).catch(() => undefined) },
    );

  const release = () => {
    if (registered) options.registry?.unregister(id);
  };
  // The checks as approved now, at launch: later edits to the plan do not change this run's.
  const checks = plannedChecks(plan.document, task.id);
  const setup = how.setup;
  const retries = checkRetries(plan.document.project);
  const supervision = new Supervision(
    options,
    store,
    git,
    launch,
    run,
    now,
    release,
    checks,
    setup,
    retries,
    how.resume,
    how.rebaseOf,
    how.resumed,
  );
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
  readonly #branch: string;
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
  readonly #checks: readonly PlannedCheck[];
  readonly #setup: { command: string; timeout_s: number } | null;
  /** Stops the check in progress when the run is cancelled during `checking`. */
  #checksAbort: AbortController | null = null;
  /** Check attempts so far (checks.json). */
  #attempts = 0;
  /** `project.check_retries` at launch: how many failed attempts go back to the agent. */
  readonly #retries: number;
  /** The last attempt's summary, kept in `run.json` whatever happens next. */
  #lastChecks: RunCheckResult[] = [];
  /** Summary notes already checked: after a retry, only a new `finish` counts. */
  readonly #checkedSummaries = new Set<string>();
  /** The session the first launch resumes (a rebase run continues the conflicting run's). */
  readonly #firstResume: string | undefined;
  /** For a rebase run: the run whose conflict it resolves. */
  readonly #rebaseOf: RunId | undefined;
  /** For a resumed run: where it goes back to and what it had done (RUN-27). */
  readonly #resumed: Resumed | undefined;

  constructor(
    options: SupervisorOptions,
    store: RunStore,
    git: Git,
    launch: Launch,
    run: Run,
    now: () => string,
    release: () => void,
    checks: readonly PlannedCheck[],
    setup: { command: string; timeout_s: number } | null,
    retries: number,
    resume?: string,
    rebaseOf?: RunId,
    resumed?: Resumed,
  ) {
    this.#resumed = resumed;
    if (resumed) {
      this.#attempts = resumed.attempts;
      this.#lastChecks = resumed.lastChecks;
      for (const id of resumed.checkedSummaries) this.#checkedSummaries.add(id);
      for (const event of resumed.usage) this.#usage.add(event);
    }
    this.#firstResume = resume;
    this.#rebaseOf = rebaseOf;
    this.#retries = retries;
    this.#release = release;
    this.#checks = checks;
    this.#setup = setup;
    this.#options = options;
    this.#store = store;
    this.#git = git;
    this.#launch = launch;
    this.#id = run.id;
    this.#task = run.task;
    this.#prompt = run.prompt as string;
    this.#worktree = run.worktree as string;
    this.#base = run.base_commit as string;
    this.#branch = run.branch as string;
    this.#state = run.state;
    this.#session = run.session_id;
    this.#now = now;
  }

  run(): Promise<Run> {
    this.#done ??= this.#supervise();
    return this.#done;
  }

  async #supervise(): Promise<Run> {
    // `project.setup` prepares the worktree first; if it fails, the agent is never launched.
    if (this.#setup) {
      const setup = await this.#runSetup(this.#setup);
      if (this.#cancelled) {
        const task = await this.#readTask();
        return this.#serial(() => this.#closeCancelled(task, { finished_at: this.#now(), setup }));
      }
      if (setup.exit_code !== 0 || setup.timed_out) {
        return this.#serial(() => this.#failSetup(setup));
      }
    }
    let prompt = this.#resumed?.prompt ?? this.#prompt;
    let resume: string | undefined = this.#firstResume;
    if (this.#resumed?.step === "checks") {
      // Interrupted while checking: the agent had finished, so only the checks run again.
      const closed = await this.#serial(() =>
        this.#close(this.#resumed?.exit ?? NO_EXIT, undefined),
      );
      if (!("retry" in closed)) return closed;
      prompt = closed.retry;
      resume = this.#session;
    }
    for (;;) {
      const handle = this.#launch(prompt, resume);
      this.#handle = handle;
      const finished = await this.#drain(handle);
      const exit = await handle.exited;
      this.#handle = null;

      // The agent's process is gone while its question is still open: wait for the answer and
      // resume the same session with it.
      const task = await this.#readTask();
      // An answer can also be pending already, if the process could not take it while alive.
      const waiting = this.#pendingAnswer !== null || (task !== null && this.#expectsAnswer(task));
      if (!this.#cancelled && waiting && this.#session) {
        await this.#log({ t: "waiting_answer" });
        const answer = await this.#nextAnswer();
        if (answer === null) return this.#serial(() => this.#closeRun(exit, finished));
        await this.#log({ t: "answer", delivery: "resume", session: this.#session, text: answer });
        prompt = answer;
        resume = this.#session;
        continue;
      }
      const closed = await this.#serial(() => this.#close(exit, finished));
      if ("retry" in closed) {
        // Failed checks go back to the same agent, in the same session.
        prompt = closed.retry;
        resume = this.#session;
        continue;
      }
      return closed;
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
          if (event.session) this.#session = event.session;
          const fields = {
            ...(event.session ? { session_id: event.session } : {}),
            ...(event.transport ? { transport: event.transport } : {}),
          };
          if (Object.keys(fields).length > 0) await this.#store.update(this.#id, fields);
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
    if (this.#handle && this.#handle.acceptsInput !== false) {
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
      this.#checksAbort?.abort(); // stops the check in progress, if any
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

  /** Closes the run for good (no retry possible: it was cancelled). */
  async #closeRun(
    exit: { code: number | null; signal: string | null },
    finished: Extract<RunEvent, { t: "finished" }> | undefined,
  ): Promise<Run> {
    const closed = await this.#close(exit, finished, false);
    if ("retry" in closed) throw new Error("unreachable: no retry when closing for good");
    return closed;
  }

  /**
   * The agent's process ended: collect its work and, if it finished, run the checks. A failed
   * attempt with retries left returns `{retry}` (the prompt for the agent) with the run back in
   * `running`; otherwise the run is closed.
   */
  async #close(
    exit: { code: number | null; signal: string | null },
    finished: Extract<RunEvent, { t: "finished" }> | undefined,
    mayRetry = true,
  ): Promise<Run | { retry: string }> {
    const problems: string[] = [];
    let head: string | undefined;
    try {
      await this.#checkWorktree();
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
    // After a retry, the summary that led to it does not count: the agent must finish again.
    const fresh = summary !== undefined && !this.#checkedSummaries.has(summary.id);
    // Inside a run, `finish` leaves the task doing with this run's summary; `complete` moves it.
    const agentFinished =
      task !== null &&
      (task.state === "review" || task.state === "done" || (task.state === "doing" && fresh));
    const fields = {
      finished_at: this.#now(),
      exit,
      usage: this.#usage.toRunUsage(),
      checks: this.#lastChecks,
      ...(this.#attempts > 0 ? { check_attempts: this.#attempts } : {}),
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
      const attempt = this.#cancelled ? null : await this.#runCheckAttempt();
      const checked = attempt
        ? { ...fields, checks: checkSummary(attempt.attempt), check_attempts: this.#attempts }
        : fields;
      if (!attempt || attempt.cancelled || this.#cancelled) {
        return this.#closeCancelled(task, checked);
      }
      this.#lastChecks = checked.checks;
      if (summary) this.#checkedSummaries.add(summary.id);
      const passed = checksPassed(attempt.attempt.results);
      const used = attempt.attempt.attempt - 1;
      const resumable = this.#session !== undefined;
      if (!passed && used < this.#retries && mayRetry && resumable && task?.state === "doing") {
        return this.#retry(attempt.attempt, checked);
      }
      // An intermediate task of a YOLO chain with every check green is integrated before
      // `complete` takes it to done, so its dependents start from a base with its commit. Only a
      // succeeded run can be integrated, so in that case the run succeeds first.
      const integrate = task?.state === "doing" && passed && (await this.#skipsReview());
      let run: Run | null = null;
      if (integrate) {
        run = await this.#store.transition(this.#id, "succeeded", checked);
        this.#state = run.state;
        await this.#supersede();
      }
      if (task?.state === "doing") {
        const integration = integrate ? await this.#integrate() : null;
        const text = passed
          ? integration && !integration.ok
            ? integration.note
            : undefined
          : this.#failedChecksNote(attempt.attempt, used, used < this.#retries && !resumable);
        await mutate(
          this.#options.root,
          {
            op: "complete",
            task: this.#task,
            checks_passed: passed,
            ...(integration?.ok ? { integrated: true } : {}),
            ...(text ? { text } : {}),
          },
          { actor: ACTOR, at: this.#now(), run: this.#id },
        );
      }
      if (run) return this.#store.read(this.#id);
      run = await this.#store.transition(this.#id, "succeeded", checked);
      this.#state = run.state;
      await this.#supersede();
      return run;
    }

    if (this.#cancelled && !agentFinished) return this.#closeCancelled(task, fields);

    const reason = agentFinished
      ? problems.join("; ")
      : exit.code === 0 && exit.signal === null
        ? "the agent stopped without calling finish"
        : exit.signal
          ? `the agent was stopped by ${exit.signal} before calling finish`
          : `the agent exited with code ${exit.code} before calling finish`;
    await this.#log({ t: "error", message: `Run failed: ${reason}`, retryable: false });
    if (task?.state === "doing") {
      await this.#returnTask(
        `Konsora run ${this.#id} failed: ${reason}. Its work is kept on its branch for review.`,
      );
    }
    const run = await this.#store.transition(this.#id, "failed", fields);
    this.#state = run.state;
    return run;
  }

  /** Cancelled: the task goes back to todo (its work stays on the branch), the run `cancelled`. */
  async #closeCancelled(task: Task | null, fields: Parameters<RunStore["transition"]>[2]) {
    await this.#log({ t: "cancelled" });
    if (task?.state === "doing") {
      await this.#returnTask(
        `Konsora run ${this.#id} was cancelled. Its work is kept on its branch.`,
      );
    }
    const run = await this.#store.transition(this.#id, "cancelled", fields);
    this.#state = run.state;
    return run;
  }

  /**
   * The run ends without the agent's work being checked: the task goes back to todo, or, for a
   * rebase run, back to review, where the conflicting run is still waiting.
   */
  async #returnTask(text: string): Promise<void> {
    const rebase = this.#rebaseOf;
    await mutate(
      this.#options.root,
      rebase
        ? {
            op: "rebase-abort",
            task: this.#task,
            text: `${text} The task is back in review with run ${rebase}'s conflict: resolve it by hand or ask for another rebase.`,
          }
        : { op: "pause", task: this.#task, text },
      { actor: ACTOR, at: this.#now(), run: this.#id },
    );
  }

  async #skipsReview(): Promise<boolean> {
    const plan = await readTasks(this.#options.root);
    return plan.ok && skipsReview(plan.document, this.#task);
  }

  /**
   * Integrates this (succeeded) run into the base branch, as `accept` does: one squashed commit
   * with the trailers, then the worktree and branch go. A run that changed nothing is discarded.
   * A conflict leaves `integration = conflict`; any failure returns the note that explains it.
   */
  async #integrate(): Promise<{ ok: true } | { ok: false; note: string }> {
    const plan = await readTasks(this.#options.root);
    if (!plan.ok) {
      return { ok: false, note: this.#notIntegrated("the plan could not be read") };
    }
    const base = plan.document.project.base_branch;
    try {
      const result = await integrateRun({
        root: this.#options.root,
        worktreesDir: this.#options.worktreesDir,
        document: plan.document,
        runId: this.#id,
        store: this.#store,
        git: this.#git,
      });
      if (result.status === "merged") {
        await this.#log({ t: "integrated", commit: result.commit });
        return { ok: true };
      }
      await this.#log({ t: "integration_conflict", files: result.files });
      return {
        ok: false,
        note: `Konsora run ${this.#id}: every check passed, but its work conflicts with ${base}${result.files.length ? ` in ${result.files.join(", ")}` : ""}. ${this.#task} is in review instead of done, and the YOLO chain waits for it: ask the agent to rebase it or resolve the conflict by hand.`,
      };
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "nothing_to_integrate") {
        await this.#store.integrate(this.#id, "discarded");
        await removeWorktree({
          root: this.#options.root,
          worktreesDir: this.#options.worktreesDir,
          worktree: this.#worktree,
          branch: this.#branch,
          git: this.#git,
        }).catch(() => undefined);
        return { ok: true };
      }
      const why = error instanceof IntegrationError ? error.message : "git failed";
      await this.#log({ t: "error", message: `Integration failed: ${why}`, retryable: true });
      return { ok: false, note: this.#notIntegrated(why) };
    }
  }

  #notIntegrated(why: string): string {
    return `Konsora run ${this.#id}: every check passed, but its work could not be integrated (${why}). ${this.#task} is in review instead of done, and the YOLO chain waits for it: accept it to integrate it.`;
  }

  /**
   * A rebase run succeeded: the conflicting run is discarded. Its worktree and branch are not
   * removed, because they are this run's now.
   */
  async #supersede(): Promise<void> {
    if (!this.#rebaseOf) return;
    const old = await this.#store.read(this.#rebaseOf).catch(() => null);
    if (old?.integration?.state !== "conflict") return;
    await this.#store.integrate(old.id, "discarded").catch(() => undefined);
    await this.#log({ t: "superseded", run: old.id });
  }

  /**
   * One pass over the run's checks in its worktree: events for the live log, the attempt in
   * `checks.json`. With no checks there is nothing to run and nothing is written.
   */
  async #runCheckAttempt(): Promise<{ attempt: CheckAttempt; cancelled: boolean }> {
    const number = this.#attempts + 1;
    if (this.#checks.length === 0) {
      return {
        attempt: { attempt: number, started_at: this.#now(), results: [] },
        cancelled: false,
      };
    }
    this.#checksAbort = new AbortController();
    try {
      const result = await runChecks(this.#checks, number, {
        cwd: this.#worktree,
        signal: this.#checksAbort.signal,
        now: this.#now,
        onEvent: (event) => this.#log(event),
        ...(this.#options.checkEnv ? { env: this.#options.checkEnv } : {}),
        ...(this.#options.checkKillGraceMs !== undefined
          ? { killGraceMs: this.#options.checkKillGraceMs }
          : {}),
      });
      this.#attempts = number;
      await this.#store.appendCheckAttempt(this.#id, result.attempt);
      return result;
    } finally {
      this.#checksAbort = null;
    }
  }

  /** Runs `project.setup` in the worktree, logging its start and its end with its output. */
  async #runSetup(setup: { command: string; timeout_s: number }): Promise<RunSetupResult> {
    await this.#log({ t: "setup", phase: "start", command: setup.command });
    this.#checksAbort = new AbortController();
    try {
      const result = await runCheck(
        { id: "setup", source: "project", command: setup.command, timeout_s: setup.timeout_s },
        {
          cwd: this.#worktree,
          signal: this.#checksAbort.signal,
          ...(this.#options.checkEnv ? { env: this.#options.checkEnv } : {}),
          ...(this.#options.checkKillGraceMs !== undefined
            ? { killGraceMs: this.#options.checkKillGraceMs }
            : {}),
        },
      );
      const summary: RunSetupResult = {
        command: result.command,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
      };
      await this.#log({
        t: "setup",
        phase: "end",
        ...summary,
        output: result.output,
        ...(result.output_truncated ? { output_truncated: true } : {}),
      });
      await this.#store.update(this.#id, { setup: summary });
      return summary;
    } finally {
      this.#checksAbort = null;
    }
  }

  /** The setup failed: the agent never ran, the task goes back to todo, the run `failed`. */
  async #failSetup(setup: RunSetupResult): Promise<Run> {
    const how = setup.timed_out
      ? `ran out of time after ${Math.round(setup.duration_ms / 1000)} s`
      : setup.exit_code === null
        ? "was stopped by a signal"
        : `exited with code ${setup.exit_code}`;
    const reason = `the setup command \`${setup.command}\` ${how}`;
    await this.#log({ t: "error", message: `Run failed: ${reason}`, retryable: false });
    const task = await this.#readTask();
    if (task?.state === "doing") {
      await this.#returnTask(
        `Konsora run ${this.#id} failed before launching the agent: ${reason}. Its output is in the run's log. Fix project.setup or the project, then run the task again.`,
      );
    }
    const run = await this.#store.transition(this.#id, "failed", {
      finished_at: this.#now(),
      setup,
    });
    this.#state = run.state;
    return run;
  }

  /**
   * A failed attempt with retries left: the run goes back to `running`, the task gets a note,
   * and the agent gets the failed checks (`buildRetryPrompt`) in its own session.
   */
  async #retry(
    attempt: CheckAttempt,
    fields: Parameters<RunStore["update"]>[1],
  ): Promise<{ retry: string }> {
    const retry = attempt.attempt; // the retry about to start: 1, 2…
    const failed = this.#failedList(attempt);
    await this.#store.update(this.#id, fields);
    await this.#move("running");
    await this.#log({ t: "retry", attempt: retry, of: this.#retries, failed });
    await mutate(
      this.#options.root,
      {
        op: "note",
        task: this.#task,
        text: `Konsora run ${this.#id}: checks failed: ${failed.join(", ")}. The agent gets them back to fix (retry ${retry} of ${this.#retries}).`,
      },
      { actor: ACTOR, at: this.#now(), run: this.#id },
    );
    return { retry: buildRetryPrompt(this.#task, attempt, this.#retries - retry) };
  }

  #failedList(attempt: CheckAttempt): string[] {
    return attempt.results
      .filter((r) => !checkPassed(r))
      .map((r) =>
        r.timed_out
          ? `${r.id} (timed out)`
          : r.exit_code === null
            ? `${r.id} (stopped)`
            : `${r.id} (exit ${r.exit_code})`,
      );
  }

  /** The Konsora note on a task whose checks failed for good. */
  #failedChecksNote(attempt: CheckAttempt, used: number, noSession: boolean): string {
    const why = noSession
      ? " The agent's session could not be resumed to retry them."
      : used > 0
        ? ` They still fail after ${used} ${used === 1 ? "retry" : "retries"}.`
        : "";
    return `Konsora run ${this.#id}: checks failed: ${this.#failedList(attempt).join(", ")}.${why} The task is in review with its checks failing.`;
  }

  /**
   * Konsora's own git commands below run outside any sandbox, in the worktree. A sandboxed agent
   * may write the worktree's git dir (`gitWritePaths`), so before trusting it, check that it is
   * still on the run's branch and in the project's repo: otherwise a rewritten `HEAD` or
   * `commondir` would let Konsora's commit move another branch.
   */
  async #checkWorktree(): Promise<void> {
    const head = await this.#gitOut(["symbolic-ref", "-q", "HEAD"]);
    if (head !== `refs/heads/${this.#branch}`) throw new Error("the worktree left its branch");
    const common = async (cwd: string) => {
      const out = await this.#git.run(["rev-parse", "--git-common-dir"], { cwd });
      if (out.code !== 0) throw new Error("git rev-parse failed");
      return realpath(resolve(cwd, out.stdout.trim()));
    };
    if ((await common(this.#worktree)) !== (await common(this.#options.root))) {
      throw new Error("the worktree points to another repository");
    }
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
