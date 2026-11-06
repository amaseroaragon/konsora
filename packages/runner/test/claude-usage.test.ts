import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../src/claude.ts";
import { parseClaudeUsage, parseReset, USAGE_ARGS } from "../src/claude-usage.ts";

const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/claude/usage.json", import.meta.url), "utf8"),
) as { result: string };

const NOW = new Date("2026-11-06T20:00:00Z");
const secs = (iso: string) => Date.parse(iso) / 1000;

describe("parseClaudeUsage", () => {
  it("reads the session and weekly windows of a recorded /usage", () => {
    expect(parseClaudeUsage(recorded.result, NOW)).toEqual([
      { window: "five_hour", utilization: 0.02, resets_at: secs("2026-11-07T00:19:00Z") },
      { window: "seven_day", utilization: 0.83, resets_at: secs("2026-11-07T09:59:00Z") },
    ]);
  });

  it("names a model's own weekly window and keeps one without a reset", () => {
    const text = [
      "Current week (all models): 50% used · resets Nov 9, 10am (UTC)",
      "Current week (Sonnet only): 7% used",
      "Current week (Opus): 100% used · resets in a while",
    ].join("\n");
    expect(parseClaudeUsage(text, NOW)).toEqual([
      { window: "seven_day", utilization: 0.5, resets_at: secs("2026-11-09T10:00:00Z") },
      { window: "seven_day_sonnet", utilization: 0.07 },
      { window: "seven_day_opus", utilization: 1 },
    ]);
  });

  it("has no windows for a text without them", () => {
    expect(parseClaudeUsage("You are using an API key.", NOW)).toEqual([]);
  });

  it("puts resets in the future: a time alone is the next one, a date around New Year next year", () => {
    expect(parseReset("7:05pm (UTC)", NOW)).toBe(secs("2026-11-07T19:05:00Z"));
    expect(parseReset("9:30pm (UTC)", NOW)).toBe(secs("2026-11-06T21:30:00Z"));
    expect(parseReset("Jan 2, 3am (UTC)", new Date("2026-12-30T12:00:00Z"))).toBe(
      secs("2027-01-02T03:00:00Z"),
    );
    expect(parseReset("12:00am (UTC)", NOW)).toBe(secs("2026-11-07T00:00:00Z"));
    expect(parseReset("Nov 7, 1:19am (Europe/Madrid)", NOW)).toBeUndefined();
    expect(parseReset("13:00pm (UTC)", NOW)).toBeUndefined();
  });
});

describe("the Claude adapter's rateLimits()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konsora-usage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const adapter = (usage: string, extra: Record<string, string> = {}) =>
    createClaudeAdapter({
      command: process.execPath,
      prefixArgs: [fakeClaude],
      env: {
        ...process.env,
        FAKE_CLAUDE_USAGE: usage,
        KONSORA_DAEMON_TOKEN: "human-token",
        KONSORA_RUN_TOKEN: "run-token",
        ...extra,
      },
      usageTimeoutMs: 3000,
    });

  it("runs the local /usage in UTC, outside the project and without Konsora's variables", async () => {
    const dump = join(dir, "dump.json");
    const windows = await adapter("recorded", { FAKE_CLAUDE_DUMP: dump }).rateLimits?.();
    expect(windows?.map((w) => w.window)).toEqual(["five_hour", "seven_day"]);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as {
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };
    expect(seen.args).toEqual([...USAGE_ARGS]);
    expect(seen.args).not.toContain("--bare");
    expect(seen.env.TZ).toBe("UTC");
    expect(Object.keys(seen.env).filter((k) => k.startsWith("KONSORA_"))).toEqual([]);
    expect(seen.cwd).toBe(tmpdir());
  });

  it("stops asking once /usage turned out not to be local (it could spend quota)", async () => {
    const dump = join(dir, "dump.json");
    const claude = adapter("model", { FAKE_CLAUDE_DUMP: dump });
    await expect(claude.rateLimits?.()).rejects.toThrow(/does not answer \/usage locally/);
    rmSync(dump);
    await expect(claude.rateLimits?.()).rejects.toThrow(/does not answer \/usage locally/);
    expect(() => readFileSync(dump)).toThrow();
  });

  it("explains a login without windows, a hang and a missing claude", async () => {
    await expect(adapter("none").rateLimits?.()).rejects.toThrow(/no subscription windows/);
    await expect(adapter("hang").rateLimits?.()).rejects.toThrow(/did not answer in time/);
    const missing = createClaudeAdapter({ command: "/nonexistent/claude" });
    await expect(missing.rateLimits?.()).rejects.toThrow(/not installed/);
  });
});
