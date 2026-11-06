import type { Run } from "@konsora/core";
import type { AgentAdapter, RateLimitWindow } from "@konsora/runner";
import { describe, expect, it } from "vitest";
import { Limits } from "../src/limits.ts";

const RESET = 1794011580; // 2026-11-07T00:33:00Z

function adapter(id: "claude" | "codex", read?: () => Promise<RateLimitWindow[]>): AgentAdapter {
  return {
    id,
    detect: async () => ({ installed: true }),
    models: async () => [],
    start: () => {
      throw new Error("no runs here");
    },
    ...(read ? { rateLimits: read } : {}),
  };
}

const claudeRun = (finished: string, utilization: number): Run => ({
  id: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
  task: "BE-01",
  task_hash: `sha256:${"0".repeat(64)}`,
  agent: { provider: "claude", model: "opus" },
  state: "succeeded",
  finished_at: finished,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cost_usd: null,
    rate_limits: [{ window: "five_hour", status: "allowed", utilization }],
  },
});

function clock(start: string) {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Limits", () => {
  it("reads Codex directly and gives Claude what its last run reported, with dates and sources", async () => {
    const time = clock("2026-11-06T20:00:00Z");
    const limits = new Limits({
      adapters: {
        codex: adapter("codex", async () => [
          { window: "five_hour", status: "allowed", utilization: 0.12, resets_at: RESET },
        ]),
        claude: adapter("claude", async () => {
          throw new Error("claude -p /usage did not answer in time");
        }),
      },
      runs: async () => [claudeRun("2026-11-06T18:00:00Z", 0.5)],
      now: time.now,
    });
    expect(await limits.list()).toEqual([
      {
        provider: "claude",
        source: "run",
        at: "2026-11-06T18:00:00Z",
        run: "r-01JC8Z3K2QX7M4V9T0B6N5R8PW",
        windows: [{ window: "five_hour", status: "allowed", utilization: 0.5 }],
        unavailable: "claude -p /usage did not answer in time",
      },
      {
        provider: "codex",
        source: "provider",
        at: "2026-11-06T20:00:00Z",
        windows: [
          {
            window: "five_hour",
            status: "allowed",
            utilization: 0.12,
            resets_at: "2026-11-07T00:33:00Z",
          },
        ],
      },
    ]);
  });

  it("says why a provider has nothing", async () => {
    const limits = new Limits({
      adapters: { claude: adapter("claude") },
      runs: async () => [],
    });
    expect(await limits.list()).toEqual([
      {
        provider: "claude",
        source: "none",
        windows: [],
        unavailable: "This provider has no way to read its limits without a run",
      },
    ]);
  });

  it("keeps a read for the TTL, shares concurrent reads and reads again on refresh", async () => {
    const time = clock("2026-11-06T20:00:00Z");
    let reads = 0;
    const limits = new Limits({
      adapters: {
        codex: adapter("codex", async () => {
          reads++;
          return [{ window: "five_hour", utilization: reads / 10 }];
        }),
      },
      runs: async () => [],
      ttlMs: 60_000,
      now: time.now,
    });
    await Promise.all([limits.list(), limits.list()]);
    expect(reads).toBe(1);
    time.advance(30_000);
    await limits.list();
    expect(reads).toBe(1);
    await limits.list({ refresh: true });
    expect(reads).toBe(2);
    time.advance(60_000);
    const [codex] = await limits.list();
    expect(reads).toBe(3);
    expect(codex?.windows[0]?.utilization).toBe(0.3);
  });

  it("broadcasts limits.updated only when something changed, a newer source winning", async () => {
    const time = clock("2026-11-06T20:00:00Z");
    const sent: { type: string; limits: { source: string; windows: unknown[] }[] }[] = [];
    const limits = new Limits({
      adapters: {
        claude: adapter("claude", async () => [{ window: "five_hour", utilization: 0.1 }]),
      },
      runs: async () => [],
      broadcast: (payload) => sent.push(payload as (typeof sent)[number]),
      now: time.now,
    });
    await limits.list();
    await limits.list();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.limits[0]?.source).toBe("provider");

    // A live run reports later: it is newer than the read.
    const run = { id: claudeRun("x", 0).id, agent: { provider: "claude" as const, model: "opus" } };
    await limits.onRunUsage(run, "2026-11-06T20:05:00Z", {
      status: "allowed",
      windows: [{ window: "five_hour", utilization: 0.2, resets_at: RESET }],
    });
    await limits.onRunUsage(run, "2026-11-06T20:05:00Z", {
      status: "allowed",
      windows: [{ window: "five_hour", utilization: 0.2, resets_at: RESET }],
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.limits[0]).toMatchObject({ source: "run", run: run.id });
  });
});
