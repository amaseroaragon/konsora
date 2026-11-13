/**
 * How the plan moves (UI-18): closures per day and per agent over the last weeks, the average time
 * a task spends between starting and finishing, and how many tasks were reopened. Derived from the
 * plan's activity (CORE-17), nothing stored, no estimates or targets.
 */
import { planActivity } from "./history.ts";
import type { Task, TasksDocument } from "./schema.ts";

export type DayClosures = {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  total: number;
  /** Closures per actor (`agent:<name>`, `human`…). */
  byActor: Record<string, number>;
};

export type ActivityStats = {
  /** One entry per day of the window, oldest first, today last. */
  days: DayClosures[];
  /** Who closed tasks in the window, most closures first (ties by name). */
  actors: string[];
  /** Closures in the window. */
  closures: number;
  /**
   * Average time from a task's start to its finish, over the closures of the window whose start is
   * known; null when there is none.
   */
  cycle: { averageMs: number; samples: number } | null;
  /** Distinct tasks reopened in the window. */
  reopened: number;
};

export type StatsOptions = {
  now?: Date;
  /** Days in the window, today included (default 28). */
  days?: number;
  /** Time zone of the days (the runtime's by default). */
  timeZone?: string;
};

function dayKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The `count` calendar days that end today, oldest first, as `YYYY-MM-DD`. */
function windowDays(now: Date, count: number, timeZone?: string): string[] {
  const today = new Date(`${dayKey(now, timeZone)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(today.getTime() - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

export function activityStats(
  doc: Pick<TasksDocument, "tasks" | "deleted">,
  archived: readonly Task[] = [],
  { now = new Date(), days = 28, timeZone }: StatsOptions = {},
): ActivityStats {
  const keys = windowDays(now, days, timeZone);
  const inWindow = new Set(keys);
  const byDay = new Map<string, DayClosures>(
    keys.map((day) => [day, { day, total: 0, byActor: {} }]),
  );
  const totals = new Map<string, number>();
  const reopened = new Set<string>();
  // Oldest first, so each finish meets the start that came before it.
  const activity = planActivity(doc, archived).reverse();
  const lastStart = new Map<string, number>();
  let cycleSum = 0;
  let samples = 0;
  for (const entry of activity) {
    const day = dayKey(new Date(entry.at), timeZone);
    if (entry.type === "start") lastStart.set(entry.task, Date.parse(entry.at));
    if (entry.type === "pause" || entry.type === "reopen") lastStart.delete(entry.task);
    if (!inWindow.has(day)) continue;
    if (entry.type === "reopen") reopened.add(entry.task);
    if (entry.type !== "finish") continue;
    const cell = byDay.get(day) as DayClosures;
    cell.total += 1;
    cell.byActor[entry.by] = (cell.byActor[entry.by] ?? 0) + 1;
    totals.set(entry.by, (totals.get(entry.by) ?? 0) + 1);
    const start = lastStart.get(entry.task);
    if (start !== undefined) {
      cycleSum += Date.parse(entry.at) - start;
      samples += 1;
      lastStart.delete(entry.task);
    }
  }
  return {
    days: keys.map((day) => byDay.get(day) as DayClosures),
    actors: [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([a]) => a),
    closures: [...totals.values()].reduce((sum, n) => sum + n, 0),
    cycle: samples > 0 ? { averageMs: cycleSum / samples, samples } : null,
    reopened: reopened.size,
  };
}
