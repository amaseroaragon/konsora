/**
 * The run queue and the scheduler's rules (M9, docs/arquitectura.md "Scheduler"): the schema of
 * `queue.json` (per project, in the data directory) and of the daemon's `settings.json` with the
 * parallelism limits, and the pure functions that decide what to launch, what leaves the queue and
 * why each entry is waiting.
 *
 * Nothing here runs anything. The queue only ever launches what the human put in it.
 */
import { z } from "zod";
import { indexTasks, topoOrder } from "./graph.ts";
import { isActiveRunState, type Run, RunIdSchema, type RunState } from "./run.ts";
import {
  AgentSpecSchema,
  type Provider,
  ProviderSchema,
  TaskIdSchema,
  type TasksDocument,
  TimestampSchema,
} from "./schema.ts";
import { compareTaskIds } from "./serialize.ts";

// ── queue.json ───────────────────────────────────────────────────────────────

export const QUEUE_VERSION = 1;
export const MAX_QUEUE_ENTRIES = 500;

export const QueueStateSchema = z.enum(["running", "paused"]);
export type QueueState = z.infer<typeof QueueStateSchema>;

/**
 * A task the human queued, with the agent chosen for it. `run` is set once the scheduler launches
 * it; the entry stays until that run finishes, so the queue can say how it ended.
 */
export const QueueEntrySchema = z.strictObject({
  task: TaskIdSchema,
  agent: AgentSpecSchema,
  added_at: TimestampSchema,
  run: RunIdSchema.optional(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

/**
 * `queue.json`. Every field has a default, so an older or partial file still reads; a missing
 * file is an empty running queue (`emptyQueue`).
 */
export const QueueFileSchema = z
  .strictObject({
    version: z.literal(QUEUE_VERSION).default(QUEUE_VERSION),
    state: QueueStateSchema.default("running"),
    entries: z.array(QueueEntrySchema).max(MAX_QUEUE_ENTRIES).default([]),
  })
  .superRefine((queue, ctx) => {
    const seen = new Set<string>();
    queue.entries.forEach((entry, i) => {
      if (seen.has(entry.task)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "task"],
          message: `Task ${entry.task} is queued twice`,
        });
      }
      seen.add(entry.task);
    });
  });
export type QueueFile = z.infer<typeof QueueFileSchema>;

export function emptyQueue(): QueueFile {
  return { version: QUEUE_VERSION, state: "running", entries: [] };
}

/** Reads `queue.json` contents (already JSON-parsed); `undefined` means the file is missing. */
export function parseQueueFile(
  value: unknown,
): { ok: true; queue: QueueFile } | { ok: false; error: z.ZodError } {
  if (value === undefined) return { ok: true, queue: emptyQueue() };
  const parsed = QueueFileSchema.safeParse(value);
  return parsed.success ? { ok: true, queue: parsed.data } : { ok: false, error: parsed.error };
}

/**
 * The queue as the daemon loads it at start-up: paused if anything is queued, so nothing launches
 * until the human resumes it. An empty queue keeps its state.
 */
export function queueOnStartup(queue: QueueFile): QueueFile {
  return queue.entries.length > 0 ? { ...queue, state: "paused" } : queue;
}

// ── settings.json ────────────────────────────────────────────────────────────

export const DEFAULT_MAX_PARALLEL = 2;
export const MAX_PARALLEL_LIMIT = 16;

const ParallelSchema = z.int().min(1).max(MAX_PARALLEL_LIMIT);

/** The parallelism limits: across every project of the daemon, and optionally per provider. */
export const ParallelLimitsSchema = z.strictObject({
  max_parallel: ParallelSchema.default(DEFAULT_MAX_PARALLEL),
  per_provider: z.partialRecord(ProviderSchema, ParallelSchema).default({}),
});
export type ParallelLimits = z.infer<typeof ParallelLimitsSchema>;

/** The daemon's `settings.json` in the data directory (not the plan). */
export const DaemonSettingsSchema = z.strictObject({
  version: z.literal(1).default(1),
  parallel: ParallelLimitsSchema.default({ max_parallel: DEFAULT_MAX_PARALLEL, per_provider: {} }),
});
export type DaemonSettings = z.infer<typeof DaemonSettingsSchema>;

export function defaultSettings(): DaemonSettings {
  return { version: 1, parallel: { max_parallel: DEFAULT_MAX_PARALLEL, per_provider: {} } };
}

/** Reads `settings.json` contents (already JSON-parsed); `undefined` means the file is missing. */
export function parseDaemonSettings(
  value: unknown,
): { ok: true; settings: DaemonSettings } | { ok: false; error: z.ZodError } {
  if (value === undefined) return { ok: true, settings: defaultSettings() };
  const parsed = DaemonSettingsSchema.safeParse(value);
  return parsed.success ? { ok: true, settings: parsed.data } : { ok: false, error: parsed.error };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/** The part of a run the scheduler looks at. */
export type ScheduledRun = Pick<Run, "id" | "task" | "state"> & {
  agent: Pick<Run["agent"], "provider">;
};

/**
 * Run states that take a parallel slot: a process is (about to be) working. `interrupted` occupies
 * its task but no slot, since nothing runs until the human resumes it.
 */
const SLOT_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "checking",
];

export function takesSlot(state: RunState): boolean {
  return SLOT_STATES.includes(state);
}

export type SlotUsage = { total: number; per_provider: Partial<Record<Provider, number>> };

/** How many slots `runs` take, in total and per provider. */
export function slotUsage(runs: readonly ScheduledRun[]): SlotUsage {
  const usage: SlotUsage = { total: 0, per_provider: {} };
  for (const run of runs) {
    if (!takesSlot(run.state)) continue;
    usage.total += 1;
    const provider = run.agent.provider;
    usage.per_provider[provider] = (usage.per_provider[provider] ?? 0) + 1;
  }
  return usage;
}

/**
 * Whether runs of `providers` (one per run, e.g. the variants of a task) fit in the free slots
 * now: `null` if they do, else why not, for the human.
 */
export function fitsSlots(
  usage: SlotUsage,
  limits: ParallelLimits,
  providers: readonly Provider[],
): string | null {
  const free = limits.max_parallel - usage.total;
  if (providers.length > free) {
    return `${providers.length} runs need ${providers.length} free slots, and ${Math.max(0, free)} of ${limits.max_parallel} are free; wait for a run to finish or raise max_parallel`;
  }
  for (const provider of new Set(providers)) {
    const max = limits.per_provider[provider];
    if (max === undefined) continue;
    const want = providers.filter((p) => p === provider).length;
    const left = max - (usage.per_provider[provider] ?? 0);
    if (want > left) {
      return `${want} ${provider} runs need ${want} free ${provider} slots, and ${Math.max(0, left)} of ${max} are free; wait for one to finish or raise its limit`;
    }
  }
  return null;
}

export type SchedulerInput = {
  queue: QueueFile;
  plan: Pick<TasksDocument, "tasks">;
  /** This project's runs (any state; only active ones matter). */
  runs: readonly ScheduledRun[];
  limits: ParallelLimits;
  /** Runs of the daemon's other projects: they count against the same limits. */
  elsewhere?: readonly ScheduledRun[];
};

/** Why a queued entry is not running now. */
export type QueueWait =
  /** Launched: its run is active (`interrupted` included). */
  | { kind: "running"; run: string }
  /** The queue is paused. */
  | { kind: "paused" }
  /** Some dependencies are not done (integrated) yet. */
  | { kind: "blocked"; deps: string[] }
  /** Ready, waiting for a free slot (global or of its provider). */
  | { kind: "slot"; limit: "global" | "provider" }
  /** The task is not `todo`, or has an active run the queue did not launch. */
  | { kind: "busy"; state: string; run?: string }
  /** Ready and within the limits: the scheduler launches it now. */
  | { kind: "launch" };

export type QueueEntryStatus = { task: string; wait: QueueWait };

/**
 * The queue's entries in launch order: topological order of the plan (dependencies first, then
 * rank, then id), with entries whose task is not in the plan at the end in queue order.
 */
export function launchOrder(
  queue: Pick<QueueFile, "entries">,
  plan: Pick<TasksDocument, "tasks">,
): QueueEntry[] {
  const position = new Map(topoOrder(plan).order.map((id, i) => [id, i]));
  return queue.entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const pa = position.get(a.entry.task) ?? Number.POSITIVE_INFINITY;
      const pb = position.get(b.entry.task) ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ entry }) => entry);
}

/**
 * Why each queued entry waits, in launch order. The entries marked `launch` are exactly what
 * `nextRuns` returns; slots are handed out in launch order, so an earlier entry is never starved
 * by a later one of the same provider.
 */
export function queueStatus(input: SchedulerInput): QueueEntryStatus[] {
  const { queue, plan, runs, limits } = input;
  const index = indexTasks(plan);
  const usage = slotUsage([...runs, ...(input.elsewhere ?? [])]);
  const activeByTask = new Map<string, ScheduledRun>();
  for (const run of runs) if (isActiveRunState(run.state)) activeByTask.set(run.task, run);

  return launchOrder(queue, plan).map((entry): QueueEntryStatus => {
    const at = (wait: QueueWait) => ({ task: entry.task, wait });
    const active = activeByTask.get(entry.task);
    if (active && entry.run === active.id) return at({ kind: "running", run: active.id });
    const task = index.get(entry.task);
    if (!task) return at({ kind: "busy", state: "missing" });
    if (active) return at({ kind: "busy", state: task.state, run: active.id });
    if (task.state !== "todo") return at({ kind: "busy", state: task.state });
    const deps = (task.deps ?? []).filter((id) => index.get(id)?.state !== "done");
    if (deps.length > 0) return at({ kind: "blocked", deps: deps.sort(compareTaskIds) });
    if (queue.state === "paused") return at({ kind: "paused" });
    if (usage.total >= limits.max_parallel) return at({ kind: "slot", limit: "global" });
    const provider = entry.agent.provider;
    const cap = limits.per_provider[provider];
    const used = usage.per_provider[provider] ?? 0;
    if (cap !== undefined && used >= cap) return at({ kind: "slot", limit: "provider" });
    usage.total += 1;
    usage.per_provider[provider] = used + 1;
    return at({ kind: "launch" });
  });
}

/**
 * What to launch now: queued tasks that are ready (every dependency done), have no active run and
 * fit within the global and per-provider limits, in launch order. Only ever entries of the queue;
 * nothing while it is paused.
 */
export function nextRuns(input: SchedulerInput): QueueEntry[] {
  const launch = new Set(
    queueStatus(input)
      .filter((s) => s.wait.kind === "launch")
      .map((s) => s.task),
  );
  return launchOrder(input.queue, input.plan).filter((entry) => launch.has(entry.task));
}

// ── Leaving the queue ────────────────────────────────────────────────────────

export const QueueExitReasonSchema = z.enum([
  /** Its run succeeded (the task is in review, or done in a YOLO chain). */
  "succeeded",
  /** Its run failed; the task is back in todo. The queue never retries on its own. */
  "failed",
  "cancelled",
  /** The human took it out. */
  "removed",
  /** The task no longer exists in the plan. */
  "missing",
  /** The task went back to `proposed` (its approval was withdrawn). */
  "not_approved",
  /** The task reached review or done without a run of the queue (e.g. by hand). */
  "settled",
  /** The scheduler could not launch its run (e.g. the agent is no longer available). */
  "launch_failed",
]);
export type QueueExitReason = z.infer<typeof QueueExitReasonSchema>;

export type QueueExit = {
  task: string;
  reason: QueueExitReason;
  run?: string;
  /** Why, for `launch_failed`. */
  message?: string;
};

/**
 * The entries that leave the queue now and why. `removed` (the human) and `launch_failed` (the
 * daemon) are never produced here.
 */
export function queueExits(input: Pick<SchedulerInput, "queue" | "plan" | "runs">): QueueExit[] {
  const index = indexTasks(input.plan);
  const byId = new Map(input.runs.map((run) => [run.id, run]));
  const exits: QueueExit[] = [];
  for (const entry of input.queue.entries) {
    const exit = (reason: QueueExitReason) =>
      exits.push({ task: entry.task, reason, ...(entry.run ? { run: entry.run } : {}) });
    const run = entry.run ? byId.get(entry.run) : undefined;
    if (run && !isActiveRunState(run.state)) {
      exit(
        run.state === "succeeded" ? "succeeded" : run.state === "failed" ? "failed" : "cancelled",
      );
      continue;
    }
    // A launched run that is gone from the store cannot be followed any more.
    if (entry.run && !run) {
      exit("cancelled");
      continue;
    }
    if (run) continue; // still active
    const task = index.get(entry.task);
    if (!task) exit("missing");
    else if (task.state === "proposed") exit("not_approved");
    else if (task.state === "review" || task.state === "done") exit("settled");
  }
  return exits;
}

/** The queue without the entries of `tasks`. */
export function withoutEntries(queue: QueueFile, tasks: Iterable<string>): QueueFile {
  const drop = new Set(tasks);
  return { ...queue, entries: queue.entries.filter((entry) => !drop.has(entry.task)) };
}

export type EnqueueResult =
  | { ok: true; queue: QueueFile; added: string[]; already: string[] }
  | {
      ok: false;
      code: "unknown_task" | "not_approved" | "queue_full";
      task?: string;
      message: string;
    };

/**
 * Adds tasks to the end of the queue, in the given order, each with its agent. A task already in
 * the queue keeps its place and agent. Only approved tasks of the plan can be queued.
 */
export function enqueue(
  queue: QueueFile,
  plan: Pick<TasksDocument, "tasks">,
  items: readonly { task: string; agent: QueueEntry["agent"] }[],
  at: string,
): EnqueueResult {
  const index = indexTasks(plan);
  const queued = new Set(queue.entries.map((entry) => entry.task));
  const entries = [...queue.entries];
  const added: string[] = [];
  const already: string[] = [];
  for (const item of items) {
    const task = index.get(item.task);
    if (!task) {
      return { ok: false, code: "unknown_task", task: item.task, message: `No task ${item.task}` };
    }
    if (task.state === "proposed") {
      return {
        ok: false,
        code: "not_approved",
        task: item.task,
        message: `${item.task} is a proposal; approve it before queueing it`,
      };
    }
    if (queued.has(item.task)) {
      already.push(item.task);
      continue;
    }
    queued.add(item.task);
    entries.push({ task: item.task, agent: item.agent, added_at: at });
    added.push(item.task);
  }
  if (entries.length > MAX_QUEUE_ENTRIES) {
    return {
      ok: false,
      code: "queue_full",
      message: `The queue holds at most ${MAX_QUEUE_ENTRIES} tasks`,
    };
  }
  return { ok: true, queue: { ...queue, entries }, added, already };
}

/** Records that the scheduler launched `run` for the entry of `task`. */
export function markLaunched(queue: QueueFile, task: string, run: string): QueueFile {
  return {
    ...queue,
    entries: queue.entries.map((entry) => (entry.task === task ? { ...entry, run } : entry)),
  };
}
