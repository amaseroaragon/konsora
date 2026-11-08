/**
 * Daemon start-up (docs/esquema-tareas.md §6): runs that were alive when the daemon stopped are
 * marked `interrupted`, with an `interrupted` event that keeps the state they were in. Nothing is
 * resumed or launched: the human decides whether to resume one (`resumeRun`) or discard it. The
 * plan is not touched either.
 *
 * A `queued` run only exists while a launch is in progress, so a leftover one is `cancelled`.
 */
import type { RunId, RunState } from "@konsora/core";
import type { RunStore } from "./run-store.ts";

const ALIVE: readonly RunState[] = ["starting", "running", "waiting_approval", "checking"];

export type RecoveredRuns = { interrupted: RunId[]; cancelled: RunId[] };

export async function recoverRuns(
  store: RunStore,
  now: () => Date = () => new Date(),
): Promise<RecoveredRuns> {
  const recovered: RecoveredRuns = { interrupted: [], cancelled: [] };
  const at = () =>
    now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  for (const run of (await store.list()).runs) {
    if (ALIVE.includes(run.state)) {
      await store.transition(run.id, "interrupted");
      await store.appendEvent(run.id, { at: at(), t: "interrupted", from: run.state });
      recovered.interrupted.push(run.id);
    } else if (run.state === "queued") {
      await store.transition(run.id, "cancelled", { finished_at: at() });
      await store.appendEvent(run.id, { at: at(), t: "cancelled", from: "queued" });
      recovered.cancelled.push(run.id);
    }
  }
  return recovered;
}
