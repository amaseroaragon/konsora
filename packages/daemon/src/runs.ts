/**
 * Runs in the daemon (DMN-04): the daemon supervises the runner for the human.
 *
 * - Launching only happens on the human's explicit request (`POST /projects/:id/runs`).
 * - Each project gets a run store that also publishes what it writes: `run.event` (every line of
 *   `events.jsonl`, in the same order) and `run.state` (every change of `run.json`) go to the
 *   project's WebSocket subscribers.
 * - A run registers with `Approvals` for its permission token; a pending approval moves it to
 *   `waiting_approval` and back.
 * - Worktrees live in `<data>/worktrees/<project-id>/`, the runs' private files (MCP config with
 *   the run token) in `<data>/projects/<project-id>/runs/`.
 * - At start-up, runs that were alive when the daemon stopped become `interrupted`.
 */
import { join } from "node:path";
import {
  type AgentSpec,
  type ChecksFile,
  checkAgent,
  chooseVariant,
  integrableRun,
  isActiveRunState,
  isReviewRun,
  MAX_VARIANTS,
  MIN_VARIANTS,
  type Provider,
  READONLY_PROFILE,
  type Run,
  type RunId,
  RunIdSchema,
  reviewerAgent,
  runAgentFor,
  type VariantError,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import {
  type AgentAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  findOrphanWorktrees,
  type Git,
  type IntegrationResult,
  integrateRun,
  type McpServerSpec,
  type OrphanWorktree,
  type RateLimits,
  RunError,
  type RunSession,
  RunStore,
  RunStoreError,
  recoverRuns,
  removeWorktree,
  resumeRun,
  type SupervisorOptions,
  settleVariants,
  startRebaseRun,
  startReviewRun,
  startRun,
} from "@konsora/runner";
import { AgentCatalog } from "./agents.ts";
import type { ApprovalEvent, Approvals } from "./approvals.ts";
import { Limits } from "./limits.ts";
import type { Project, Registry } from "./registry.ts";

export type Publish = (project: string, payload: unknown) => void;

type RunUsageEvent = { t?: string; at?: unknown; rate_limits?: RateLimits };

export type RunManagerOptions = {
  registry: Registry;
  approvals: Approvals;
  /** Konsora's data dir (worktrees and the runs' private files live under it). */
  dataDir: string;
  /** The daemon's own URL, for the run's MCP to ask for permissions. */
  daemonUrl: () => string;
  /** How to launch `konsora mcp`; the runner adds the run-mode environment. */
  mcp: Pick<McpServerSpec, "command" | "args">;
  publish?: Publish;
  /** Sends an event to every client, whatever project it watches (`limits.updated`). */
  broadcast?: (payload: unknown) => void;
  /** How long a direct read of the providers' rate limits is kept. Default 60 s. */
  limitsTtlMs?: number;
  adapters?: Partial<Record<Provider, AgentAdapter>>;
  git?: Git;
  now?: () => Date;
  /** Passed to the supervisor (tests shorten it). */
  interruptGraceMs?: number;
  /** How long the agent catalog is kept. Default 30 s. */
  catalogTtlMs?: number;
  /** How long an approval asked through the agent's own protocol (Codex) waits. Default 300 s. */
  permissionWaitMs?: number;
  /** Called once a run this daemon supervises has closed (the scheduler looks again). */
  onRunClosed?: (project: Project) => void;
};

/** The same default wait as the MCP `permission` tool's (`wait_s`). */
const PERMISSION_WAIT_MS = 300_000;

export class RunManagerError extends Error {
  readonly code:
    | "not_found"
    | "not_active"
    | "no_adapter"
    | "not_discardable"
    | "invalid_agent"
    | "no_slots"
    | VariantError["code"];
  constructor(code: RunManagerError["code"], message: string) {
    super(message);
    this.name = "RunManagerError";
    this.code = code;
  }
}

/** A run store that tells the project's subscribers about every write. */
class PublishingRunStore extends RunStore {
  readonly #emit: (payload: unknown) => void;
  constructor(root: string, emit: (payload: unknown) => void) {
    super(root);
    this.#emit = emit;
  }
  override async create(run: Run): Promise<Run> {
    const created = await super.create(run);
    this.#emit({ type: "run.state", run: created });
    return created;
  }
  override async update(...args: Parameters<RunStore["update"]>): Promise<Run> {
    const run = await super.update(...args);
    this.#emit({ type: "run.state", run });
    return run;
  }
  override async transition(...args: Parameters<RunStore["transition"]>): Promise<Run> {
    const run = await super.transition(...args);
    this.#emit({ type: "run.state", run });
    return run;
  }
  override async integrate(...args: Parameters<RunStore["integrate"]>): Promise<Run> {
    const run = await super.integrate(...args);
    this.#emit({ type: "run.state", run });
    return run;
  }
  override async appendEvent(id: RunId, event: Record<string, unknown>): Promise<void> {
    await super.appendEvent(id, event);
    this.#emit({ type: "run.event", run: id, event });
  }
}

export class RunManager {
  readonly #options: RunManagerOptions;
  readonly #stores = new Map<string, PublishingRunStore>();
  /** Live runs: their supervisor sessions, by run id. */
  readonly #sessions = new Map<RunId, { project: string; task: string; session: RunSession }>();

  readonly #adapters: Partial<Record<Provider, AgentAdapter>>;
  readonly catalog: AgentCatalog;
  readonly limits: Limits;

  constructor(options: RunManagerOptions) {
    this.#options = options;
    // Given adapters are the whole set (tests); otherwise the installed Claude Code and Codex.
    this.#adapters = options.adapters ?? {
      claude: createClaudeAdapter(),
      codex: createCodexAdapter(),
    };
    this.catalog = new AgentCatalog(this.#adapters, {
      ...(options.catalogTtlMs !== undefined ? { ttlMs: options.catalogTtlMs } : {}),
    });
    this.limits = new Limits({
      adapters: this.#adapters,
      runs: () => this.#allRuns(),
      ...(options.broadcast ? { broadcast: options.broadcast } : {}),
      ...(options.limitsTtlMs !== undefined ? { ttlMs: options.limitsTtlMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  store(project: Project): RunStore {
    let store = this.#stores.get(project.id);
    if (!store) {
      const publish = this.#options.publish ?? (() => undefined);
      const created: PublishingRunStore = new PublishingRunStore(project.path, (payload) => {
        publish(project.id, { ...(payload as object), project: project.id });
        void this.#noteUsage(created, payload).catch(() => undefined);
      });
      store = created;
      this.#stores.set(project.id, store);
    }
    return store;
  }

  worktreesDir(project: Project): string {
    return join(this.#options.dataDir, "worktrees", project.id);
  }

  /** Daemon start-up: live runs of every linked project become `interrupted`. */
  async recover(): Promise<void> {
    for (const project of await this.#options.registry.list()) {
      await recoverRuns(this.store(project), this.#options.now).catch(() => undefined);
    }
  }

  /** Launches a run of `task` (the human selected it). Resolves once it has started. */
  async start(project: Project, input: { task: string; agent?: AgentSpec }): Promise<Run> {
    const plan = await readTasks(project.path);
    const task = plan.ok ? plan.document.tasks.find((t) => t.id === input.task) : undefined;
    const agent = plan.ok && task ? runAgentFor(task, plan.document, input.agent) : undefined;
    const provider = (agent ?? input.agent)?.provider ?? "claude";
    const adapter = this.#adapters[provider];
    if (!adapter) {
      throw new RunManagerError("no_adapter", `Konsora cannot run ${provider} yet`);
    }
    // The agent must be one its adapter declares; nothing is created otherwise.
    if (agent) {
      const check = checkAgent(agent, await this.catalog.entry(agent.provider));
      if (!check.ok) throw new RunManagerError("invalid_agent", check.reason);
    }
    const session = await startRun(this.#supervisorOptions(project, adapter), {
      task: input.task,
      ...(input.agent ? { agent: input.agent } : {}),
    });
    return this.#track(project, input.task, session);
  }

  /**
   * The human asks the agent to rebase a run whose integration conflicts (RUN-24): a new run of
   * the same task, on the same branch and worktree, with the same agent. Resolves once started.
   */
  async rebase(project: Project, id: string): Promise<Run> {
    const conflicted = await this.get(project, id);
    const adapter = this.#adapters[conflicted.agent.provider];
    if (!adapter) {
      throw new RunManagerError(
        "no_adapter",
        `Konsora cannot run ${conflicted.agent.provider} yet`,
      );
    }
    const session = await startRebaseRun(this.#supervisorOptions(project, adapter), {
      run: conflicted.id,
    });
    return this.#track(project, conflicted.task, session);
  }

  /**
   * Launches 2 or 3 variants of `task` (RUN-28), one per agent, each in its own worktree with its
   * own prompt and checks: the first founds the group and moves the task to doing, the others
   * join it. Every agent is checked first, so nothing is created if one is not available. A
   * variant that fails to start is left `failed`; the others go on. Resolves once all started.
   */
  async startVariants(
    project: Project,
    input: { task: string; agents: readonly AgentSpec[] },
  ): Promise<Run[]> {
    if (input.agents.length < MIN_VARIANTS || input.agents.length > MAX_VARIANTS) {
      throw new RunManagerError(
        "invalid_agent",
        `Choose from ${MIN_VARIANTS} to ${MAX_VARIANTS} agents for the variants of ${input.task}`,
      );
    }
    const adapters: AgentAdapter[] = [];
    for (const agent of input.agents) {
      const adapter = this.#adapters[agent.provider];
      if (!adapter)
        throw new RunManagerError("no_adapter", `Konsora cannot run ${agent.provider} yet`);
      const check = checkAgent(agent, await this.catalog.entry(agent.provider));
      if (!check.ok) throw new RunManagerError("invalid_agent", check.reason);
      adapters.push(adapter);
    }
    const [firstAgent, ...rest] = input.agents as [AgentSpec, ...AgentSpec[]];
    const first = await startRun(this.#supervisorOptions(project, adapters[0] as AgentAdapter), {
      task: input.task,
      agent: firstAgent,
      variant: "first",
    });
    const runs = [this.#track(project, input.task, first)];
    for (const [i, agent] of rest.entries()) {
      try {
        const session = await startRun(
          this.#supervisorOptions(project, adapters[i + 1] as AgentAdapter),
          { task: input.task, agent, variant: first.run.id },
        );
        runs.push(this.#track(project, input.task, session));
      } catch (error) {
        if (!(error instanceof RunError) || error.code !== "launch_failed") throw error;
        const failed = (await this.list(project, input.task)).findLast(
          (r) => r.variant_of === first.run.id && r.state === "failed",
        );
        if (failed) runs.push(failed);
      }
    }
    return runs;
  }

  /**
   * The human chooses the winning variant (RUN-28): it waits for integration (`pending`), the
   * other variants are discarded and their worktrees and branches removed; their runs and diffs
   * stay. Accepting the task then integrates the winner.
   */
  async choose(project: Project, id: string): Promise<Run> {
    const winner = await this.get(project, id);
    const runs = await this.list(project, winner.task);
    const chosen = chooseVariant(runs, winner.id);
    if (!chosen.ok) throw new RunManagerError(chosen.error.code, chosen.error.message);
    const store = this.store(project);
    let result = winner;
    for (const run of chosen.runs) {
      const state = run.integration?.state;
      if (!state) continue;
      if (state === "discarded" && run.worktree && run.branch) {
        await removeWorktree({
          root: project.path,
          worktreesDir: this.worktreesDir(project),
          worktree: run.worktree,
          branch: run.branch,
          ...(this.#options.git ? { git: this.#options.git } : {}),
        });
      }
      const written = await store.integrate(run.id, state);
      if (run.id === winner.id) result = written;
    }
    return result;
  }

  /**
   * The human resumes a run left `interrupted` by an earlier daemon (RUN-27): the same run, in its
   * worktree, with its agent. A queue entry linked to it stays linked. Resolves once started.
   */
  async resume(project: Project, id: string): Promise<Run> {
    const run = await this.get(project, id);
    const adapter = this.#adapters[run.agent.provider];
    if (!adapter) {
      throw new RunManagerError("no_adapter", `Konsora cannot run ${run.agent.provider} yet`);
    }
    const session = await resumeRun(this.#supervisorOptions(project, adapter), { run: run.id });
    return this.#track(project, run.task, session);
  }

  /**
   * A review run (RUN-29): `agent`, else the project's reviewer, reviews a succeeded run's work in
   * its worktree with the `readonly` profile, and leaves a `review` note. Resolves once started.
   */
  async review(project: Project, id: string, requested?: AgentSpec): Promise<Run> {
    const reviewed = await this.get(project, id);
    const plan = await readTasks(project.path);
    const reviewer = plan.ok ? plan.document.project.reviewer : undefined;
    const chosen = requested ?? (reviewer ? reviewerAgent(reviewer) : undefined);
    if (!chosen) {
      throw new RunManagerError(
        "invalid_agent",
        "Choose an agent for the review, or set the project's reviewer",
      );
    }
    const agent: AgentSpec = { ...chosen, permissions: READONLY_PROFILE };
    const adapter = this.#adapters[agent.provider];
    if (!adapter)
      throw new RunManagerError("no_adapter", `Konsora cannot run ${agent.provider} yet`);
    const check = checkAgent(agent, await this.catalog.entry(agent.provider));
    if (!check.ok) throw new RunManagerError("invalid_agent", check.reason);
    const session = await startReviewRun(this.#supervisorOptions(project, adapter), {
      run: reviewed.id,
      agent,
    });
    return this.#track(project, reviewed.task, session);
  }

  /**
   * With `project.reviewer.launch = auto`, a run whose task has just reached review gets one
   * review run. Variants wait for the human's choice; review runs are never reviewed.
   */
  async #autoReview(project: Project, run: Run): Promise<void> {
    if (run.state !== "succeeded" || isReviewRun(run) || run.variant_of) return;
    const plan = await readTasks(project.path);
    if (!plan.ok || plan.document.project.reviewer?.launch !== "auto") return;
    const task = plan.document.tasks.find((t) => t.id === run.task);
    if (task?.state !== "review") return;
    await this.review(project, run.id);
  }

  #track(project: Project, task: string, session: RunSession): Run {
    const id = session.run.id;
    this.#sessions.set(id, { project: project.id, task, session });
    void session.done
      .then((run) => this.#autoReview(project, run))
      .catch(() => undefined)
      .finally(() => {
        this.#sessions.delete(id);
        this.#options.onRunClosed?.(project);
      });
    return session.run;
  }

  #supervisorOptions(project: Project, adapter: AgentAdapter): SupervisorOptions {
    const { approvals } = this.#options;
    return {
      root: project.path,
      worktreesDir: this.worktreesDir(project),
      privateDir: join(this.#options.dataDir, "projects", project.id, "runs"),
      adapter,
      mcp: this.#options.mcp,
      store: this.store(project),
      registry: {
        register: async ({ run, task: id }) => ({
          url: this.#options.daemonUrl(),
          token: approvals.registerRun({ run, project: project.id, task: id }),
        }),
        unregister: (run) => approvals.endRun(run),
        requestPermission: async ({ run, task: id, tool, input, tool_use_id }) => {
          if (!approvals.isRegistered(run)) {
            return { behavior: "deny", message: "The run has ended." };
          }
          const { decision } = await approvals.request(
            { run, project: project.id, task: id },
            { tool_name: tool, input, ...(tool_use_id ? { tool_use_id } : {}) },
            this.#options.permissionWaitMs ?? PERMISSION_WAIT_MS,
          );
          return decision;
        },
      },
      ...(this.#options.git ? { git: this.#options.git } : {}),
      ...(this.#options.now ? { now: this.#options.now } : {}),
      ...(this.#options.interruptGraceMs !== undefined
        ? { interruptGraceMs: this.#options.interruptGraceMs }
        : {}),
    };
  }

  async list(project: Project, task?: string): Promise<Run[]> {
    const { runs } = await this.store(project).list(task ? { task } : {});
    return runs;
  }

  async get(project: Project, id: string): Promise<Run> {
    return this.store(project).read(this.#runId(id));
  }

  async events(project: Project, id: string): Promise<unknown[]> {
    return this.store(project).readEvents(this.#runId(id));
  }

  /** `checks.json` of a run, or null if its checks have not run. */
  async checks(project: Project, id: string): Promise<ChecksFile | null> {
    const runId = this.#runId(id);
    await this.store(project).read(runId);
    return this.store(project).readChecks(runId);
  }

  async diff(project: Project, id: string): Promise<string | null> {
    const runId = this.#runId(id);
    await this.store(project).read(runId);
    return this.store(project).readDiff(runId);
  }

  /**
   * Cancels a run. A live one goes through its supervisor (SIGINT, then kill); one left
   * `interrupted` or `queued` by an earlier daemon is closed here, and its task goes back to todo.
   */
  async cancel(project: Project, id: string): Promise<Run> {
    const runId = this.#runId(id);
    const live = this.#sessions.get(runId);
    if (live && live.project === project.id) return live.session.cancel();
    const store = this.store(project);
    const run = await store.read(runId);
    if (!isActiveRunState(run.state)) {
      throw new RunManagerError("not_active", `Run ${run.id} is ${run.state}; nothing to cancel`);
    }
    this.#options.approvals.endRun(run.id);
    const at = this.#at();
    if (run.variant_of) {
      // A variant leaves the task to its group: the last one to close settles it.
      await store.appendEvent(run.id, { at, t: "cancelled" });
      const closed = await store.transition(run.id, "cancelled", { finished_at: at });
      await settleVariants({ root: project.path, store, run: closed, at });
      return closed;
    }
    const plan = await readTasks(project.path);
    const task = plan.ok ? plan.document.tasks.find((t) => t.id === run.task) : undefined;
    if (task?.state === "doing") {
      const text = `Konsora run ${run.id} was cancelled. Its work is kept on its branch.`;
      await mutate(
        project.path,
        run.rebase_of
          ? {
              op: "rebase-abort",
              task: run.task,
              text: `${text} The task is back in review with run ${run.rebase_of}'s conflict: resolve it by hand or ask for another rebase.`,
            }
          : { op: "pause", task: run.task, text },
        { actor: "konsora", at, run: run.id },
      );
    }
    await store.appendEvent(run.id, { at, t: "cancelled" });
    return store.transition(run.id, "cancelled", { finished_at: at });
  }

  /** After the human answers `task`'s question: deliver it to the task's live run, if any. */
  async deliverAnswer(project: Project, task: string): Promise<boolean> {
    // With variants, the answer goes to the run that asked.
    const plan = await readTasks(project.path);
    const notes = plan.ok ? plan.document.tasks.find((t) => t.id === task)?.notes : undefined;
    const asker = notes?.findLast((n) => n.kind === "question")?.run;
    const lives = [...this.#sessions.values()].filter(
      (live) => live.project === project.id && live.task === task,
    );
    const live = lives.find((l) => l.session.run.id === asker) ?? lives[0];
    if (!live) return false;
    await live.session.deliverAnswer();
    return true;
  }

  /**
   * The run whose work `accept` must integrate: the task's latest succeeded, unintegrated run. A
   * rebase run that did not succeed leaves the run it rebased (still in conflict) as the one. In
   * a variant group, the winner; accepting before choosing one is `variant_not_chosen` (CORE-12).
   */
  async integrable(project: Project, task: string): Promise<Run | null> {
    const result = integrableRun(await this.list(project, task));
    if (!result.ok) throw new RunManagerError("variant_not_chosen", result.error.message);
    return result.run;
  }

  async integrate(project: Project, run: Run): Promise<IntegrationResult> {
    const plan = await readTasks(project.path);
    if (!plan.ok) throw new RunManagerError("not_found", plan.error.message);
    return integrateRun({
      root: project.path,
      worktreesDir: this.worktreesDir(project),
      document: plan.document,
      runId: run.id,
      store: this.store(project),
      ...(this.#options.git ? { git: this.#options.git } : {}),
    });
  }

  /**
   * Closes a finished run without integrating it (its work was not kept, or there was none):
   * `integration = discarded`, and its worktree and branch are removed. The run is kept.
   */
  async discard(project: Project, run: Run): Promise<Run> {
    if (isActiveRunState(run.state)) {
      throw new RunManagerError(
        "not_discardable",
        `Run ${run.id} is ${run.state}; cancel it before discarding it`,
      );
    }
    const state = run.integration?.state;
    if (state === "merged" || state === "discarded") {
      throw new RunManagerError(
        "not_discardable",
        `Run ${run.id} was already ${state}; there is nothing left to discard`,
      );
    }
    // Worktree and branch first (idempotent): if that fails, the run can be discarded again.
    // A rebase run shares them with the run it rebases: keep them while the other needs them.
    if (run.worktree && run.branch && !(await this.#sharedWorktree(project, run))) {
      await removeWorktree({
        root: project.path,
        worktreesDir: this.worktreesDir(project),
        worktree: run.worktree,
        branch: run.branch,
        ...(this.#options.git ? { git: this.#options.git } : {}),
      });
    }
    return this.store(project).integrate(run.id, "discarded");
  }

  /** Another run of the task uses the same worktree and still needs it. */
  async #sharedWorktree(project: Project, run: Run): Promise<boolean> {
    const runs = await this.list(project, run.task);
    return runs.some((other) => {
      if (other.id === run.id || other.worktree !== run.worktree) return false;
      if (isActiveRunState(other.state)) return true;
      const state = other.integration?.state;
      return other.state === "succeeded" && state !== "merged" && state !== "discarded";
    });
  }

  /** Discards a run by id (the human's "Discard" on a finished, unintegrated run). */
  async discardById(project: Project, id: string): Promise<Run> {
    return this.discard(project, await this.get(project, id));
  }

  /** Konsora worktrees and branches no run needs any more (never deletes anything). */
  async orphans(project: Project): Promise<OrphanWorktree[]> {
    return findOrphanWorktrees({
      root: project.path,
      worktreesDir: this.worktreesDir(project),
      store: this.store(project),
      ...(this.#options.git ? { git: this.#options.git } : {}),
    });
  }

  /** Pending approvals move their run to `waiting_approval`, and back when none is left. */
  onApproval(event: ApprovalEvent): void {
    const live = this.#sessions.get(event.run as RunId);
    if (!live) return;
    const waiting = this.#options.approvals.pending().some((a) => a.run === event.run);
    void live.session.setAwaitingApproval(waiting).catch(() => undefined);
  }

  /** Runs still alive in this daemon (for tests and shutdown). */
  live(): RunId[] {
    return [...this.#sessions.keys()];
  }

  /** Waits for a live run to close (tests). */
  async settled(id: RunId): Promise<Run | undefined> {
    return this.#sessions.get(id)?.session.done;
  }

  /** A run's `usage` event with rate limits updates the providers' limits. */
  async #noteUsage(store: RunStore, payload: unknown): Promise<void> {
    const { type, run, event } = payload as { type?: string; run?: RunId; event?: RunUsageEvent };
    if (type !== "run.event" || !run || event?.t !== "usage" || !event.rate_limits) return;
    const live = this.#sessions.get(run)?.session.run ?? (await store.read(run));
    await this.limits.onRunUsage(
      live,
      typeof event.at === "string" ? event.at : this.#at(),
      event.rate_limits,
    );
  }

  /** Every run of every linked project, for the limits they last reported. */
  async #allRuns(): Promise<Run[]> {
    const runs: Run[] = [];
    for (const project of await this.#options.registry.list()) {
      runs.push(
        ...(
          await this.store(project)
            .list()
            .catch(() => ({ runs: [] }))
        ).runs,
      );
    }
    return runs;
  }

  #runId(id: string): RunId {
    if (!RunIdSchema.safeParse(id).success) {
      throw new RunStoreError("invalid_id", `"${id}" is not a run id`);
    }
    return id;
  }

  #at(): string {
    return (this.#options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

export { RunError, RunStoreError };
