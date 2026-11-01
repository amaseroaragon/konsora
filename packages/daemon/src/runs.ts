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
  isActiveRunState,
  type Provider,
  type Run,
  type RunId,
  RunIdSchema,
} from "@konsora/core";
import { mutate, readTasks } from "@konsora/core/store";
import {
  type AgentAdapter,
  createClaudeAdapter,
  type Git,
  type IntegrationResult,
  integrateRun,
  type McpServerSpec,
  RunError,
  type RunSession,
  RunStore,
  RunStoreError,
  recoverRuns,
  startRun,
} from "@konsora/runner";
import type { ApprovalEvent, Approvals } from "./approvals.ts";
import type { Project, Registry } from "./registry.ts";

export type Publish = (project: string, payload: unknown) => void;

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
  adapters?: Partial<Record<Provider, AgentAdapter>>;
  git?: Git;
  now?: () => Date;
  /** Passed to the supervisor (tests shorten it). */
  interruptGraceMs?: number;
};

export class RunManagerError extends Error {
  readonly code: "not_found" | "not_active" | "no_adapter";
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

  constructor(options: RunManagerOptions) {
    this.#options = options;
  }

  store(project: Project): RunStore {
    let store = this.#stores.get(project.id);
    if (!store) {
      const publish = this.#options.publish ?? (() => undefined);
      store = new PublishingRunStore(project.path, (payload) =>
        publish(project.id, { ...(payload as object), project: project.id }),
      );
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
    const provider =
      input.agent?.provider ??
      task?.agent?.provider ??
      (plan.ok ? plan.document.project.defaults?.provider : undefined) ??
      "claude";
    const adapter =
      this.#options.adapters?.[provider] ?? (provider === "claude" ? createClaudeAdapter() : null);
    if (!adapter) {
      throw new RunManagerError("no_adapter", `Konsora cannot run ${provider} yet`);
    }
    const store = this.store(project);
    const { approvals } = this.#options;
    const session = await startRun(
      {
        root: project.path,
        worktreesDir: this.worktreesDir(project),
        privateDir: join(this.#options.dataDir, "projects", project.id, "runs"),
        adapter,
        mcp: this.#options.mcp,
        store,
        registry: {
          register: async ({ run, task: id }) => ({
            url: this.#options.daemonUrl(),
            token: approvals.registerRun({ run, project: project.id, task: id }),
          }),
          unregister: (run) => approvals.endRun(run),
        },
        ...(this.#options.git ? { git: this.#options.git } : {}),
        ...(this.#options.now ? { now: this.#options.now } : {}),
        ...(this.#options.interruptGraceMs !== undefined
          ? { interruptGraceMs: this.#options.interruptGraceMs }
          : {}),
      },
      { task: input.task, ...(input.agent ? { agent: input.agent } : {}) },
    );
    const id = session.run.id;
    this.#sessions.set(id, { project: project.id, task: input.task, session });
    void session.done.catch(() => undefined).finally(() => this.#sessions.delete(id));
    return session.run;
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
    const plan = await readTasks(project.path);
    const task = plan.ok ? plan.document.tasks.find((t) => t.id === run.task) : undefined;
    if (task?.state === "doing") {
      await mutate(
        project.path,
        {
          op: "pause",
          task: run.task,
          text: `Konsora run ${run.id} was cancelled. Its work is kept on its branch.`,
        },
        { actor: "konsora", at, run: run.id },
      );
    }
    await store.appendEvent(run.id, { at, t: "cancelled" });
    return store.transition(run.id, "cancelled", { finished_at: at });
  }

  /** After the human answers `task`'s question: deliver it to the task's live run, if any. */
  async deliverAnswer(project: Project, task: string): Promise<boolean> {
    for (const live of this.#sessions.values()) {
      if (live.project === project.id && live.task === task) {
        await live.session.deliverAnswer();
        return true;
      }
    }
    return false;
  }

  /** The run whose work `accept` must integrate: the task's latest succeeded, unintegrated run. */
  async integrable(project: Project, task: string): Promise<Run | null> {
    const runs = await this.list(project, task);
    const run = runs.at(-1);
    if (run?.state !== "succeeded") return null;
    const state = run.integration?.state;
    return state === "merged" || state === "discarded" ? null : run;
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
