import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunUsageSchema } from "@konsora/core";
import { describe, expect, it } from "vitest";
import { ClaudeNormalizer } from "../src/claude.ts";
import { UsageTally } from "../src/usage.ts";

function tallyRecording(name: string) {
  const normalizer = new ClaudeNormalizer("/work/repo");
  const tally = new UsageTally();
  const path = fileURLToPath(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url));
  for (const line of readFileSync(path, "utf8").split("\n")) {
    for (const event of normalizer.push(line)) if (event.t === "usage") tally.add(event);
  }
  return tally.toRunUsage();
}

describe("UsageTally", () => {
  it("turns a real Claude session into run.json's usage, with the breakdown and the windows", () => {
    const usage = tallyRecording("success");
    expect(RunUsageSchema.safeParse(usage).error?.issues ?? []).toEqual([]);
    expect(usage).toEqual({
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
        {
          window: "seven_day",
          status: "allowed",
          utilization: 0.25,
          resets_at: "2026-11-07T10:00:00Z",
        },
      ],
    });
  });

  it("sums the turns and leaves out what the provider did not report", () => {
    const tally = new UsageTally();
    tally.add({ t: "usage", input_tokens: 10, output_tokens: 2 });
    tally.add({ t: "usage", input_tokens: 5, output_tokens: 1 });
    expect(tally.toRunUsage()).toEqual({ input_tokens: 15, output_tokens: 3, cost_usd: null });
  });

  it("uses the overall window when the provider gives no per-window detail", () => {
    const tally = new UsageTally();
    tally.add({ t: "usage", rate_limits: { status: "rejected", window: "seven_day" } });
    tally.add({ t: "usage", rate_limits: { status: "allowed" } });
    expect(tally.toRunUsage().rate_limits).toEqual([{ window: "seven_day", status: "rejected" }]);
  });

  it("drops values run.json could not hold", () => {
    const tally = new UsageTally();
    tally.add({
      t: "usage",
      input_tokens: -4,
      cost_usd: Number.NaN,
      rate_limits: {
        status: "allowed",
        windows: [
          { window: "Not A Slug", utilization: 0.1 },
          { window: "weekly", utilization: -1, resets_at: Number.POSITIVE_INFINITY },
        ],
      },
    });
    const usage = tally.toRunUsage();
    expect(usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: null,
      rate_limits: [{ window: "weekly" }],
    });
    expect(RunUsageSchema.safeParse(usage).success).toBe(true);
  });
});
