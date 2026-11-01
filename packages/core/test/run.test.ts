import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  createRunIdGenerator,
  isActiveRunState,
  latestRateLimits,
  type Run,
  RunIdSchema,
  RunSchema,
  type RunState,
  RunStateSchema,
  runIdTime,
  transitionIntegration,
  transitionRun,
  transportLimits,
} from "../src/run.ts";

/** The `run.json` example of docs/esquema-tareas.md §6, read from the doc itself. */
function docExample(): unknown {
  const doc = readFileSync(
    fileURLToPath(new URL("../../../docs/esquema-tareas.md", import.meta.url)),
    "utf8",
  );
  const section = doc.slice(doc.indexOf("## 6. Runs"));
  const match = /`run\.json`[^\n]*:\n\n```json\n([\s\S]*?)\n```/.exec(section);
  if (!match?.[1]) throw new Error("run.json example not found in esquema-tareas.md §6");
  return JSON.parse(match[1]);
}

const base: Run = {
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-02",
  task_hash: `sha256:${"a".repeat(64)}`,
  agent: { provider: "claude", model: "opus", permissions: "default" },
  state: "queued",
};

describe("RunSchema", () => {
  it("accepts the example in esquema-tareas.md §6", () => {
    const parsed = RunSchema.safeParse(docExample());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.state).toBe("succeeded");
  });

  it("accepts a freshly queued run with only the required fields", () => {
    expect(RunSchema.safeParse(base).success).toBe(true);
  });

  it("records the transport, and what each one allows", () => {
    expect(RunSchema.safeParse({ ...base, transport: "exec" }).success).toBe(true);
    expect(RunSchema.safeParse({ ...base, transport: "ssh" }).success).toBe(false);
    expect(transportLimits("exec")).toEqual({
      approvals: false,
      live_answers: false,
      rate_limits: false,
    });
    expect(transportLimits("app-server").approvals).toBe(true);
    expect(transportLimits(undefined).live_answers).toBe(true);
  });

  it("keeps accepting the usage written before the breakdown", () => {
    const old = { input_tokens: 41200, output_tokens: 5300, cost_usd: null };
    expect(RunSchema.safeParse({ ...base, state: "succeeded", usage: old }).success).toBe(true);
  });

  it("accepts the usage breakdown and the rate-limit windows", () => {
    const usage = {
      input_tokens: 80772,
      output_tokens: 765,
      cost_usd: 0.005146,
      cache_read_tokens: 59948,
      cache_write_tokens: 20816,
      reasoning_tokens: 131,
      rate_limits: [
        {
          window: "five_hour",
          status: "allowed",
          utilization: 0.68,
          resets_at: "2026-11-01T13:20:00Z",
        },
        { window: "seven_day" },
      ],
    };
    const parsed = RunSchema.safeParse({ ...base, state: "succeeded", usage });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it.each([
    ["an unknown state", { state: "paused" }],
    [
      "a rate-limit window with a bad name",
      {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
          rate_limits: [{ window: "Five Hour" }],
        },
      },
    ],
    [
      "a rate-limit reset that is not a UTC timestamp",
      {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
          rate_limits: [{ window: "five_hour", resets_at: 1793539200 }],
        },
      },
    ],
    [
      "negative cache tokens",
      { usage: { input_tokens: 0, output_tokens: 0, cost_usd: null, cache_read_tokens: -1 } },
    ],
    ["an unknown integration state", { state: "succeeded", integration: { state: "rebased" } }],
    [
      "integration on a run that has not finished",
      { state: "running", integration: { state: "pending" } },
    ],
    ["a short run id", { id: "r-01JC8Z3K2Q" }],
    ["a run id with forbidden letters", { id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PU" }],
    ["a bad task id", { task: "be-2" }],
    ["a bad task hash", { task_hash: "sha256:xyz" }],
    ["an abbreviated commit", { base_commit: "3f2c" }],
    ["an unknown key", { prompt_tokens: 3 }],
    ["a timestamp with offset", { started_at: "2026-11-02T10:00:00+01:00" }],
  ])("rejects %s", (_, patch) => {
    expect(RunSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe("latestRateLimits", () => {
  const limited = (id: string, provider: "claude" | "codex", at: string, used: number): Run => ({
    ...base,
    id: `r-01JC8Z3K2QX7M4V9T0B6N5R8${id}`,
    agent: { provider, model: "m" },
    state: "succeeded",
    finished_at: at,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: null,
      rate_limits: [{ window: "five_hour", utilization: used }],
    },
  });

  it("keeps each provider's most recent snapshot", () => {
    const runs = [
      limited("P1", "claude", "2026-11-01T10:00:00Z", 0.1),
      limited("P2", "claude", "2026-11-01T12:00:00Z", 0.5),
      limited("P3", "codex", "2026-11-01T11:00:00Z", 0.2),
      { ...base, id: "r-01JC8Z3K2QX7M4V9T0B6N5R8P4", finished_at: "2026-11-01T13:00:00Z" } as Run,
    ];
    expect(latestRateLimits(runs)).toEqual([
      {
        provider: "claude",
        run: "r-01JC8Z3K2QX7M4V9T0B6N5R8P2",
        at: "2026-11-01T12:00:00Z",
        windows: [{ window: "five_hour", utilization: 0.5 }],
      },
      {
        provider: "codex",
        run: "r-01JC8Z3K2QX7M4V9T0B6N5R8P3",
        at: "2026-11-01T11:00:00Z",
        windows: [{ window: "five_hour", utilization: 0.2 }],
      },
    ]);
    expect(latestRateLimits([])).toEqual([]);
  });
});

describe("run state machine", () => {
  const states = RunStateSchema.options;
  const allowed: [RunState, RunState][] = [
    ["queued", "starting"],
    ["queued", "cancelled"],
    ["starting", "running"],
    ["starting", "failed"],
    ["starting", "cancelled"],
    ["starting", "interrupted"],
    ["running", "waiting_approval"],
    ["running", "checking"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["running", "interrupted"],
    ["waiting_approval", "running"],
    ["waiting_approval", "failed"],
    ["waiting_approval", "cancelled"],
    ["waiting_approval", "interrupted"],
    ["checking", "succeeded"],
    ["checking", "failed"],
    ["checking", "cancelled"],
    ["checking", "interrupted"],
    ["interrupted", "starting"],
    ["interrupted", "cancelled"],
  ];

  it("allows exactly the documented transitions", () => {
    const key = (from: string, to: string) => `${from}→${to}`;
    const expected = new Set(allowed.map(([from, to]) => key(from, to)));
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionRun(from, to), key(from, to)).toBe(expected.has(key(from, to)));
      }
    }
  });

  it("moves a run along the happy path", () => {
    let run = base;
    for (const to of [
      "starting",
      "running",
      "waiting_approval",
      "running",
      "checking",
      "succeeded",
    ] as const) {
      const result = transitionRun(run, to);
      if (!result.ok) throw new Error(result.error.message);
      run = result.run;
    }
    expect(run.state).toBe("succeeded");
    expect(base.state).toBe("queued");
  });

  it("rejects an invalid transition with a typed error", () => {
    const result = transitionRun(base, "succeeded");
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_transition",
        run: base.id,
        from: "queued",
        to: "succeeded",
      }),
    });
    const final = transitionRun({ ...base, state: "failed" }, "running");
    expect(!final.ok && final.error.message).toMatch(/final/);
  });

  it("counts interrupted as active, and final states as not", () => {
    expect(states.filter(isActiveRunState)).toEqual([
      "queued",
      "starting",
      "running",
      "waiting_approval",
      "checking",
      "interrupted",
    ]);
  });
});

describe("integration state machine", () => {
  const succeeded: Run = { ...base, state: "succeeded" };

  it("goes pending → conflict → merged on a succeeded run", () => {
    const pending = transitionIntegration(succeeded, "pending");
    if (!pending.ok) throw new Error(pending.error.message);
    const conflict = transitionIntegration(pending.run, "conflict");
    if (!conflict.ok) throw new Error(conflict.error.message);
    const merged = transitionIntegration(conflict.run, "merged");
    if (!merged.ok) throw new Error(merged.error.message);
    expect(merged.run.integration).toEqual({ state: "merged" });
    expect(RunSchema.safeParse(merged.run).success).toBe(true);
  });

  it("lets any finished run be discarded, but only a succeeded one wait for integration", () => {
    const failed: Run = { ...base, state: "failed" };
    expect(transitionIntegration(failed, "discarded").ok).toBe(true);
    expect(transitionIntegration(failed, "pending").ok).toBe(false);
  });

  it.each([
    ["a run that has not finished", { ...base, state: "running" as const }, "pending" as const],
    ["merging without pending", succeeded, "merged" as const],
    [
      "leaving merged",
      { ...succeeded, integration: { state: "merged" as const } },
      "discarded" as const,
    ],
    [
      "going back to pending",
      { ...succeeded, integration: { state: "conflict" as const } },
      "pending" as const,
    ],
  ])("rejects %s", (_, run, to) => {
    const result = transitionIntegration(run, to);
    expect(!result.ok && result.error.code).toBe("invalid_transition");
  });
});

describe("run ids", () => {
  it("are valid ULID run ids that sort by creation time, even within one millisecond", () => {
    let clock = 1_700_000_000_000;
    const ticks = [0, 0, 0, 1, 1, 5, 5, 5, 5, 100];
    const next = createRunIdGenerator({ now: () => clock });
    const ids: string[] = [];
    for (const tick of ticks) {
      clock += tick;
      ids.push(next());
    }
    for (const id of ids) expect(RunIdSchema.safeParse(id).success).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(runIdTime(ids.at(-1) as string)).toBe(clock);
  });

  it("stay ordered when the clock goes backwards", () => {
    const times = [5_000, 4_000, 6_000];
    const next = createRunIdGenerator({ now: () => times.shift() as number });
    const ids = [next(), next(), next()];
    expect([...ids].sort()).toEqual(ids);
  });

  it("carry the random part into the next digit", () => {
    const next = createRunIdGenerator({
      now: () => 0,
      random: (bytes) => {
        bytes.fill(0);
        bytes[bytes.length - 1] = 31;
      },
    });
    expect(next()).toBe(`r-0000000000${"0".repeat(15)}Z`);
    expect(next()).toBe(`r-0000000000${"0".repeat(14)}10`);
  });

  it("orders 10,000 ids from the default generator", () => {
    const next = createRunIdGenerator();
    const ids = Array.from({ length: 10_000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
  });
});
