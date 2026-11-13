import { activityStats, type DayClosures, type Task, type TasksDocument } from "@konsora/core";
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { actorName } from "./history-model.ts";

/** Weeks the view looks back (UI-18). */
export const STATS_WEEKS = 4;

/** Categorical slots for whoever closed tasks; the rest fold into «Otros». */
export const SERIES_SLOTS = 7;
export const OTHER = "*other";

/** «45 min», «3 h 20 min», «2 d 4 h». */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t("stats.duration.minutes", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("stats.duration.hours", { h: hours, m: minutes % 60 });
  return t("stats.duration.days", { d: Math.floor(hours / 24), h: hours % 24 });
}

/**
 * The series of the chart: actors in alphabetical order, so a person keeps their color when the
 * counts change; past SERIES_SLOTS, the rest fold into «Otros».
 */
export function chartSeries(actors: readonly string[]): string[] {
  const sorted = [...actors].sort();
  return sorted.length <= SERIES_SLOTS ? sorted : [...sorted.slice(0, SERIES_SLOTS - 1), OTHER];
}

/** A day's closures per series, in series order (folded actors add up in «Otros»). */
export function daySegments(day: DayClosures, series: readonly string[]): number[] {
  const named = new Set(series.filter((s) => s !== OTHER));
  return series.map((s) =>
    s === OTHER
      ? Object.entries(day.byActor)
          .filter(([actor]) => !named.has(actor))
          .reduce((sum, [, n]) => sum + n, 0)
      : (day.byActor[s] ?? 0),
  );
}

const seriesName = (s: string) => (s === OTHER ? t("stats.other") : actorName(s));
const seriesColor = (index: number, s: string) =>
  s === OTHER ? "var(--b-series-other)" : `var(--b-series-${index + 1})`;

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="b-stat">
      <div className="k-label">{label}</div>
      <div className="b-stat__value">{value}</div>
      <div className="b-stat__hint">{hint}</div>
    </div>
  );
}

const shortDay = (day: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );

/**
 * How the plan moves (UI-18): closures per day over the last weeks stacked by who closed them,
 * the average time in progress and the tasks reopened. Computed by core from the live plan, so it
 * follows the board. A table repeats the chart for screen readers and for colors hard to tell apart.
 */
export function ActivityView({
  doc,
  archive = [],
  now,
}: {
  doc: TasksDocument;
  archive?: readonly Task[] | undefined;
  /** For tests: the instant the window ends at. */
  now?: Date;
}) {
  const days = STATS_WEEKS * 7;
  const stats = useMemo(
    () => activityStats(doc, archive, { ...(now ? { now } : {}), days }),
    [doc, archive, now, days],
  );
  const series = chartSeries(stats.actors);
  const max = Math.max(1, ...stats.days.map((d) => d.total));
  return (
    <Panel title={t("stats.title")}>
      <div className="b-stats">
        <p className="s-text s-muted">{t("stats.text", { days: STATS_WEEKS })}</p>
        <div className="b-stats__tiles">
          <Stat
            label={t("stats.closures")}
            value={String(stats.closures)}
            hint={t("stats.closures.hint", { days })}
          />
          <Stat
            label={t("stats.cycle")}
            value={stats.cycle ? durationText(stats.cycle.averageMs) : t("stats.cycle.none")}
            hint={
              stats.cycle
                ? t(stats.cycle.samples === 1 ? "stats.cycle.hint.one" : "stats.cycle.hint.many", {
                    n: stats.cycle.samples,
                  })
                : t("stats.cycle.none.hint")
            }
          />
          <Stat
            label={t("stats.reopened")}
            value={String(stats.reopened)}
            hint={t("stats.reopened.hint", { days })}
          />
        </div>
        <section className="b-stats__chart" aria-label={t("stats.chart")}>
          <h3 className="k-label">{t("stats.chart")}</h3>
          {stats.closures === 0 ? (
            <p className="s-text s-muted">{t("stats.empty")}</p>
          ) : (
            <>
              {series.length === 1 && (
                <p className="b-stats__single">
                  {t("stats.single", { who: seriesName(series[0] as string) })}
                </p>
              )}
              {series.length > 1 && (
                <ul className="b-stats__legend" aria-label={t("stats.legend")}>
                  {series.map((s, i) => (
                    <li key={s}>
                      <span
                        className="b-stats__swatch"
                        style={{ background: seriesColor(i, s) }}
                        aria-hidden="true"
                      />
                      {seriesName(s)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="b-stats__plot">
                <div className="b-stats__axis" aria-hidden="true">
                  <span>{max}</span>
                  <span>0</span>
                </div>
                <ol
                  className="b-stats__bars"
                  aria-label={t("stats.chart.label", { days: STATS_WEEKS })}
                >
                  {stats.days.map((day, index) => {
                    const segments = daySegments(day, series);
                    const top = segments.findLastIndex((n) => n > 0);
                    const label = t("stats.day", { day: shortDay(day.day), n: day.total });
                    return (
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: each bar is focusable to show its tooltip from the keyboard.
                      <li key={day.day} className="b-stats__day" tabIndex={0} aria-label={label}>
                        <div
                          className="b-stats__stack"
                          style={{ height: `${(day.total / max) * 100}%` }}
                        >
                          {segments.map((n, i) =>
                            n > 0 ? (
                              <span
                                key={series[i]}
                                className={
                                  i === top ? "b-stats__seg b-stats__seg--top" : "b-stats__seg"
                                }
                                style={{
                                  flexGrow: n,
                                  background: seriesColor(i, series[i] as string),
                                }}
                              />
                            ) : null,
                          )}
                        </div>
                        {(index % 7 === 0 || index === stats.days.length - 1) && (
                          <span className="b-stats__tick" aria-hidden="true">
                            {shortDay(day.day)}
                          </span>
                        )}
                        <div className="b-stats__tip" role="tooltip">
                          <b>{label}</b>
                          {series.map((s, i) =>
                            segments[i] ? (
                              <span key={s}>
                                <span
                                  className="b-stats__swatch"
                                  style={{ background: seriesColor(i, s) }}
                                  aria-hidden="true"
                                />
                                {seriesName(s)}: {segments[i]}
                              </span>
                            ) : null,
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <details className="b-stats__table">
                <summary className="b-stats__summary">{t("stats.table")}</summary>
                <table className="a-criteria">
                  <thead>
                    <tr>
                      <th className="b-stats__th">{t("stats.table.day")}</th>
                      {series.map((s) => (
                        <th key={s} className="b-stats__th">
                          {seriesName(s)}
                        </th>
                      ))}
                      <th className="b-stats__th">{t("stats.table.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.days
                      .filter((day) => day.total > 0)
                      .map((day) => (
                        <tr key={day.day}>
                          <td className="k-mono">{day.day}</td>
                          {daySegments(day, series).map((n, i) => (
                            <td key={series[i]}>{n}</td>
                          ))}
                          <td>{day.total}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
        </section>
      </div>
    </Panel>
  );
}
