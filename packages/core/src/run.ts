/**
 * Runs (docs/esquema-tareas.md §6): the schema of `.konsora/runs/<run-id>/run.json`, the state
 * machine of a run and of its integration, and run ids (`r-` + ULID, sortable by time).
 *
 * Pure and browser-safe: the file store lives in `@konsora/runner`.
 */
import { z } from "zod";
import { AgentSpecSchema, TaskIdSchema, TimestampSchema } from "./schema.ts";

// ── Ids ──────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10; // 48-bit milliseconds
const RANDOM_CHARS = 16; // 80 random bits
const MAX_TIME = 2 ** 48 - 1;

/** `r-` + a ULID in Crockford base32 (26 characters; the first one is at most 7). */
export const RunIdSchema = z
  .string()
  .regex(/^r-[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Run id must be r- followed by a ULID");

export type RunId = z.infer<typeof RunIdSchema>;

export type RunIdOptions = {
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  /** Fills the array with random bytes. Default `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array<ArrayBuffer>) => void;
};

/**
 * Returns a generator of run ids that sort by creation time. Ids created in the same millisecond
 * (or while the clock goes backwards) reuse the last time and increment the random part, so they
 * still sort in creation order (monotonic ULID).
 */
export function createRunIdGenerator(options: RunIdOptions = {}): () => RunId {
  const now = options.now ?? Date.now;
  const random =
    options.random ?? ((bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes));
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    let time = Math.floor(now());
    if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
      throw new RangeError(`Cannot encode time ${time} in a run id`);
    }
    if (time <= lastTime) {
      time = lastTime;
      lastRandom = increment(lastRandom);
    } else {
      const bytes = new Uint8Array(RANDOM_CHARS);
      random(bytes);
      lastRandom = Array.from(bytes, (b) => b % 32);
    }
    lastTime = time;
    let timePart = "";
    for (let i = 0, t = time; i < TIME_CHARS; i++, t = Math.floor(t / 32)) {
      timePart = CROCKFORD[t % 32] + timePart;
    }
    return `r-${timePart}${lastRandom.map((d) => CROCKFORD[d]).join("")}`;
  };
}

function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = (next[i] as number) + 1;
    if (digit < 32) {
      next[i] = digit;
      return next;
    }
    next[i] = 0;
  }
  throw new RangeError("Run id random part overflowed within one millisecond");
}

/** A process-wide monotonic run id generator. */
export const newRunId: () => RunId = createRunIdGenerator();

/** The creation time encoded in a run id, in milliseconds since the epoch. */
export function runIdTime(id: RunId): number {
  let time = 0;
  for (const char of id.slice(2, 2 + TIME_CHARS)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}

// ── States ───────────────────────────────────────────────────────────────────

export const RunStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "checking",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const IntegrationStateSchema = z.enum(["pending", "merged", "conflict", "discarded"]);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

/**
 * Allowed run transitions. `interrupted` is a run that was alive when the daemon stopped: it is
 * never resumed on its own, but the human may resume it (`→ starting`, with `--resume`) or
 * discard it (`→ cancelled`).
 */
const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["starting", "cancelled"],
  starting: ["running", "failed", "cancelled", "interrupted"],
  running: ["waiting_approval", "checking", "failed", "cancelled", "interrupted"],
  waiting_approval: ["running", "failed", "cancelled", "interrupted"],
  checking: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: ["starting", "cancelled"],
};

/**
 * States that occupy the task: a task has at most one run in these. `interrupted` counts, because
 * it can still be resumed; discard it (`cancelled`) before starting another run.
 */
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "checking",
  "interrupted",
];

export function isActiveRunState(state: RunState): boolean {
  return ACTIVE_RUN_STATES.includes(state);
}

/** Final states: nothing follows them. Only finished runs can be integrated or discarded. */
export function isFinishedRunState(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

const INTEGRATION_TRANSITIONS: Readonly<
  Record<IntegrationState | "none", readonly IntegrationState[]>
> = {
  none: ["pending", "discarded"],
  pending: ["merged", "conflict", "discarded"],
  conflict: ["merged", "discarded"],
  merged: [],
  discarded: [],
};

// ── run.json ─────────────────────────────────────────────────────────────────

const CommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "Commit must be a full SHA-1 or SHA-256 hex id");

export const RunExitSchema = z.strictObject({
  code: z.int().nullable(),
  signal: z.string().min(1).max(20).nullable(),
});

/**
 * One rate-limit window of the provider's account (e.g. Claude's `five_hour` or `seven_day`), as
 * last reported during the run. It describes the account, not the run.
 */
export const RateLimitWindowSchema = z.strictObject({
  window: z.string().regex(/^[a-z0-9_]{1,40}$/, "Rate-limit window must be a lowercase slug"),
  /** The provider's status for the window, e.g. "allowed", "allowed_warning", "rejected". */
  status: z.string().min(1).max(40).optional(),
  /** Fraction of the window already used (0.68 = 68 %). */
  utilization: z.number().min(0).max(100).optional(),
  resets_at: TimestampSchema.optional(),
});

/**
 * The run's usage. `input_tokens` is every input token, cache included (as before the breakdown);
 * `cache_read_tokens` and `cache_write_tokens` are the part of it served from or written to the
 * prompt cache, and `reasoning_tokens` the part of `output_tokens` spent thinking. The breakdown
 * and `rate_limits` are present only when the provider reports them.
 */
export const RunUsageSchema = z.strictObject({
  input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
  cost_usd: z.number().min(0).nullable(),
  cache_read_tokens: z.int().min(0).optional(),
  cache_write_tokens: z.int().min(0).optional(),
  reasoning_tokens: z.int().min(0).optional(),
  rate_limits: z.array(RateLimitWindowSchema).max(10).optional(),
});

export const RunCheckResultSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "Check id must be a lowercase slug"),
  /** `null` when the check did not exit on its own (timeout or signal). */
  exit_code: z.int().nullable(),
  duration_ms: z.int().min(0),
});

/**
 * `run.json`. Only the identity and the state are required: the rest is filled in as the run goes
 * (worktree and branch when it starts, `session_id` from the provider, commits, exit, usage and
 * checks when it closes, `integration` once it has finished).
 */
export const RunSchema = z
  .strictObject({
    id: RunIdSchema,
    task: TaskIdSchema,
    /** `taskHash` of the task as it was when the run was created. */
    task_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "task_hash must be sha256:<hex>"),
    agent: AgentSpecSchema,
    state: RunStateSchema,
    worktree: z.string().min(1).max(4096).optional(),
    branch: z.string().min(1).max(255).optional(),
    base_commit: CommitSchema.optional(),
    head_commit: CommitSchema.optional(),
    /** The exact prompt sent to the agent (`buildRunPrompt`), kept for audit. */
    prompt: z.string().min(1).max(1_000_000).optional(),
    session_id: z.string().min(1).max(200).optional(),
    started_at: TimestampSchema.optional(),
    finished_at: TimestampSchema.optional(),
    exit: RunExitSchema.optional(),
    usage: RunUsageSchema.optional(),
    summary: z.string().min(1).max(20_000).optional(),
    checks: z.array(RunCheckResultSchema).optional(),
    integration: z.strictObject({ state: IntegrationStateSchema }).optional(),
  })
  .superRefine((run, ctx) => {
    if (run.integration && !isFinishedRunState(run.state)) {
      ctx.addIssue({
        code: "custom",
        path: ["integration"],
        message: `A ${run.state} run cannot have an integration state; it has not finished`,
      });
    }
  });

export type Run = z.infer<typeof RunSchema>;
export type RunUsage = z.infer<typeof RunUsageSchema>;
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

// ── Transitions ──────────────────────────────────────────────────────────────

export type RunTransitionError = {
  code: "invalid_transition";
  message: string;
  run: RunId;
  from: string;
  to: string;
};

export type RunTransitionResult = { ok: true; run: Run } | { ok: false; error: RunTransitionError };

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** Moves a run to `to`, or explains why it cannot. Pure: returns a new object. */
export function transitionRun(run: Run, to: RunState): RunTransitionResult {
  if (!canTransitionRun(run.state, to)) {
    const allowed = RUN_TRANSITIONS[run.state];
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message:
          allowed.length === 0
            ? `Run ${run.id} is ${run.state}, which is final`
            : `Run ${run.id} cannot go from ${run.state} to ${to} (allowed: ${allowed.join(", ")})`,
        run: run.id,
        from: run.state,
        to,
      },
    };
  }
  return { ok: true, run: { ...run, state: to } };
}

/** Moves a finished run's integration to `to` (`pending → merged | conflict | discarded`). */
export function transitionIntegration(run: Run, to: IntegrationState): RunTransitionResult {
  const from = run.integration?.state ?? "none";
  const fail = (message: string): RunTransitionResult => ({
    ok: false,
    error: { code: "invalid_transition", message, run: run.id, from, to },
  });
  if (!isFinishedRunState(run.state)) {
    return fail(`Run ${run.id} is ${run.state}; only finished runs can be integrated or discarded`);
  }
  if (to === "pending" && run.state !== "succeeded") {
    return fail(`Run ${run.id} is ${run.state}; only a succeeded run can wait for integration`);
  }
  if (!INTEGRATION_TRANSITIONS[from].includes(to)) {
    return fail(
      from === "none"
        ? `Run ${run.id} has no integration yet; it can only become pending or discarded`
        : `Run ${run.id} integration cannot go from ${from} to ${to}`,
    );
  }
  return { ok: true, run: { ...run, integration: { state: to } } };
}
