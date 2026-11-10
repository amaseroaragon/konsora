/**
 * How the UI shows a run's checks (UI-16), as pure functions of `run.json`, `checks.json` and the
 * board, so they can be tested without a browser.
 */
import { type CheckResult, checkPassed, type Run, type RunCheckResult } from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";
import { reviewRun } from "./run-model.ts";

/** "1,2 s", "850 ms", "2 min 05 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return t("checks.ms", { n: ms });
  if (ms < 60_000) return t("checks.s", { n: (ms / 1000).toFixed(1).replace(".", ",") });
  const minutes = Math.floor(ms / 60_000);
  const seconds = String(Math.round((ms % 60_000) / 1000)).padStart(2, "0");
  return t("checks.min", { m: minutes, s: seconds });
}

/** How a check ended, in words: passed, exit code, timeout or stopped. */
export function checkOutcome(result: {
  exit_code: number | null;
  timed_out?: boolean | undefined;
}): string {
  if (checkPassed(result)) return t("checks.passed");
  if (result.timed_out) return t("checks.timedOut");
  if (result.exit_code === null) return t("checks.stopped");
  return t("checks.exit", { code: result.exit_code });
}

const SOURCE: Record<string, MessageKey> = {
  project: "checks.source.project",
  acceptance: "checks.source.acceptance",
};

/** "Proyecto" or "Criterio". */
export function sourceLabel(result: Pick<CheckResult, "source">): string {
  const key = SOURCE[result.source];
  return key ? t(key) : result.source;
}

/** Whether the run's last attempt has a check in red. */
export function runChecksFailed(run: Run | undefined): boolean {
  return (run?.checks ?? []).some((check) => !checkPassed(check));
}

/** Tasks in review whose latest run ended with checks in red. */
export function failingReviews(
  tasks: readonly { id: string; state: string }[],
  runs: readonly Run[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.state === "review" && runChecksFailed(reviewRun(runs, task.id))) ids.add(task.id);
  }
  return ids;
}

/** The last result of each criterion's check in the run, by criterion id (`ac1`…). */
export function criterionResults(run: Run | undefined): Map<string, RunCheckResult> {
  const results = new Map<string, RunCheckResult>();
  for (const check of run?.checks ?? []) {
    // Runs before M8 have no `source`; their ids could only be project checks then.
    if (check.source === "acceptance") results.set(check.id, check);
  }
  return results;
}

/**
 * Accepting a task whose checks are red needs the human's explicit yes (`ask` shows the
 * question, e.g. `window.confirm`); anything else goes ahead.
 */
export function confirmAccept(
  id: string,
  checksFailed: boolean,
  ask: (question: string) => boolean,
): boolean {
  return !checksFailed || ask(t("checks.accept.confirm", { id }));
}
