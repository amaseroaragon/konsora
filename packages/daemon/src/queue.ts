/**
 * The run queue and scheduler of the daemon (M9, DMN-08; docs/arquitectura.md "Scheduler").
 *
 * - Each project's queue lives in `<data>/projects/<id>/queue.json`, the parallelism limits in
 *   `<data>/settings.json`; both are validated with core's schemas and written atomically (0600).
 * - The rules are core's: `nextRuns` says what to launch, `queueExits` what leaves and why,
 *   `queueStatus` why each entry waits. This class only reads state, applies them and launches.
 * - It runs a `tick` whenever something may have changed: a run closes, the plan changes (a
 *   watcher per project with a non-empty queue), the queue or the limits change, the human
 *   resumes. Ticks are serialized, so two never launch the same slot.
 * - At start-up every non-empty queue is loaded paused: nothing launches until the human resumes.
 * - It only ever launches what the human queued.
 */
import { join } from "node:path";
import {
  type AgentSpec,
  type DaemonSettings,
  enqueue,
  fitsSlots,
  isActiveRunState,
  markLaunched,
  nextRuns,
  type ParallelLimits,
  ParallelLimitsSchema,
  type Provider,
  parseDaemonSettings,
  parseQueueFile,
  type QueueEntryStatus,
  type QueueExit,
  type QueueFile,
  queueExits,
  queueOnStartup,
  queueStatus,
  runAgentFor,
  type ScheduledRun,
  type SlotUsage,
  slotUsage,
  withoutEntries,
} from "@konsora/core";
import { readTasks, watchTasks } from "@konsora/core/store";
import { readJson, writePrivateFile } from "./files.ts";
import type { Project, Registry } from "./registry.ts";
import type { Publish, RunManager } from "./runs.ts";

export const QUEUE_FILE = "queue.json";
export const SETTINGS_FILE = "settings.json";

export class QueueError extends Error {
  readonly code:
    | "invalid_queue"
    | "invalid_settings"
    | "unknown_task"
    | "not_approved"
    | "queue_full"
    | "no_agent"
    | "invalid_plan"
    | "not_queued";
  readonly task: string | undefined;
  constructor(code: QueueError["code"], message: string, task?: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
    this.task = task;
  }
}

export type QueueView = {
  queue: QueueFile;
  /** Why each entry waits, in launch order. */
  status: QueueEntryStatus[];
  limits: ParallelLimits;
  /** Slots taken across every project of the daemon. */
  usage: SlotUsage;
};

export type SchedulerOptions = {
  registry: Registry;
  runs: RunManager;
  dataDir: string;
  /** To the project's subscribers: `queue.updated`, `queue.exited`, `queue.launched`. */
  publish?: Publish;
  /** To every client: `queue.limits`. */
  broadcast?: (payload: unknown) => void;
  now?: () => Date;
  /** Debounce of the plan watchers. */
  watchDebounceMs?: number;
};

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #queues = new Map<string, QueueFile>();
  readonly #watchers = new Map<string, () => void>();
  #settings: DaemonSettings | null = null;
  /** Serializes ticks and queue writes. */
  #chain: Promise<unknown> = Promise.resolve();
  #pending = false;
  #closed = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  /** Daemon start-up: every non-empty queue is loaded paused, and watched. */
  async init(): Promise<void> {
    await this.settings();
    for (const project of await this.#options.registry.list()) {
      const queue = await this.#load(project).catch(() => null);
      if (!queue) continue;
      const loaded = queueOnStartup(queue);
      if (loaded !== queue) await this.#save(project, loaded);
      this.#watch(project, loaded);
    }
  }

  close(): void {
    this.#closed = true;
    for (const stop of this.#watchers.values()) stop();
    this.#watchers.clear();
  }

  /**
   * Whether runs of `providers` fit in the free slots of every project now (variants, RUN-28):
   * `null` if they do, else why not.
   */
  async fits(project: Project, providers: readonly Provider[]): Promise<string | null> {
    const { runs, elsewhere } = await this.#runs(project);
    return fitsSlots(
      slotUsage([...runs, ...elsewhere]),
      (await this.settings()).parallel,
      providers,
    );
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async settings(): Promise<DaemonSettings> {
    if (this.#settings) return this.#settings;
    const parsed = parseDaemonSettings(await readJson<unknown>(this.#settingsFile()));
    if (!parsed.ok) {
      throw new QueueError(
        "invalid_settings",
        `${SETTINGS_FILE} in Konsora's data folder is not valid; fix or delete it`,
      );
    }
    this.#settings = parsed.settings;
    return parsed.settings;
  }

  async setLimits(input: unknown): Promise<ParallelLimits> {
    const parsed = ParallelLimitsSchema.safeParse(input);
    if (!parsed.success) {
      throw new QueueError(
        "invalid_settings",
        "Send {max_parallel, per_provider?} with whole numbers from 1 to 16",
      );
    }
    return this.#serial(async () => {
      const settings = { ...(await this.settings()), parallel: parsed.data };
      await writePrivateFile(this.#settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
      this.#settings = settings;
      this.#options.broadcast?.({ type: "queue.limits", limits: parsed.data });
      this.poke();
      return parsed.data;
    });
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  async view(project: Project): Promise<QueueView> {
    const queue = await this.#load(project);
    const limits = (await this.settings()).parallel;
    const { runs, elsewhere } = await this.#runs(project);
    const plan = await readTasks(project.path);
    const status = plan.ok
      ? queueStatus({ queue, plan: plan.document, runs, limits, elsewhere })
      : [];
    return { queue, status, limits, usage: slotUsage([...runs, ...elsewhere]) };
  }

  /**
   * Adds the human's selection to the end of the queue, each task with the agent chosen for it
   * (or the task's, or the project's default).
   */
  async enqueue(
    project: Project,
    items: readonly { task: string; agent?: AgentSpec | undefined }[],
  ): Promise<{ added: string[]; already: string[] }> {
    return this.#serial(async () => {
      const plan = await readTasks(project.path);
      if (!plan.ok) throw new QueueError("invalid_plan", plan.error.message);
      const resolved = items.map((item) => {
        const task = plan.document.tasks.find((t) => t.id === item.task);
        const agent = task ? runAgentFor(task, plan.document, item.agent) : item.agent;
        if (task && !agent) {
          throw new QueueError(
            "no_agent",
            `Choose an agent for ${item.task}, or set project.defaults`,
            item.task,
          );
        }
        return { task: item.task, agent: agent as AgentSpec };
      });
      const queue = await this.#load(project);
      const result = enqueue(queue, plan.document, resolved, this.#at());
      if (!result.ok) throw new QueueError(result.code, result.message, result.task);
      await this.#update(project, result.queue);
      this.poke();
      return { added: result.added, already: result.already };
    });
  }

  /** The human takes tasks out of the queue (their runs, if any, keep going). */
  async remove(project: Project, tasks: readonly string[]): Promise<QueueFile> {
    return this.#serial(async () => {
      const queue = await this.#load(project);
      const present = queue.entries.filter((e) => tasks.includes(e.task));
      if (tasks.length === 1 && present.length === 0) {
        throw new QueueError("not_queued", `${tasks[0]} is not in the queue`, tasks[0]);
      }
      const next = withoutEntries(
        queue,
        present.map((e) => e.task),
      );
      await this.#update(project, next);
      this.#publishExits(
        project,
        present.map((e) => ({ task: e.task, reason: "removed", ...(e.run ? { run: e.run } : {}) })),
      );
      return next;
    });
  }

  async clear(project: Project): Promise<QueueFile> {
    const queue = await this.#load(project);
    return this.remove(
      project,
      queue.entries.map((e) => e.task),
    );
  }

  async setState(project: Project, state: QueueFile["state"]): Promise<QueueFile> {
    return this.#serial(async () => {
      const queue = await this.#load(project);
      const next = { ...queue, state };
      if (queue.state !== state) await this.#update(project, next);
      if (state === "running") this.poke();
      return next;
    });
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  /** Something may have changed: schedule one tick (several pokes collapse into one). */
  poke(): void {
    if (this.#closed || this.#pending) return;
    this.#pending = true;
    void this.#serial(async () => {
      this.#pending = false;
      await this.#tick();
    }).catch(() => undefined);
  }

  /** Waits until every poke so far has been handled (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.#chain;
      await chain.catch(() => undefined);
      if (chain === this.#chain && !this.#pending) return;
    }
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const limits = (await this.settings()).parallel;
    for (const project of await this.#options.registry.list()) {
      let queue = await this.#load(project).catch(() => null);
      if (!queue || queue.entries.length === 0) continue;
      const plan = await readTasks(project.path);
      if (!plan.ok) continue; // an invalid plan is read-only: nothing launches
      let { runs, elsewhere } = await this.#runs(project);

      const exits = queueExits({ queue, plan: plan.document, runs });
      if (exits.length > 0) {
        queue = withoutEntries(
          queue,
          exits.map((e) => e.task),
        );
        await this.#update(project, queue);
        this.#publishExits(project, exits);
      }

      for (const entry of nextRuns({ queue, plan: plan.document, runs, limits, elsewhere })) {
        if (this.#closed) return;
        try {
          const run = await this.#options.runs.start(project, {
            task: entry.task,
            agent: entry.agent,
          });
          queue = markLaunched(queue, entry.task, run.id);
          await this.#update(project, queue);
          this.#options.publish?.(project.id, {
            type: "queue.launched",
            project: project.id,
            task: entry.task,
            run: run.id,
          });
        } catch (error) {
          queue = withoutEntries(queue, [entry.task]);
          await this.#update(project, queue);
          this.#publishExits(project, [
            {
              task: entry.task,
              reason: "launch_failed",
              message: error instanceof Error ? error.message : "The run could not start",
            },
          ]);
        }
        ({ runs, elsewhere } = await this.#runs(project));
      }
    }
  }

  /** This project's runs, and the slot-taking runs of every other project. */
  async #runs(project: Project): Promise<{ runs: ScheduledRun[]; elsewhere: ScheduledRun[] }> {
    const runs = await this.#options.runs.list(project).catch(() => []);
    const elsewhere: ScheduledRun[] = [];
    for (const other of await this.#options.registry.list()) {
      if (other.id === project.id) continue;
      const list = await this.#options.runs.list(other).catch(() => []);
      elsewhere.push(...list.filter((run) => isActiveRunState(run.state)));
    }
    return { runs, elsewhere };
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async #load(project: Project): Promise<QueueFile> {
    const cached = this.#queues.get(project.id);
    if (cached) return cached;
    const parsed = parseQueueFile(await readJson<unknown>(this.#queueFile(project)));
    if (!parsed.ok) {
      throw new QueueError(
        "invalid_queue",
        `The queue of ${project.name} is not valid; clear it to start again`,
      );
    }
    this.#queues.set(project.id, parsed.queue);
    return parsed.queue;
  }

  async #save(project: Project, queue: QueueFile): Promise<void> {
    await writePrivateFile(this.#queueFile(project), `${JSON.stringify(queue, null, 2)}\n`);
    this.#queues.set(project.id, queue);
  }

  /** Saves, tells the project's subscribers and follows the plan while the queue has entries. */
  async #update(project: Project, queue: QueueFile): Promise<void> {
    await this.#save(project, queue);
    this.#watch(project, queue);
    this.#options.publish?.(project.id, { type: "queue.updated", project: project.id, queue });
  }

  #publishExits(project: Project, exits: QueueExit[]): void {
    if (exits.length === 0) return;
    this.#options.publish?.(project.id, { type: "queue.exited", project: project.id, exits });
  }

  #watch(project: Project, queue: QueueFile): void {
    const watching = this.#watchers.get(project.id);
    if (queue.entries.length === 0) {
      watching?.();
      this.#watchers.delete(project.id);
      return;
    }
    if (watching || this.#closed) return;
    const watcher = watchTasks(project.path, () => this.poke(), {
      ...(this.#options.watchDebounceMs !== undefined
        ? { debounceMs: this.#options.watchDebounceMs }
        : {}),
    });
    this.#watchers.set(project.id, watcher.close);
  }

  #queueFile(project: Project): string {
    return join(this.#options.dataDir, "projects", project.id, QUEUE_FILE);
  }

  #settingsFile(): string {
    return join(this.#options.dataDir, SETTINGS_FILE);
  }

  #at(): string {
    return (this.#options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
