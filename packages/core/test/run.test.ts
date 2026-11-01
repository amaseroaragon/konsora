import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  createRunIdGenerator,
  isActiveRunState,
  type Run,
  RunIdSchema,
  RunSchema,
  type RunState,
  RunStateSchema,
  runIdTime,
  transitionIntegration,
  transitionRun,
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

  it.each([
    ["an unknown state", { state: "paused" }],
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
