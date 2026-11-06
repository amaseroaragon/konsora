/**
 * Runs a run's checks in its worktree (RUN-18, docs/arquitectura.md §5 "Verificar").
 *
 * - Each check is `/bin/sh -c <command>` in the worktree, in a process group of its own, with
 *   the user's environment minus every `KONSORA_*` variable (no daemon or run tokens).
 * - Its timeout (`timeout_s`) or a cancellation sends SIGTERM to the whole group and, after a
 *   grace period, SIGKILL. When the check ends, whatever it left running in its group is killed
 *   too, so no process outlives its check.
 * - stdout and stderr go into one buffer, of which only the tail is kept (`CHECK_OUTPUT_MAX`).
 * - The checks run in order and all of them run, even after one fails, so the result is
 *   complete; a cancellation stops after the current one.
 *
 * Checks run code the agent wrote, outside the agent's sandbox, as if the human ran `npm test`.
 */
import { spawn } from "node:child_process";
import {
  CHECK_OUTPUT_MAX,
  type CheckAttempt,
  type CheckResult,
  type PlannedCheck,
  tailOutput,
} from "@konsora/core";
import { agentEnv } from "./env.ts";

export const CHECK_KILL_GRACE_MS = 5000;

export type CheckEvent =
  | { t: "check"; phase: "start"; id: string; source: CheckResult["source"]; command: string }
  | {
      t: "check";
      phase: "end";
      id: string;
      source: CheckResult["source"];
      exit_code: number | null;
      duration_ms: number;
      timed_out: boolean;
    };

export type CheckRunOptions = {
  /** The run's worktree. */
  cwd: string;
  /** The environment the checks' is derived from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Aborting it stops the check in progress (cancelling the run). */
  signal?: AbortSignal;
  /** Between SIGTERM and SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
  /** Called before and after each check (events.jsonl). */
  onEvent?: (event: CheckEvent) => Promise<void> | void;
  /** Timestamps of the attempt. */
  now?: () => string;
};

/** Keeps the tail of a growing output without holding all of it. */
class Tail {
  #text = "";
  #truncated = false;
  push(chunk: string) {
    this.#text += chunk;
    if (this.#text.length > CHECK_OUTPUT_MAX * 2) {
      this.#text = this.#text.slice(this.#text.length - CHECK_OUTPUT_MAX);
      this.#truncated = true;
    }
  }
  result(): { output: string; truncated: boolean } {
    const { output, truncated } = tailOutput(this.#text);
    return { output, truncated: truncated || this.#truncated };
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

/** Runs one check; never rejects (a check that cannot start fails with its reason as output). */
export function runCheck(check: PlannedCheck, options: CheckRunOptions): Promise<CheckResult> {
  const started = performance.now();
  const tail = new Tail();
  const base = { id: check.id, source: check.source, command: check.command };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", check.command], {
        cwd: options.cwd,
        env: agentEnv(options.env ?? process.env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ...base,
        exit_code: null,
        duration_ms: 0,
        timed_out: false,
        output: `Konsora could not start the check: ${(error as Error).message}`,
      });
      return;
    }
    const pid = child.pid;
    let timedOut = false;
    let stopping = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup(pid, "SIGTERM");
      graceTimer = setTimeout(
        () => killGroup(pid, "SIGKILL"),
        options.killGraceMs ?? CHECK_KILL_GRACE_MS,
      );
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, check.timeout_s * 1000);
    const onAbort = () => stop();
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => tail.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => tail.push(chunk));
    let failure: string | undefined;
    // When the shell exits, what it left behind in its group goes too (this also closes pipes
    // a background process still held, so the check does not wait for it).
    child.on("exit", () => killGroup(pid, "SIGKILL"));
    child.on("error", (error) => {
      failure = `Konsora could not start the check: ${error.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup(pid, "SIGKILL");
      if (failure) tail.push(`${failure}\n`);
      const { output, truncated } = tail.result();
      resolve({
        ...base,
        exit_code: timedOut || stopping ? null : code,
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        timed_out: timedOut,
        output,
        ...(truncated ? { output_truncated: true } : {}),
      });
    });
  });
}

/**
 * Runs the checks in order as attempt `number`. `cancelled` is true when the signal stopped it;
 * the results then hold the checks that ran, the stopped one included.
 */
export async function runChecks(
  checks: readonly PlannedCheck[],
  number: number,
  options: CheckRunOptions,
): Promise<{ attempt: CheckAttempt; cancelled: boolean }> {
  const now = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const attempt: CheckAttempt = { attempt: number, started_at: now(), results: [] };
  let cancelled = false;
  for (const check of checks) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    await options.onEvent?.({
      t: "check",
      phase: "start",
      id: check.id,
      source: check.source,
      command: check.command,
    });
    const result = await runCheck(check, options);
    attempt.results.push(result);
    await options.onEvent?.({
      t: "check",
      phase: "end",
      id: result.id,
      source: result.source,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
    });
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
  }
  attempt.finished_at = now();
  return { attempt, cancelled };
}
