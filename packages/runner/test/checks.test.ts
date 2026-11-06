import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedCheck } from "@konsora/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CheckEvent, runCheck, runChecks } from "../src/checks.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "konsora-checks-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const check = (command: string, extra: Partial<PlannedCheck> = {}): PlannedCheck => ({
  id: "test",
  source: "project",
  command,
  timeout_s: 30,
  ...extra,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms = 3000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

describe("runChecks", () => {
  it("runs every check in order in the worktree, keeping exit code, duration and output", async () => {
    const events: CheckEvent[] = [];
    const { attempt, cancelled } = await runChecks(
      [
        check("pwd; echo out; echo err >&2", { id: "where" }),
        check("echo failing; exit 3", { id: "ac1", source: "acceptance" }),
        check("echo still runs"),
      ],
      1,
      { cwd: dir, onEvent: (e) => void events.push(e), now: () => "2026-11-06T20:00:00Z" },
    );
    expect(cancelled).toBe(false);
    expect(attempt).toMatchObject({
      attempt: 1,
      started_at: "2026-11-06T20:00:00Z",
      finished_at: "2026-11-06T20:00:00Z",
    });
    expect(attempt.results.map((r) => [r.id, r.source, r.exit_code, r.timed_out])).toEqual([
      ["where", "project", 0, false],
      ["ac1", "acceptance", 3, false],
      ["test", "project", 0, false],
    ]);
    expect(attempt.results[0]?.output).toBe(`${dir}\nout\nerr\n`);
    expect(attempt.results[1]).toMatchObject({
      command: "echo failing; exit 3",
      output: "failing\n",
    });
    expect(attempt.results.every((r) => r.duration_ms >= 0)).toBe(true);
    expect(events.map((e) => `${e.phase}:${e.id}`)).toEqual([
      "start:where",
      "end:where",
      "start:ac1",
      "end:ac1",
      "start:test",
      "end:test",
    ]);
  });

  it("gives the checks the user's environment without KONSORA_* variables or tokens", async () => {
    const result = await runCheck(check("env"), {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: "/home/me",
        KONSORA_DAEMON_TOKEN: "human-token",
        KONSORA_RUN_TOKEN: "run-token",
        KONSORA_PROJECT: "/p",
      },
    });
    expect(result.output).toContain("HOME=/home/me");
    expect(result.output).not.toContain("KONSORA_");
    expect(result.output).not.toContain("token");
  });

  it("a check past its timeout ends with its whole process group and fails as timed out", async () => {
    const pids = join(dir, "pids");
    const result = await runCheck(
      check(`sleep 60 & echo $! > ${pids}; sleep 60`, { timeout_s: 1 }),
      { cwd: dir, killGraceMs: 200 },
    );
    expect(result).toMatchObject({ exit_code: null, timed_out: true });
    expect(result.duration_ms).toBeGreaterThanOrEqual(900);
    expect(result.duration_ms).toBeLessThan(5000);
    const grandchild = Number(readFileSync(pids, "utf8"));
    expect(await gone(grandchild)).toBe(true);
  });

  it("kills a check that ignores SIGTERM after the grace period", async () => {
    const result = await runCheck(check("trap '' TERM; sleep 60", { timeout_s: 1 }), {
      cwd: dir,
      killGraceMs: 200,
    });
    expect(result).toMatchObject({ exit_code: null, timed_out: true });
    expect(result.duration_ms).toBeLessThan(5000);
  });

  it("leaves no process behind a check that passed, and does not wait for it", async () => {
    const pids = join(dir, "pids");
    const started = Date.now();
    const result = await runCheck(check(`sleep 60 & echo $! > ${pids}; echo done`), { cwd: dir });
    expect(result).toMatchObject({ exit_code: 0, timed_out: false });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await gone(Number(readFileSync(pids, "utf8")))).toBe(true);
  });

  it("a cancellation stops the check in progress and the ones after it", async () => {
    const controller = new AbortController();
    const marker = join(dir, "second-ran");
    const pending = runChecks([check("sleep 60"), check(`touch ${marker}`, { id: "second" })], 1, {
      cwd: dir,
      signal: controller.signal,
      killGraceMs: 200,
    });
    setTimeout(() => controller.abort(), 200);
    const { attempt, cancelled } = await pending;
    expect(cancelled).toBe(true);
    expect(attempt.results).toHaveLength(1);
    expect(attempt.results[0]).toMatchObject({ exit_code: null, timed_out: false });
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps only the tail of a long output", async () => {
    writeFileSync(
      join(dir, "big.sh"),
      'i=0; while [ $i -lt 4000 ]; do echo "line $i ........"; i=$((i+1)); done\n',
    );
    const result = await runCheck(check("sh big.sh"), { cwd: dir });
    expect(result.output_truncated).toBe(true);
    expect(result.output.length).toBe(16_384);
    expect(result.output.endsWith("line 3999 ........\n")).toBe(true);
  });

  it("a command that does not exist fails with the shell's message", async () => {
    const result = await runCheck(check("definitely-not-a-command-konsora"), { cwd: dir });
    expect(result.exit_code).toBe(127);
    expect(result.output).toMatch(/not found/);
  });
});
