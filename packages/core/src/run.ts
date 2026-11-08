/**
 * Runs (docs/esquema-tareas.md §6): the schema of `.konsora/runs/<run-id>/run.json`, the state
 * machine of a run and of its integration, and run ids (`r-` + ULID, sortable by time).
 *
 * Pure and browser-safe: the file store lives in `@konsora/runner`.
 */
import { z } from "zod";
import {
  AgentSpecSchema,
  DEFAULT_CHECK_TIMEOUT_S,
  MAX_CHECK_RETRIES,
  READONLY_PROFILE,
  TaskIdSchema,
  type TasksDocument,
  TimestampSchema,
} from "./schema.ts";

/** At most one attempt plus every retry. */
const MAX_ATTEMPTS = MAX_CHECK_RETRIES + 1;

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
  // `running` again: a check failed and the agent gets it back to fix it (a retry).
  checking: ["running", "succeeded", "failed", "cancelled", "interrupted"],
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

/**
 * What resuming an `interrupted` run does, from the state it was in when the daemon stopped: one
 * interrupted while `checking` had already finished its agent, so only the checks run again;
 * any other gets its agent back (in its session when it has one).
 */
export type ResumeStep = "agent" | "checks";

export function resumeStep(interruptedFrom: RunState | undefined): ResumeStep {
  return interruptedFrom === "checking" ? "checks" : "agent";
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
 * How the runner talks to the agent: Claude Code's `stream-json`, `codex app-server`, or the
 * fallback `codex exec --json` (one turn per process).
 */
export const RunTransportSchema = z.enum(["stream-json", "app-server", "exec"]);
export type RunTransport = z.infer<typeof RunTransportSchema>;

export type TransportLimits = {
  /** The human can approve what the sandbox does not allow. */
  approvals: boolean;
  /** An answer reaches the live process; otherwise it resumes the session once it has ended. */
  live_answers: boolean;
  rate_limits: boolean;
};

/** What a run can do over its transport (an unknown transport is assumed complete). */
export function transportLimits(transport: RunTransport | undefined): TransportLimits {
  return transport === "exec"
    ? { approvals: false, live_answers: false, rate_limits: false }
    : { approvals: true, live_answers: true, rate_limits: true };
}

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

const CheckIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, "Check id must be a lowercase slug");

/** Where a check comes from: the project's checks, or a task's acceptance criterion (`acN`). */
export const CheckSourceSchema = z.enum(["project", "acceptance"]);
export type CheckSource = z.infer<typeof CheckSourceSchema>;

/**
 * A check's result in `run.json` (the summary of the last attempt). `source` and `timed_out`
 * arrived with M8; older runs lack them.
 */
export const RunCheckResultSchema = z.strictObject({
  id: CheckIdSchema,
  source: CheckSourceSchema.optional(),
  /** `null` when the check did not exit on its own (timeout or signal). */
  exit_code: z.int().nullable(),
  duration_ms: z.int().min(0),
  timed_out: z.boolean().optional(),
});

/** How `project.setup` went in the run's worktree; its output is in `events.jsonl`. */
export const RunSetupResultSchema = z.strictObject({
  command: z.string().min(1).max(1000),
  exit_code: z.int().nullable(),
  duration_ms: z.int().min(0),
  timed_out: z.boolean(),
});
export type RunSetupResult = z.infer<typeof RunSetupResultSchema>;

/** How much of a check's output `checks.json` keeps: its last characters. */
export const CHECK_OUTPUT_MAX = 16_384;

/** A check's full result in `checks.json`: the summary plus the command and its output's tail. */
export const CheckResultSchema = z.strictObject({
  id: CheckIdSchema,
  source: CheckSourceSchema,
  command: z.string().min(1).max(1000),
  exit_code: z.int().nullable(),
  duration_ms: z.int().min(0),
  timed_out: z.boolean(),
  /** The tail of stdout and stderr, interleaved as they came. */
  output: z.string().max(CHECK_OUTPUT_MAX),
  /** The output was longer and only its tail is kept. */
  output_truncated: z.boolean().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** One pass over the checks: the first after `finish`, then one per retry. */
export const CheckAttemptSchema = z.strictObject({
  attempt: z.int().min(1),
  started_at: TimestampSchema,
  finished_at: TimestampSchema.optional(),
  results: z.array(CheckResultSchema).max(200),
});
export type CheckAttempt = z.infer<typeof CheckAttemptSchema>;

/** `.konsora/runs/<id>/checks.json`: every attempt of the run, in order. */
export const ChecksFileSchema = z
  .strictObject({
    run: RunIdSchema,
    attempts: z.array(CheckAttemptSchema).max(MAX_ATTEMPTS),
  })
  .superRefine((file, ctx) => {
    file.attempts.forEach((attempt, i) => {
      if (attempt.attempt !== i + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", i, "attempt"],
          message: `Attempt ${i + 1} is numbered ${attempt.attempt}`,
        });
      }
    });
  });
export type ChecksFile = z.infer<typeof ChecksFileSchema>;

/** A check that exited 0 within its time. */
export function checkPassed(result: {
  exit_code: number | null;
  timed_out?: boolean | undefined;
}): boolean {
  return result.exit_code === 0 && result.timed_out !== true;
}

/** Every check passed (no checks counts as passed). */
export function checksPassed(
  results: readonly { exit_code: number | null; timed_out?: boolean | undefined }[],
) {
  return results.every(checkPassed);
}

/** The `run.json` summary of an attempt: the results without command and output. */
export function checkSummary(attempt: CheckAttempt): RunCheckResult[] {
  return attempt.results.map((r) => ({
    id: r.id,
    source: r.source,
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    timed_out: r.timed_out,
  }));
}

/** Keeps the last `max` characters of a check's output. */
export function tailOutput(
  text: string,
  max: number = CHECK_OUTPUT_MAX,
): { output: string; truncated: boolean } {
  return text.length > max
    ? { output: text.slice(text.length - max), truncated: true }
    : { output: text, truncated: false };
}

/** A check to run: a project check, or an acceptance criterion with a `check`. */
export type PlannedCheck = {
  id: string;
  source: CheckSource;
  command: string;
  timeout_s: number;
};

/**
 * The checks of a run, in order: the project's checks, then the task's acceptance criteria that
 * have a `check`. Taken from the plan as it was approved when the run was launched.
 */
export function plannedChecks(document: TasksDocument, taskId: string): PlannedCheck[] {
  const task = document.tasks.find((t) => t.id === taskId);
  return [
    ...(document.project.checks ?? []).map((check) => ({
      id: check.id,
      source: "project" as const,
      command: check.run,
      timeout_s: check.timeout_s ?? DEFAULT_CHECK_TIMEOUT_S,
    })),
    ...(task?.acceptance ?? []).flatMap((ac) =>
      ac.check
        ? [
            {
              id: ac.id,
              source: "acceptance" as const,
              command: ac.check,
              timeout_s: DEFAULT_CHECK_TIMEOUT_S,
            },
          ]
        : [],
    ),
  ];
}

/** What a run does: the task's work (the default), or a review of another run's work (CORE-13). */
export const RunKindSchema = z.enum(["work", "review"]);
export type RunKind = z.infer<typeof RunKindSchema>;

/** A review run: it never occupies its task, never runs checks and is never integrated. */
export function isReviewRun(run: Pick<Run, "kind">): boolean {
  return run.kind === "review";
}

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
    transport: RunTransportSchema.optional(),
    started_at: TimestampSchema.optional(),
    finished_at: TimestampSchema.optional(),
    exit: RunExitSchema.optional(),
    usage: RunUsageSchema.optional(),
    summary: z.string().min(1).max(20_000).optional(),
    /** `project.setup`, run in the worktree before the agent. */
    setup: RunSetupResultSchema.optional(),
    /** The results of the last attempt; every attempt is in `checks.json`. */
    checks: z.array(RunCheckResultSchema).optional(),
    /** How many times the checks ran (1 + the retries used). */
    check_attempts: z.int().min(0).max(MAX_ATTEMPTS).optional(),
    integration: z.strictObject({ state: IntegrationStateSchema }).optional(),
    /**
     * A rebase run (M9): the run whose integration conflicted. This run works on that run's
     * branch and worktree, rebasing it onto the current tip of `base_branch`.
     */
    rebase_of: RunIdSchema.optional(),
    /**
     * A variant (CORE-12, best-of-N): the id of the first run of its group, its own included.
     * The group's runs run at once with different agents; the human chooses the winner.
     */
    variant_of: RunIdSchema.optional(),
    /**
     * `review` (CORE-13): a second agent reviews the work of `review_of`, a finished run, with
     * the `readonly` profile. It leaves `review` notes and nothing else. Absent: a work run.
     */
    kind: RunKindSchema.optional(),
    review_of: RunIdSchema.optional(),
  })
  .superRefine((run, ctx) => {
    if (run.kind === "review") {
      if (!run.review_of) {
        ctx.addIssue({
          code: "custom",
          path: ["review_of"],
          message: "A review run needs review_of",
        });
      }
      if (run.agent.permissions !== READONLY_PROFILE) {
        ctx.addIssue({
          code: "custom",
          path: ["agent", "permissions"],
          message: `A review run always uses the "${READONLY_PROFILE}" profile`,
        });
      }
      if (run.variant_of || run.rebase_of) {
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "A review run cannot be a variant or a rebase run",
        });
      }
    } else if (run.review_of) {
      ctx.addIssue({
        code: "custom",
        path: ["review_of"],
        message: "Only a review run has review_of",
      });
    }
    if (run.variant_of && run.rebase_of) {
      ctx.addIssue({
        code: "custom",
        path: ["variant_of"],
        message: "A rebase run cannot be a variant",
      });
    }
    if (run.integration && !isFinishedRunState(run.state)) {
      ctx.addIssue({
        code: "custom",
        path: ["integration"],
        message: `A ${run.state} run cannot have an integration state; it has not finished`,
      });
    }
  });

export type Run = z.infer<typeof RunSchema>;

export type ProviderRateLimits = {
  provider: Run["agent"]["provider"];
  /** The run they come from, and when it reported them (its end, or its start). */
  run: Run["id"];
  at: string;
  windows: RateLimitWindow[];
};

/**
 * The latest rate limits known for each provider: those of its most recent run that reported
 * any. They describe the account, so a newer run replaces an older one whole.
 */
export function latestRateLimits(runs: readonly Run[]): ProviderRateLimits[] {
  const latest = new Map<string, ProviderRateLimits>();
  for (const run of runs) {
    const windows = run.usage?.rate_limits;
    const at = run.finished_at ?? run.started_at;
    if (!windows || windows.length === 0 || !at) continue;
    const known = latest.get(run.agent.provider);
    if (known && (known.at > at || (known.at === at && known.run > run.id))) continue;
    latest.set(run.agent.provider, {
      provider: run.agent.provider,
      run: run.id,
      at,
      windows: windows.map((w) => ({ ...w })),
    });
  }
  return [...latest.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1));
}
export type RunUsage = z.infer<typeof RunUsageSchema>;
export type RunCheckResult = z.infer<typeof RunCheckResultSchema>;

/** A direct read of a provider's rate limits (no run, no quota), or why it failed. */
export type LimitsReading =
  | { at: string; windows: RateLimitWindow[] }
  | { at: string; error: string };

/**
 * The rate limits shown for one provider: the freshest of a direct read and what its runs last
 * reported, with where they come from and when.
 */
export type ProviderLimits = {
  provider: Run["agent"]["provider"];
  /** `provider`: read from it directly; `run`: reported by a run; `none`: nothing is known. */
  source: "provider" | "run" | "none";
  at?: string;
  /** The run they come from (`source: "run"`). */
  run?: Run["id"];
  windows: RateLimitWindow[];
  /** Why there is no direct read (the provider has none, or it failed). */
  unavailable?: string;
};

export function providerLimits(
  provider: ProviderLimits["provider"],
  reading: LimitsReading | undefined,
  fromRuns: ProviderRateLimits | undefined,
): ProviderLimits {
  const read = reading && "windows" in reading && reading.windows.length > 0 ? reading : undefined;
  const unavailable = read
    ? undefined
    : reading && "error" in reading
      ? reading.error
      : "This provider has no way to read its limits without a run";
  if (read && (!fromRuns || read.at >= fromRuns.at)) {
    return {
      provider,
      source: "provider",
      at: read.at,
      windows: read.windows.map((w) => ({ ...w })),
    };
  }
  if (fromRuns) {
    return {
      provider,
      source: "run",
      at: fromRuns.at,
      run: fromRuns.run,
      windows: fromRuns.windows.map((w) => ({ ...w })),
      ...(unavailable ? { unavailable } : {}),
    };
  }
  return { provider, source: "none", windows: [], ...(unavailable ? { unavailable } : {}) };
}

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

/** `project.setup` as the runner runs it, with its default timeout; `null` without one. */
export function plannedSetup(
  document: TasksDocument,
): { command: string; timeout_s: number } | null {
  const setup = document.project.setup;
  return setup
    ? { command: setup.run, timeout_s: setup.timeout_s ?? DEFAULT_CHECK_TIMEOUT_S }
    : null;
}
