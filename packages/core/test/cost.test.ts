import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groupCost, taskCost, usageTotals } from "../src/cost.ts";
import { type Run, RunSchema, type RunUsage } from "../src/run.ts";
import type { TasksDocument } from "../src/schema.ts";

const HASH = `sha256:${"0".repeat(64)}`;

function run(
  n: number,
  task: string,
  usage?: RunUsage,
  agent: Run["agent"] = { provider: "claude", model: "opus" },
): Run {
  return RunSchema.parse({
    id: `r-01JC8Z3K2Q${String(n).padStart(16, "0")}`,
    task,
    task_hash: HASH,
    agent,
    state: "succeeded",
    ...(usage ? { usage } : {}),
  });
}

const usage = (input: number, output: number, cost: number | null, extra = {}): RunUsage => ({
  input_tokens: input,
  output_tokens: output,
  cost_usd: cost,
  ...extra,
});

const doc: Pick<TasksDocument, "tasks"> = {
  tasks: [
    { id: "BE-01", group: "BE" },
    { id: "BE-02", group: "FE" }, // moved to FE: its runs count for FE
    { id: "FE-01", group: "FE" },
  ] as TasksDocument["tasks"],
};

describe("usageTotals", () => {
  it("sums tokens and known costs, and counts the unknown cost apart", () => {
    const totals = usageTotals([
      run(1, "BE-01", usage(100, 10, 0.5, { cache_read_tokens: 40, reasoning_tokens: 3 })),
      run(2, "BE-01", usage(50, 5, null, { cache_write_tokens: 7 }), {
        provider: "codex",
        model: "gpt-5.5",
      }),
      run(3, "BE-01"),
    ]);
    expect(totals).toMatchObject({
      runs: 3,
      no_usage_runs: 1,
      input_tokens: 150,
      output_tokens: 15,
      cache_read_tokens: 40,
      cache_write_tokens: 7,
      reasoning_tokens: 3,
      cost_usd: 0.5,
      cost_unknown_runs: 2,
    });
  });

  it("gives a null cost, not zero, when no run has one", () => {
    const totals = usageTotals([
      run(1, "BE-01", usage(1, 1, null), { provider: "codex", model: "gpt-5.5" }),
    ]);
    expect(totals.cost_usd).toBeNull();
    expect(totals.cost_unknown_runs).toBe(1);
    expect(usageTotals([]).cost_usd).toBeNull();
  });

  it("breaks the usage down per provider and model, ordered", () => {
    const totals = usageTotals([
      run(1, "BE-01", usage(10, 1, 0.1), { provider: "claude", model: "sonnet" }),
      run(2, "BE-01", usage(20, 2, null), { provider: "codex", model: "gpt-5.5" }),
      run(3, "BE-01", usage(30, 3, 0.3), { provider: "claude", model: "opus" }),
      run(4, "BE-01", usage(40, 4, 0.4), { provider: "claude", model: "sonnet" }),
    ]);
    expect(
      totals.by_agent.map((a) => [a.provider, a.model, a.runs, a.input_tokens, a.cost_usd]),
    ).toEqual([
      ["claude", "opus", 1, 30, 0.3],
      ["claude", "sonnet", 2, 50, 0.5],
      ["codex", "gpt-5.5", 1, 20, null],
    ]);
  });
});

describe("taskCost and groupCost", () => {
  const runs = [
    run(1, "BE-01", usage(10, 1, 1)),
    run(2, "BE-01", usage(20, 2, 2)), // a retry or a rebase: another run of the same task
    run(3, "BE-02", usage(30, 3, 3)),
    run(4, "FE-01", usage(40, 4, null), { provider: "codex", model: "gpt-5.5" }),
    run(5, "OPS-01", usage(50, 5, 5)), // its task is gone: counts for OPS
  ];

  it("adds every run of the task", () => {
    expect(taskCost(runs, "BE-01")).toMatchObject({ runs: 2, input_tokens: 30, cost_usd: 3 });
    expect(taskCost(runs, "UI-01")).toMatchObject({ runs: 0, cost_usd: null });
  });

  it("adds the runs of the tasks the group has now", () => {
    expect(groupCost(runs, doc, "BE")).toMatchObject({ runs: 2, input_tokens: 30 });
    expect(groupCost(runs, doc, "FE")).toMatchObject({
      runs: 2,
      input_tokens: 70,
      cost_usd: 3,
      cost_unknown_runs: 1,
    });
    expect(groupCost(runs, doc, "OPS")).toMatchObject({ runs: 1, cost_usd: 5 });
  });
});

const AGENTS: Run["agent"][] = [
  { provider: "claude", model: "opus" },
  { provider: "claude", model: "sonnet" },
  { provider: "codex", model: "gpt-5.5" },
];
const TASKS = ["BE-01", "BE-02", "FE-01", "OPS-01"];
const usageArb: fc.Arbitrary<RunUsage | undefined> = fc.option(
  fc.record(
    {
      input_tokens: fc.nat(1_000_000),
      output_tokens: fc.nat(1_000_000),
      cost_usd: fc.option(
        fc.integer({ min: 0, max: 100_000 }).map((c) => c / 1000),
        {
          nil: null,
        },
      ),
      cache_read_tokens: fc.nat(1_000_000),
      cache_write_tokens: fc.nat(1_000_000),
      reasoning_tokens: fc.nat(1_000_000),
    },
    { requiredKeys: ["input_tokens", "output_tokens", "cost_usd"] },
  ),
  { nil: undefined },
);
const runsArb = fc
  .array(
    fc.record({
      task: fc.constantFrom(...TASKS),
      agent: fc.constantFrom(...AGENTS),
      usage: usageArb,
    }),
    { maxLength: 30 },
  )
  .map((specs) => specs.map((s, i) => run(i + 1, s.task, s.usage, s.agent)));

const sum = (runs: readonly Run[], pick: (u: RunUsage) => number) =>
  runs.reduce((total, r) => total + (r.usage ? pick(r.usage) : 0), 0);

describe("properties", () => {
  it("each total is the sum over its runs, and unknown costs are never summed", () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const totals = usageTotals(runs);
        expect(totals.runs).toBe(runs.length);
        expect(totals.no_usage_runs).toBe(runs.filter((r) => !r.usage).length);
        expect(totals.input_tokens).toBe(sum(runs, (u) => u.input_tokens));
        expect(totals.output_tokens).toBe(sum(runs, (u) => u.output_tokens));
        expect(totals.cache_read_tokens).toBe(sum(runs, (u) => u.cache_read_tokens ?? 0));
        expect(totals.cache_write_tokens).toBe(sum(runs, (u) => u.cache_write_tokens ?? 0));
        expect(totals.reasoning_tokens).toBe(sum(runs, (u) => u.reasoning_tokens ?? 0));
        const known = runs.filter((r) => r.usage && r.usage.cost_usd !== null);
        expect(totals.cost_unknown_runs).toBe(runs.length - known.length);
        if (known.length === 0) expect(totals.cost_usd).toBeNull();
        else
          expect(totals.cost_usd).toBeCloseTo(
            sum(known, (u) => u.cost_usd ?? 0),
            6,
          );
      }),
    );
  });

  it("the breakdown partitions the runs and adds up to the totals", () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const totals = usageTotals(runs);
        const parts = totals.by_agent;
        expect(new Set(parts.map((p) => `${p.provider}/${p.model}`)).size).toBe(parts.length);
        for (const part of parts) {
          const own = runs.filter(
            (r) => r.agent.provider === part.provider && r.agent.model === part.model,
          );
          expect(part).toEqual({
            provider: part.provider,
            model: part.model,
            ...usageTotals(own),
            by_agent: undefined,
          });
        }
        for (const key of ["runs", "input_tokens", "output_tokens", "cost_unknown_runs"] as const)
          expect(parts.reduce((t, p) => t + p[key], 0)).toBe(totals[key]);
      }),
    );
  });

  it("tasks and groups partition the runs", () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const all = usageTotals(runs);
        const byTask = TASKS.map((t) => taskCost(runs, t));
        const byGroup = ["BE", "FE", "OPS"].map((g) => groupCost(runs, doc, g));
        for (const parts of [byTask, byGroup]) {
          expect(parts.reduce((t, p) => t + p.runs, 0)).toBe(all.runs);
          expect(parts.reduce((t, p) => t + p.input_tokens, 0)).toBe(all.input_tokens);
          expect(parts.reduce((t, p) => t + p.cost_unknown_runs, 0)).toBe(all.cost_unknown_runs);
          const costs = parts.map((p) => p.cost_usd).filter((c) => c !== null);
          if (all.cost_usd === null) expect(costs).toEqual([]);
          else expect(costs.reduce((t, c) => t + c, 0)).toBeCloseTo(all.cost_usd, 6);
        }
        expect(groupCost(runs, doc, "FE")).toEqual(
          usageTotals(runs.filter((r) => r.task === "BE-02" || r.task === "FE-01")),
        );
      }),
    );
  });
});
