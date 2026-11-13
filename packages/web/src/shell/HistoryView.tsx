import { completionLog, type LogEntry, type Task, type TasksDocument } from "@konsora/core";
import { useId, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button, Field, Panel, useToast } from "../ui/index.ts";
import {
  actorName,
  closers,
  filterLog,
  groupByDay,
  type HistoryFilter,
  historyMarkdown,
  summaryLine,
} from "./history-model.ts";
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
          {entry.archived && ` · ${t("history.archived")}`}
          {entry.unmet ? (
            <span className="b-history__flag b-history__flag--unmet">
              {t(entry.unmet === 1 ? "history.unmet.one" : "history.unmet.many", {
                n: entry.unmet,
              })}
            </span>
          ) : null}
          {entry.unproven ? (
            <span className="b-history__flag">
              {t(entry.unproven === 1 ? "history.unproven.one" : "history.unproven.many", {
                n: entry.unproven,
              })}
            </span>
          ) : null}
        </span>
        {entry.summary && <span className="b-history__summary">{summaryLine(entry.summary)}</span>}
      </span>
    </a>
  );
}

/** The History's filters (UI-17): who closed it, group and text. */
function HistoryFilters({
  filter,
  actors,
  groups,
  onChange,
}: {
  filter: HistoryFilter;
  actors: readonly string[];
  groups: readonly { id: string; name: string }[];
  onChange: (filter: HistoryFilter) => void;
}) {
  const byId = useId();
  const groupId = useId();
  return (
    <div className="b-history__filters">
      <Field
        label={t("history.filter.text")}
        placeholder={t("history.filter.text.placeholder")}
        value={filter.text ?? ""}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
      />
      <div className="k-field">
        <label htmlFor={byId} className="k-field__label">
          {t("history.filter.by")}
        </label>
        <select
          id={byId}
          className="k-field__control"
          value={filter.by ?? ""}
          onChange={(e) => onChange({ ...filter, by: e.target.value })}
        >
          <option value="">{t("history.filter.anyone")}</option>
          {actors.map((actor) => (
            <option key={actor} value={actor}>
              {actorName(actor)}
            </option>
          ))}
        </select>
      </div>
      <div className="k-field">
        <label htmlFor={groupId} className="k-field__label">
          {t("history.filter.group")}
        </label>
        <select
          id={groupId}
          className="k-field__control"
          value={filter.group ?? ""}
          onChange={(e) => onChange({ ...filter, group: e.target.value })}
        >
          <option value="">{t("history.filter.allGroups")}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.id} · {group.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * The History view (UI-04): done tasks, newest first, by local day, each day with its count. It
 * can be filtered and copied as Markdown (UI-17). Each links to its panel in this view.
 */
export function HistoryView({
  projectId,
  doc,
  archive = [],
  archiveError,
  openId,
  now,
}: {
  projectId: string;
  doc: TasksDocument;
  /** The tasks of `.konsora/archive.json` (CORE-18), listed too and marked as archived. */
  archive?: readonly Task[] | undefined;
  archiveError?: string | undefined;
  openId: string | null;
  /** For tests: the instant "today" and "yesterday" are relative to. */
  now?: Date;
}) {
  const [filter, setFilter] = useState<HistoryFilter>({});
  const toast = useToast();
  const log = useMemo(() => completionLog(doc, archive), [doc, archive]);
  const actors = useMemo(() => closers(log), [log]);
  const shown = useMemo(() => filterLog(log, filter), [log, filter]);
  const days = useMemo(() => groupByDay(shown, now ? { now } : {}), [shown, now]);
  const filtering = Boolean(filter.by || filter.group || filter.text?.trim());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(historyMarkdown(days));
      toast.show(t("history.copy.done", { n: shown.length }), "success");
    } catch {
      toast.show(t("history.copy.error"), "error");
    }
  };
  return (
    <Panel title={t("history.title")}>
      <p className="s-text s-muted">{t("history.text")}</p>
      {archiveError && (
        <p className="s-text" role="alert">
          {t("history.archive_error", { message: archiveError })}
        </p>
      )}
      {log.length > 0 && (
        <div className="b-history__bar">
          <HistoryFilters
            filter={filter}
            actors={actors}
            groups={doc.groups}
            onChange={setFilter}
          />
          <div className="a-actions">
            {filtering && (
              <Button size="sm" variant="ghost" onClick={() => setFilter({})}>
                {t("filter.clear")}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={shown.length === 0}
              onClick={() => void copy()}
            >
              {t("history.copy")}
            </Button>
          </div>
        </div>
      )}
      {log.length === 0 ? (
        <p className="s-text">{t("history.empty")}</p>
      ) : days.length === 0 ? (
        <p className="s-text s-muted">{t("history.filter.none")}</p>
      ) : (
        <div className="b-history">
          {days.map((day) => (
            <section key={day.key} className="b-history__day" aria-label={day.label}>
              <h3 className="b-history__date k-label">
                {day.label}
                <span className="b-history__count">
                  {t(day.entries.length === 1 ? "history.count.one" : "history.count.many", {
                    n: day.entries.length,
                  })}
                </span>
              </h3>
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
