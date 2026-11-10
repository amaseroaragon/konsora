/**
 * Runs as the UI shows them (UI-10): pure functions over the daemon's `run.json` and the lines of
 * `events.jsonl`, so the live log, the touched files and the usage are testable without a DOM.
 */
import {
  isActiveRunState,
  isReviewRun,
  type Run,
  stableStringify,
  variantCandidates,
  variantGroup,
  variantsOutcome,
} from "@konsora/core";
import { type MessageKey, t } from "../i18n/index.ts";
import type { RunLogEvent, RunLogEventKind } from "../ui/index.ts";

/** One line of `events.jsonl`: a normalized agent event or a runner event, with its time. */
export type RunEventRecord = { at: string; t: string } & Record<string, unknown>;

/** Inserts or replaces a run (by id) in a list kept oldest first. */
export function upsertRun(runs: readonly Run[] | undefined, run: Run): Run[] {
  const list = [...(runs ?? [])];
  const index = list.findIndex((r) => r.id === run.id);
  if (index >= 0) list[index] = run;
  else list.push(run);
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Appends a live event. The same line can arrive twice (fetched with the history and pushed over
 * the WebSocket), so one equal to any of the latest few is dropped.
 */
export function appendEvent(
  events: readonly RunEventRecord[] | undefined,
  event: RunEventRecord,
): RunEventRecord[] {
  const list = [...(events ?? [])];
  const key = stableStringify(event);
  if (list.slice(-20).some((e) => stableStringify(e) === key)) return list;
  list.push(event);
  return list;
}

/**
 * The runs that work on a task. Review runs (CORE-13) only read another run's work: they never
 * stand for the task's run, its review or its worktree.
 */
function workRuns(runs: readonly Run[] | undefined, task: string): Run[] {
  return (runs ?? []).filter((run) => run.task === task && !isReviewRun(run));
}

/** The task's latest run, if any. */
export function latestRun(runs: readonly Run[] | undefined, task: string): Run | undefined {
  return workRuns(runs, task).at(-1);
}

/**
 * The run the task's review is about: its latest run, except that a rebase run that did not
 * succeed leaves the conflicting run it tried to rebase (the one `accept` integrates).
 */
export function reviewRun(runs: readonly Run[] | undefined, task: string): Run | undefined {
  const latest = latestRun(runs, task);
  // Variants (RUN-28): once one is chosen (or only one succeeded), the review is about it.
  if (latest?.variant_of) {
    const candidates = variantCandidates(workRuns(runs, task), latest.variant_of);
    if (candidates.length === 1) return candidates[0];
  }
  if (!latest?.rebase_of || latest.state === "succeeded" || isActiveRunState(latest.state)) {
    return latest;
  }
  return (runs ?? []).find((run) => run.id === latest.rebase_of) ?? latest;
}

/** The variants of the task's latest run (UI-24), oldest first; none if it is not a variant. */
export function taskVariants(runs: readonly Run[] | undefined, task: string): Run[] {
  const latest = latestRun(runs, task);
  return latest?.variant_of ? variantGroup(workRuns(runs, task), latest.variant_of) : [];
}

/**
 * The variants the human still has to choose from: those that succeeded and were not discarded,
 * once every variant of the group has closed, when there are two or more.
 */
export function variantsToChoose(runs: readonly Run[] | undefined, task: string): Run[] {
  const latest = latestRun(runs, task);
  const group = latest?.variant_of;
  if (!group) return [];
  const mine = workRuns(runs, task);
  if (variantsOutcome(mine, group) === "running") return [];
  const candidates = variantCandidates(mine, group);
  return candidates.length > 1 ? candidates : [];
}

export function activeRun(runs: readonly Run[] | undefined, task: string): Run | undefined {
  return workRuns(runs, task).find((run) => isActiveRunState(run.state));
}

/** Run is offered only on a ready task, outside read-only mode, with no run already active. */
export function canRun(
  task: { ready?: boolean; state: string },
  options: { readOnly: boolean; runs: readonly Run[] | undefined; id: string },
): boolean {
  return (
    task.state === "todo" &&
    task.ready === true &&
    !options.readOnly &&
    !activeRun(options.runs, options.id)
  );
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function toolKind(name: string): RunLogEventKind {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "Bash") return "bash";
  if (READ_TOOLS.has(name)) return "read";
  return "message";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** `HH:MM:SS` in local time; the raw value if it is not a date. */
export function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString("es", { hour12: false });
}

const RUNNER_TEXT: Record<string, [RunLogEventKind, MessageKey]> = {
  waiting_answer: ["message", "run.log.waitingAnswer"],
  answer: ["message", "run.log.answer"],
  cancel: ["end", "run.log.cancel"],
  cancelled: ["end", "run.log.cancelled"],
  interrupted: ["error", "run.log.interrupted"],
};

/**
 * The log's rows: what the agent says and does. Successful tool ends, usage and turn ends stay
 * out (the start row already says what ran); failed tools show as errors.
 */
export function logRows(events: readonly RunEventRecord[]): RunLogEvent[] {
  const rows: RunLogEvent[] = [];
  for (const event of events) {
    const at = clock(event.at);
    const runner = RUNNER_TEXT[event.t];
    if (runner) {
      rows.push({ at, kind: runner[0], text: t(runner[1]) });
      continue;
    }
    switch (event.t) {
      case "started":
        rows.push({ at, kind: "start", text: t("run.log.started", { model: str(event.model) }) });
        break;
      case "message":
        rows.push({ at, kind: "message", text: str(event.text) });
        break;
      case "tool": {
        const name = str(event.name);
        const summary = str(event.summary);
        if (event.phase === "start") {
          rows.push({ at, kind: toolKind(name), text: summary ? `${name} · ${summary}` : name });
        } else if (event.ok === false) {
          rows.push({ at, kind: "error", text: summary ? `${name} · ${summary}` : name });
        }
        break;
      }
      case "permission":
        rows.push({ at, kind: "permission", text: `${str(event.tool)} · ${str(event.detail)}` });
        break;
      case "error":
        rows.push({ at, kind: "error", text: str(event.message) });
        break;
      case "setup":
        rows.push(
          event.phase === "start"
            ? { at, kind: "bash", text: t("run.log.setup.start", { command: str(event.command) }) }
            : {
                at,
                kind: event.exit_code === 0 && event.timed_out !== true ? "check" : "error",
                text: t(
                  event.exit_code === 0 && event.timed_out !== true
                    ? "run.log.setup.ok"
                    : "run.log.setup.fail",
                ),
              },
        );
        break;
      case "check": {
        const id = str(event.id);
        if (event.phase === "start") {
          rows.push({
            at,
            kind: "check",
            text: t("run.log.check.start", { id, command: str(event.command) }),
          });
        } else {
          const passed = event.exit_code === 0 && event.timed_out !== true;
          const how = event.timed_out
            ? t("checks.timedOut")
            : event.exit_code === null || event.exit_code === undefined
              ? t("checks.stopped")
              : t("checks.exit", { code: String(event.exit_code) });
          rows.push({
            at,
            kind: passed ? "check" : "error",
            text: passed ? t("run.log.check.ok", { id }) : t("run.log.check.fail", { id, how }),
          });
        }
        break;
      }
      case "retry":
        rows.push({
          at,
          kind: "message",
          text: t("run.log.retry", {
            n: String(event.attempt ?? ""),
            of: String(event.of ?? ""),
          }),
        });
        break;
      case "finished":
        rows.push({
          at,
          kind: "end",
          text: t(event.ok === true ? "run.log.finished.ok" : "run.log.finished.fail"),
        });
        break;
      default:
        break;
    }
  }
  return rows;
}

export type TouchedFile = { path: string; change: "add" | "modify" | "delete" };

/** Files the agent created, changed or deleted, each once with its latest change, in order. */
export function touchedFiles(events: readonly RunEventRecord[]): TouchedFile[] {
  const files = new Map<string, TouchedFile>();
  for (const event of events) {
    if (event.t !== "file") continue;
    const path = str(event.path);
    const change = event.change;
    if (!path || (change !== "add" && change !== "modify" && change !== "delete")) continue;
    files.delete(path);
    files.set(path, { path, change });
  }
  return [...files.values()];
}

export type RunUsage = {
  input: number;
  output: number;
  cost: number | null;
  /** The parts the provider broke down, when it did. */
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

/**
 * The run's usage: `run.json`'s once it closed, the sum of usage events while it is live. `null`
 * when the provider reported none (a closed run that wrote only zeros counts as none).
 */
export function runUsage(run: Run, events: readonly RunEventRecord[]): RunUsage | null {
  if (run.usage) {
    const u = run.usage;
    const parts = {
      ...(u.cache_read_tokens !== undefined ? { cacheRead: u.cache_read_tokens } : {}),
      ...(u.cache_write_tokens !== undefined ? { cacheWrite: u.cache_write_tokens } : {}),
      ...(u.reasoning_tokens !== undefined ? { reasoning: u.reasoning_tokens } : {}),
    };
    const reported =
      u.input_tokens > 0 ||
      u.output_tokens > 0 ||
      u.cost_usd !== null ||
      Object.keys(parts).length > 0;
    if (!reported && !events.some((e) => e.t === "usage" && typeof e.input_tokens === "number")) {
      return null;
    }
    return { input: u.input_tokens, output: u.output_tokens, cost: u.cost_usd, ...parts };
  }
  const sum: Required<Omit<RunUsage, "cost">> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  const known = new Set<keyof typeof sum>();
  let cost: number | null = null;
  const fields = [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cache_read_tokens", "cacheRead"],
    ["cache_write_tokens", "cacheWrite"],
    ["reasoning_tokens", "reasoning"],
  ] as const;
  for (const event of events) {
    if (event.t !== "usage") continue;
    for (const [from, to] of fields) {
      const value = event[from];
      if (typeof value === "number") {
        sum[to] += value;
        known.add(to);
      }
    }
    if (typeof event.cost_usd === "number") cost = (cost ?? 0) + event.cost_usd;
  }
  if (!known.has("input") && !known.has("output")) return null;
  return {
    input: sum.input,
    output: sum.output,
    cost,
    ...(known.has("cacheRead") ? { cacheRead: sum.cacheRead } : {}),
    ...(known.has("cacheWrite") ? { cacheWrite: sum.cacheWrite } : {}),
    ...(known.has("reasoning") ? { reasoning: sum.reasoning } : {}),
  };
}

/** A rate-limit window's name for people: "5 h", "7 días", "90 min"… (i18n keys). */
export function windowLabel(window: string): string {
  if (window === "five_hour") return t("limits.window.five_hour");
  if (window === "seven_day") return t("limits.window.seven_day");
  const scope = /^seven_day_([a-z0-9_]+)$/.exec(window)?.[1];
  if (scope) return t("limits.window.seven_day_scoped", { scope: scope.replace(/_/g, " ") });
  const minutes = /^window_(\d+)m$/.exec(window)?.[1];
  if (minutes) return t("limits.window.minutes", { n: minutes });
  return window;
}

/** 0.68 → "68 %". */
export function formatUtilization(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/** Seconds from start to finish (or to `now` while it runs); null before it started. */
export function runSeconds(run: Run, now: number): number | null {
  if (!run.started_at) return null;
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  return Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
}

export function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export const RUN_STATE_KEY: Record<Run["state"], MessageKey> = {
  queued: "run.state.queued",
  starting: "run.state.starting",
  running: "run.state.running",
  waiting_approval: "run.state.waiting_approval",
  checking: "run.state.checking",
  succeeded: "run.state.succeeded",
  failed: "run.state.failed",
  cancelled: "run.state.cancelled",
  interrupted: "run.state.interrupted",
};

/** Spanish text for an error the daemon returns when launching or cancelling. */
export function runErrorText(code: string, id: string, message: string): string {
  switch (code) {
    case "not_ready":
      return t("run.error.not_ready", { id });
    case "active_run":
      return t("run.error.active_run", { id });
    case "no_agent":
      return t("run.error.no_agent", { id });
    case "not_active":
      return t("run.error.not_active");
    case "not_discardable":
      return t("run.error.not_discardable", { message });
    case "no_slots":
      return t("variants.error.no_slots", { id });
    case "invalid_agent":
      return t("variants.error.invalid_agent", { id });
    case "variants_running":
      return t("variants.error.running", { id });
    case "not_choosable":
      return t("variants.error.not_choosable", { id });
    default:
      return t("run.error.other", { id, message });
  }
}

/**
 * The selected tasks Run would launch: the ready ones without an active run, in order. None while
 * the runs are still loading (an active run could not be ruled out).
 */
export function runnableSelection(
  ids: readonly string[],
  tasks: readonly { id: string; state: string; ready?: boolean }[],
  options: { readOnly: boolean; runs: readonly Run[] | undefined },
): string[] {
  if (options.runs === undefined) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return ids.filter((id) => {
    const task = byId.get(id);
    return task !== undefined && canRun(task, { ...options, id });
  });
}

/** Resume (and discarding instead) is offered on a run left `interrupted` by a stopped daemon. */
export function canResume(run: Run): boolean {
  return run.state === "interrupted";
}

/** Why resuming the run of task `id` failed, in Spanish and with what to do next. */
export function resumeErrorText(code: string, id: string, message: string): string {
  switch (code) {
    case "not_resumable":
      return t("run.resume.error.not_resumable", { id });
    case "no_adapter":
    case "wrong_provider":
      return t("run.resume.error.no_adapter", { id });
    case "not_found":
      return t("run.resume.error.not_found", { id });
    case "lock_timeout":
      return t("run.resume.error.busy", { id });
    default:
      return t("run.resume.error.other", { id, message });
  }
}

/** Discard is offered on a finished run whose work was neither integrated nor discarded. */
export function canDiscard(run: Run): boolean {
  const state = run.integration?.state;
  return !isActiveRunState(run.state) && state !== "merged" && state !== "discarded";
}

/** The last path segment, to show a worktree folder without the user's private path. */
export function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** The task's earlier runs that still hold a worktree and branch (all but the latest), newest first. */
export function olderDiscardable(
  runs: readonly Run[] | undefined,
  task: string,
  shown: string | undefined = latestRun(runs, task)?.id,
): Run[] {
  const mine = workRuns(runs, task).filter((run) => run.id !== shown);
  return mine.filter(canDiscard).reverse();
}
