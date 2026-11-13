import {
  type ActivityEntry,
  completionLog,
  type LogEntry,
  planActivity,
  type Task,
  type TasksDocument,
} from "@konsora/core";
import { useId, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button, Field, Panel, Segmented, useToast } from "../ui/index.ts";
import {
  activityActors,
  activityMarkdown,
  activityText,
  actorName,
  closers,
  filterActivity,
  filterLog,
  groupByDay,
  type HistoryFilter,
  type HistoryMode,
  historyMarkdown,
  readHistoryMode,
  summaryLine,
  writeHistoryMode,
} from "./history-model.ts";
import { projectHref } from "./route.ts";

/** One change of the plan (UI-16): links to its task, unless the task was deleted. */
function ActivityRow({
  projectId,
  entry,
  time,
  open,
}: {
  projectId: string;
  entry: ActivityEntry;
  time: string;
  open: boolean;
}) {
  const body = (
    <>
      <span className="b-history__time k-mono">{time}</span>
      <span className="b-history__body">
        <span className="b-history__head">
          <span className="b-history__id k-mono">{entry.task}</span>
          <span className="b-history__title">{entry.title}</span>
        </span>
        <span className="b-history__meta">
          <span className={`b-activity__type b-activity__type--${entry.type}`}>
            {activityText(entry)}
          </span>
          {" · "}
          {actorName(entry.by)}
          {entry.archived && ` · ${t("history.archived")}`}
        </span>
      </span>
    </>
  );
  if (entry.deleted) return <div className="b-history__entry b-history__entry--gone">{body}</div>;
  return (
    <a
      className={open ? "b-history__entry b-history__entry--open" : "b-history__entry"}
      href={projectHref(projectId, { view: "history", task: entry.task })}
      aria-current={open ? "true" : undefined}
    >
      {body}
    </a>
  );
}

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
          {entry.commits?.length ? (
            <span className="b-history__commits k-mono">
              {entry.commits.map((sha) => sha.slice(0, 7)).join(" ")}
            </span>
          ) : null}
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
  all = false,
}: {
  filter: HistoryFilter;
  actors: readonly string[];
  groups: readonly { id: string; name: string }[];
  onChange: (filter: HistoryFilter) => void;
  /** Every change (UI-16): the filters speak of whoever did it, not of closing. */
  all?: boolean;
}) {
  const byId = useId();
  const groupId = useId();
  return (
    <div className="b-history__filters">
      <Field
        label={t("history.filter.text")}
        placeholder={t(
          all ? "activity.filter.text.placeholder" : "history.filter.text.placeholder",
        )}
        value={filter.text ?? ""}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
      />
      <div className="k-field">
        <label htmlFor={byId} className="k-field__label">
          {t(all ? "activity.filter.by" : "history.filter.by")}
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
  initialMode,
}: {
  projectId: string;
  doc: TasksDocument;
  /** The tasks of `.konsora/archive.json` (CORE-18), listed too and marked as archived. */
  archive?: readonly Task[] | undefined;
  archiveError?: string | undefined;
  openId: string | null;
  /** For tests: the instant "today" and "yesterday" are relative to. */
  now?: Date;
  /** The mode to start in, instead of the one remembered in this browser. */
  initialMode?: HistoryMode;
}) {
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [mode, setMode] = useState<HistoryMode>(() => initialMode ?? readHistoryMode());
  const all = mode === "all";
  const toast = useToast();
  const log = useMemo(() => completionLog(doc, archive), [doc, archive]);
  const activity = useMemo(() => planActivity(doc, archive), [doc, archive]);
  // A change's group: its task's, or for a deleted task the prefix of its id.
  const groupOf = useMemo(() => {
    const groups = new Map([...archive, ...doc.tasks].map((task) => [task.id, task.group]));
    return (entry: ActivityEntry) =>
      groups.get(entry.task) ?? entry.task.slice(0, entry.task.lastIndexOf("-"));
  }, [doc, archive]);
  const actors = useMemo(
    () => (all ? activityActors(activity) : closers(log)),
    [all, activity, log],
  );
  const shown = useMemo(() => filterLog(log, filter), [log, filter]);
  const changes = useMemo(
    () => filterActivity(activity, filter, groupOf),
    [activity, filter, groupOf],
  );
  const days = useMemo(() => groupByDay(shown, now ? { now } : {}), [shown, now]);
  const changeDays = useMemo(() => groupByDay(changes, now ? { now } : {}), [changes, now]);
  const filtering = Boolean(filter.by || filter.group || filter.text?.trim());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        all ? activityMarkdown(changeDays) : historyMarkdown(days),
      );
      toast.show(
        t(all ? "activity.copy.done" : "history.copy.done", {
          n: all ? changes.length : shown.length,
        }),
        "success",
      );
    } catch {
      toast.show(t("history.copy.error"), "error");
    }
  };
  const total = all ? activity.length : log.length;
  const count = all ? changes.length : shown.length;
  return (
    <Panel title={t("history.title")}>
      <div className="b-history__intro">
        <p className="s-text s-muted">{t(all ? "activity.text" : "history.text")}</p>
        <Segmented
          label={t("history.mode")}
          value={mode}
          onChange={(value) => {
            const next = value === "done" ? "done" : "all";
            setMode(next);
            writeHistoryMode(next);
          }}
          options={[
            { value: "all", label: t("history.mode.all") },
            { value: "done", label: t("history.mode.done") },
          ]}
        />
      </div>
      {archiveError && (
        <p className="s-text" role="alert">
          {t("history.archive_error", { message: archiveError })}
        </p>
      )}
      {total > 0 && (
        <div className="b-history__bar">
          <HistoryFilters
            filter={filter}
            actors={actors}
            groups={doc.groups}
            onChange={setFilter}
            all={all}
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
              disabled={count === 0}
              onClick={() => void copy()}
            >
              {t("history.copy")}
            </Button>
          </div>
        </div>
      )}
      {total === 0 ? (
        <p className="s-text">{t(all ? "activity.empty" : "history.empty")}</p>
      ) : count === 0 ? (
        <p className="s-text s-muted">{t(all ? "activity.filter.none" : "history.filter.none")}</p>
      ) : all ? (
        <div className="b-history">
          {changeDays.map((day) => (
            <section key={day.key} className="b-history__day" aria-label={day.label}>
              <h3 className="b-history__date k-label">
                {day.label}
                <span className="b-history__count">
                  {t(day.entries.length === 1 ? "activity.count.one" : "activity.count.many", {
                    n: day.entries.length,
                  })}
                </span>
              </h3>
              <ol className="b-history__list">
                {day.entries.map(({ entry, time }, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two changes of a task can share type and second; the list is rebuilt, never reordered in place.
                  <li key={`${entry.task}:${entry.type}:${entry.at}:${index}`}>
                    <ActivityRow
                      projectId={projectId}
                      entry={entry}
                      time={time}
                      open={entry.task === openId && !entry.deleted}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
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
