import { completionLog, type LogEntry, type TasksDocument } from "@konsora/core";
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { actorName, groupByDay, summaryLine } from "./history-model.ts";
import { projectHref } from "./route.ts";

function Entry({
  projectId,
  entry,
  time,
  open,
}: {
  projectId: string;
  entry: LogEntry;
  time: string;
  open: boolean;
}) {
  return (
    <a
      className={open ? "b-history__entry b-history__entry--open" : "b-history__entry"}
      href={projectHref(projectId, { view: "history", task: entry.id })}
      aria-current={open ? "true" : undefined}
    >
      <span className="b-history__time k-mono">{time}</span>
      <span className="b-history__body">
        <span className="b-history__head">
          <span className="b-history__id k-mono">{entry.id}</span>
          <span className="b-history__title">{entry.title}</span>
        </span>
        <span className="b-history__meta">
          {entry.by ? t("history.by", { who: actorName(entry.by) }) : t("history.no_summary")}
        </span>
        {entry.summary && <span className="b-history__summary">{summaryLine(entry.summary)}</span>}
      </span>
    </a>
  );
}

/**
 * The History view (UI-04): done tasks, newest first, by local day. Each links to its panel in
 * this view.
 */
export function HistoryView({
  projectId,
  doc,
  openId,
  now,
}: {
  projectId: string;
  doc: TasksDocument;
  openId: string | null;
  /** For tests: the instant "today" and "yesterday" are relative to. */
  now?: Date;
}) {
  const days = useMemo(() => groupByDay(completionLog(doc), now ? { now } : {}), [doc, now]);
  return (
    <Panel title={t("history.title")}>
      <p className="s-text s-muted">{t("history.text")}</p>
      {days.length === 0 ? (
        <p className="s-text">{t("history.empty")}</p>
      ) : (
        <div className="b-history">
          {days.map((day) => (
            <section key={day.key} className="b-history__day" aria-label={day.label}>
              <h3 className="b-history__date k-label">{day.label}</h3>
              <ol className="b-history__list">
                {day.entries.map(({ entry, time }) => (
                  <li key={entry.id}>
                    <Entry
                      projectId={projectId}
                      entry={entry}
                      time={time}
                      open={entry.id === openId}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
