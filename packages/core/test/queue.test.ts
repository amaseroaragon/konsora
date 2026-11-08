import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { indexTasks, topoOrder } from "../src/graph.ts";
import {
  DEFAULT_MAX_PARALLEL,
  emptyQueue,
  enqueue,
  launchOrder,
  markLaunched,
  nextRuns,
  type ParallelLimits,
  parseDaemonSettings,
  parseQueueFile,
  type QueueFile,
  queueExits,
  queueOnStartup,
  queueStatus,
  type ScheduledRun,
  slotUsage,
  takesSlot,
  withoutEntries,
} from "../src/queue.ts";
import { RunStateSchema } from "../src/run.ts";
import type { AgentSpec, Task, TaskState, TasksDocument } from "../src/schema.ts";
import { documentArb } from "./arbitraries.ts";

const at = "2026-11-08T10:00:00Z";
const claude: AgentSpec = { provider: "claude", model: "sonnet" };
const codex: AgentSpec = { provider: "codex", model: "gpt-5" };

function task(id: string, state: TaskState, deps: string[] = [], rank = "a0"): Task {
  return {
    id,
    title: id,
    state,
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank,
    created: { at, by: "human" },
    updated_at: at,
  };
}

function queue(tasks: string[], agent: AgentSpec = claude, state: QueueFile["state"] = "running") {
  return {
    version: 1 as const,
    state,
    entries: tasks.map((t) => ({ task: t, agent, added_at: at })),
  };
}

const limits = (max = 2, per_provider: ParallelLimits["per_provider"] = {}): ParallelLimits => ({
  max_parallel: max,
  per_provider,
});

function run(id: number, taskId: string, state: ScheduledRun["state"], provider = "claude") {
  return {
    id: `r-01J${String(id).padStart(23, "0")}`,
    task: taskId,
    state,
    agent: { provider: provider as AgentSpec["provider"] },
  };
}

describe("queue.json", () => {
  it("defaults a missing file to an empty running queue", () => {
    expect(parseQueueFile(undefined)).toEqual({ ok: true, queue: emptyQueue() });
  });

  it("fills the defaults of an older, partial file", () => {
    const parsed = parseQueueFile({ entries: [{ task: "A-01", agent: claude, added_at: at }] });
    expect(parsed).toEqual({
      ok: true,
      queue: {
        version: 1,
        state: "running",
        entries: [{ task: "A-01", agent: claude, added_at: at }],
      },
    });
    expect(parseQueueFile({})).toEqual({ ok: true, queue: emptyQueue() });
  });

  it("rejects unknown fields, bad entries and duplicates", () => {
    expect(parseQueueFile({ state: "paused", extra: 1 }).ok).toBe(false);
    expect(parseQueueFile({ entries: [{ task: "nope", agent: claude, added_at: at }] }).ok).toBe(
      false,
    );
    expect(parseQueueFile({ version: 2 }).ok).toBe(false);
    const dup = { task: "A-01", agent: claude, added_at: at };
    expect(parseQueueFile({ entries: [dup, dup] }).ok).toBe(false);
  });

  it("pauses a non-empty queue at start-up and leaves an empty one alone", () => {
    expect(queueOnStartup(queue(["A-01"])).state).toBe("paused");
    expect(queueOnStartup(emptyQueue()).state).toBe("running");
  });
});

describe("settings.json", () => {
  it("defaults a missing or partial file", () => {
    const defaults = {
      version: 1,
      parallel: { max_parallel: DEFAULT_MAX_PARALLEL, per_provider: {} },
    };
    expect(parseDaemonSettings(undefined)).toEqual({ ok: true, settings: defaults });
    expect(parseDaemonSettings({})).toEqual({ ok: true, settings: defaults });
    expect(parseDaemonSettings({ parallel: { per_provider: { codex: 1 } } })).toEqual({
      ok: true,
      settings: { version: 1, parallel: { max_parallel: 2, per_provider: { codex: 1 } } },
    });
  });

  it("rejects out-of-range limits and unknown providers", () => {
    expect(parseDaemonSettings({ parallel: { max_parallel: 0 } }).ok).toBe(false);
    expect(parseDaemonSettings({ parallel: { max_parallel: 1.5 } }).ok).toBe(false);
    expect(parseDaemonSettings({ parallel: { per_provider: { gemini: 1 } } }).ok).toBe(false);
    expect(parseDaemonSettings({ extra: true }).ok).toBe(false);
  });
});

describe("slots", () => {
  it("counts processes, not interrupted or finished runs", () => {
    const taking = RunStateSchema.options.filter(takesSlot);
    expect(taking).toEqual(["queued", "starting", "running", "waiting_approval", "checking"]);
    const usage = slotUsage([
      run(1, "A-01", "running"),
      run(2, "A-02", "interrupted"),
      run(3, "A-03", "checking", "codex"),
      run(4, "A-04", "succeeded"),
    ]);
    expect(usage).toEqual({ total: 2, per_provider: { claude: 1, codex: 1 } });
  });
});

describe("nextRuns", () => {
  const plan = {
    tasks: [
      task("A-01", "todo", [], "a3"),
      task("A-02", "todo", [], "a1"),
      task("A-03", "todo", ["A-01"], "a0"),
      task("A-04", "review"),
      task("A-05", "todo", ["A-04"]),
      task("A-06", "todo", [], "a2"),
    ],
  };

  it("launches ready queued tasks by topological order then rank, within max_parallel", () => {
    const q = queue(["A-01", "A-02", "A-03", "A-06"]);
    expect(nextRuns({ queue: q, plan, runs: [], limits: limits(2) }).map((e) => e.task)).toEqual([
      "A-02",
      "A-06",
    ]);
    expect(nextRuns({ queue: q, plan, runs: [], limits: limits(5) }).map((e) => e.task)).toEqual([
      "A-02",
      "A-06",
      "A-01",
    ]);
  });

  it("does not launch while paused, nor tasks outside the queue", () => {
    expect(
      nextRuns({ queue: queue(["A-01"], claude, "paused"), plan, runs: [], limits: limits() }),
    ).toEqual([]);
    expect(nextRuns({ queue: emptyQueue(), plan, runs: [], limits: limits() })).toEqual([]);
  });

  it("waits for a dependency in review (only done unblocks)", () => {
    const status = queueStatus({ queue: queue(["A-05"]), plan, runs: [], limits: limits() });
    expect(status).toEqual([{ task: "A-05", wait: { kind: "blocked", deps: ["A-04"] } }]);
  });

  it("counts the slots of active runs, here and in other projects", () => {
    const q = queue(["A-01", "A-02", "A-06"]);
    const busy = [run(1, "A-01", "running")];
    expect(
      nextRuns({
        queue: markLaunched(q, "A-01", busy[0]?.id as string),
        plan,
        runs: busy,
        limits: limits(2),
      }).map((e) => e.task),
    ).toEqual(["A-02"]);
    expect(
      nextRuns({
        queue: q,
        plan,
        runs: [],
        limits: limits(2),
        elsewhere: [run(9, "X-01", "running"), run(8, "X-02", "starting")],
      }),
    ).toEqual([]);
  });

  it("respects the per-provider limit without starving other providers", () => {
    const q = {
      ...queue([]),
      entries: [
        { task: "A-02", agent: codex, added_at: at },
        { task: "A-06", agent: codex, added_at: at },
        { task: "A-01", agent: claude, added_at: at },
      ],
    };
    const status = queueStatus({ queue: q, plan, runs: [], limits: limits(3, { codex: 1 }) });
    expect(status.map((s) => [s.task, s.wait.kind])).toEqual([
      ["A-02", "launch"],
      ["A-06", "slot"],
      ["A-01", "launch"],
    ]);
  });

  it("skips a task with an active run the queue did not launch", () => {
    const status = queueStatus({
      queue: queue(["A-02"]),
      plan,
      runs: [run(1, "A-02", "interrupted")],
      limits: limits(),
    });
    expect(status[0]?.wait).toMatchObject({ kind: "busy", state: "todo" });
  });

  it("is deterministic: the queue's own order does not change what launches", () => {
    const a = nextRuns({
      queue: queue(["A-06", "A-02", "A-01"]),
      plan,
      runs: [],
      limits: limits(3),
    });
    const b = nextRuns({
      queue: queue(["A-01", "A-06", "A-02"]),
      plan,
      runs: [],
      limits: limits(3),
    });
    expect(a.map((e) => e.task)).toEqual(b.map((e) => e.task));
    expect(launchOrder(queue(["A-03", "A-01"]), plan).map((e) => e.task)).toEqual(["A-01", "A-03"]);
  });

  const scenario = documentArb.chain((doc) =>
    fc.record({
      doc: fc.constant(doc),
      queued: fc.subarray(doc.tasks.map((t) => t.id)),
      providers: fc.array(fc.constantFrom("claude", "codex"), {
        minLength: doc.tasks.length,
        maxLength: doc.tasks.length,
      }),
      paused: fc.boolean(),
      active: fc.subarray(doc.tasks.map((t) => t.id)),
      activeStates: fc.array(fc.constantFrom(...RunStateSchema.options), {
        minLength: doc.tasks.length,
        maxLength: doc.tasks.length,
      }),
      elsewhere: fc.array(fc.constantFrom("claude", "codex", "none"), { maxLength: 4 }),
      max: fc.integer({ min: 1, max: 6 }),
      perClaude: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
      perCodex: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
    }),
  );

  it("never exceeds a limit, never launches a blocked, busy or unqueued task (properties)", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const doc: TasksDocument = s.doc;
        const pick = (i: number) => (s.providers[i] === "codex" ? codex : claude);
        const ids = doc.tasks.map((t) => t.id);
        const q: QueueFile = {
          version: 1,
          state: s.paused ? "paused" : "running",
          entries: s.queued.map((t) => ({ task: t, agent: pick(ids.indexOf(t)), added_at: at })),
        };
        const runs = s.active.map((t, i) =>
          run(i + 1, t, s.activeStates[ids.indexOf(t)] ?? "running", pick(ids.indexOf(t)).provider),
        );
        const elsewhere = s.elsewhere.map((p, i) =>
          run(
            100 + i,
            "Z-01",
            p === "none" ? "interrupted" : "running",
            p === "codex" ? "codex" : "claude",
          ),
        );
        const per_provider = {
          ...(s.perClaude ? { claude: s.perClaude } : {}),
          ...(s.perCodex ? { codex: s.perCodex } : {}),
        };
        const lim = limits(s.max, per_provider);
        const launched = nextRuns({ queue: q, plan: doc, runs, limits: lim, elsewhere });

        if (s.paused) expect(launched).toEqual([]);
        const all = [...runs, ...elsewhere];
        const before = slotUsage(all);
        expect(before.total + launched.length).toBeLessThanOrEqual(Math.max(s.max, before.total));
        for (const provider of ["claude", "codex"] as const) {
          const cap = per_provider[provider];
          if (cap === undefined) continue;
          const used = before.per_provider[provider] ?? 0;
          const added = launched.filter((e) => e.agent.provider === provider).length;
          expect(used + added).toBeLessThanOrEqual(Math.max(cap, used));
          if (used >= cap) expect(added).toBe(0);
        }
        const index = indexTasks(doc);
        const queued = new Set(s.queued);
        const activeTasks = new Set(
          runs
            .filter(
              (r) =>
                RunStateSchema.parse(r.state) &&
                !["succeeded", "failed", "cancelled"].includes(r.state),
            )
            .map((r) => r.task),
        );
        for (const entry of launched) {
          expect(queued.has(entry.task)).toBe(true);
          const t = index.get(entry.task) as Task;
          expect(t.state).toBe("todo");
          for (const dep of t.deps ?? []) expect(index.get(dep)?.state).toBe("done");
          expect(activeTasks.has(entry.task)).toBe(false);
        }
        expect(new Set(launched.map((e) => e.task)).size).toBe(launched.length);
        // Launch order follows the plan's topological order.
        const position = new Map(topoOrder(doc).order.map((id, i) => [id, i]));
        const positions = launched.map((e) => position.get(e.task) as number);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      }),
    );
  });
});

describe("queueExits", () => {
  const plan = {
    tasks: [
      task("A-01", "review"),
      task("A-02", "todo"),
      task("A-03", "todo"),
      task("A-04", "proposed"),
      task("A-05", "done"),
      task("A-06", "todo"),
      task("A-07", "doing"),
    ],
  };

  it("says why each entry leaves, and keeps the rest", () => {
    const runs = [
      run(1, "A-01", "succeeded"),
      run(2, "A-02", "failed"),
      run(3, "A-03", "cancelled"),
      run(4, "A-07", "running"),
    ];
    let q = queue(["A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "B-09"]);
    q = markLaunched(q, "A-01", runs[0]?.id as string);
    q = markLaunched(q, "A-02", runs[1]?.id as string);
    q = markLaunched(q, "A-03", runs[2]?.id as string);
    q = markLaunched(q, "A-07", runs[3]?.id as string);
    expect(queueExits({ queue: q, plan, runs })).toEqual([
      { task: "A-01", reason: "succeeded", run: runs[0]?.id },
      { task: "A-02", reason: "failed", run: runs[1]?.id },
      { task: "A-03", reason: "cancelled", run: runs[2]?.id },
      { task: "A-04", reason: "not_approved" },
      { task: "A-05", reason: "settled" },
      { task: "B-09", reason: "missing" },
    ]);
  });

  it("drops an entry whose launched run vanished", () => {
    const q = markLaunched(queue(["A-02"]), "A-02", run(5, "A-02", "running").id);
    expect(queueExits({ queue: q, plan, runs: [] })).toEqual([
      { task: "A-02", reason: "cancelled", run: run(5, "A-02", "running").id },
    ]);
  });

  it("removes entries", () => {
    expect(withoutEntries(queue(["A-01", "A-02"]), ["A-01"]).entries.map((e) => e.task)).toEqual([
      "A-02",
    ]);
  });
});

describe("enqueue", () => {
  const plan = { tasks: [task("A-01", "todo"), task("A-02", "proposed"), task("A-03", "review")] };

  it("appends in order and keeps an entry already queued", () => {
    const first = enqueue(emptyQueue(), plan, [{ task: "A-01", agent: claude }], at);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = enqueue(
      first.queue,
      plan,
      [
        { task: "A-03", agent: codex },
        { task: "A-01", agent: codex },
      ],
      "2026-11-08T11:00:00Z",
    );
    expect(second).toMatchObject({ ok: true, added: ["A-03"], already: ["A-01"] });
    if (!second.ok) return;
    expect(second.queue.entries).toEqual([
      { task: "A-01", agent: claude, added_at: at },
      { task: "A-03", agent: codex, added_at: "2026-11-08T11:00:00Z" },
    ]);
  });

  it("refuses proposals and unknown tasks", () => {
    expect(enqueue(emptyQueue(), plan, [{ task: "A-02", agent: claude }], at)).toMatchObject({
      ok: false,
      code: "not_approved",
    });
    expect(enqueue(emptyQueue(), plan, [{ task: "B-01", agent: claude }], at)).toMatchObject({
      ok: false,
      code: "unknown_task",
    });
  });
});
