import { type Dispatch, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button, DiffView, Field, RunLog, StateBadge, Tabs, useToast } from "../ui/index.ts";
import {
  activeRun,
  agentLabel,
  blockers,
  byId,
  formatDuration,
  formatTokens,
  isWaiting,
  latestRun,
  type Note,
  type Run,
  type Task,
} from "./model.ts";
import { runStateLabel } from "./RunsView.tsx";
import type { Action, AppState, DetailTab } from "./state.ts";

/** Renders `inline code` spans; full markdown arrives with the real detail view (M4). */
function codeSpans(text: string) {
  return text.split("`").map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string.
    i % 2 === 1 ? <code key={i}>{part}</code> : part,
  );
}

const now = () => new Date().toISOString();
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

export function DetailPanel({
  state,
  dispatch,
  clock,
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  clock: number;
}) {
  const index = byId(state.project.tasks);
  const task = state.open ? index.get(state.open) : undefined;
  if (!task) return null;
  const group = state.project.groups.find((g) => g.id === task.group);
  const run = activeRun(task, state.project.runs) ?? latestRun(task, state.project.runs);
  const blockedBy = blockers(task, index);
  const tabs = [
    {
      id: "detail",
      label: t("detail.tab.detail"),
      content: <DetailTabContent task={task} dispatch={dispatch} index={index} />,
    },
    ...(run
      ? [
          {
            id: "run",
            label: t("detail.tab.run"),
            content: <RunTab run={run} dispatch={dispatch} clock={clock} />,
          },
        ]
      : []),
    ...(task.state === "review" && run
      ? [
          {
            id: "review",
            label: t("detail.tab.review"),
            content: <ReviewTab task={task} run={run} dispatch={dispatch} />,
          },
        ]
      : []),
  ];
  const selected = tabs.some((tab) => tab.id === state.tab) ? state.tab : "detail";

  return (
    <aside className="a-detail" aria-label={t("detail.label", { id: task.id })}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <span className="a-chip k-mono">{task.id}</span>
          <span className="a-chip k-mono">{group?.name ?? task.group}</span>
          <StateBadge kind={blockedBy.length ? "blocked" : task.state} />
          {isWaiting(task) && <StateBadge kind="waiting" />}
          <Button
            size="sm"
            variant="ghost"
            className="a-detail__close"
            onClick={() => dispatch({ type: "open", id: null })}
          >
            ✕<span className="k-visually-hidden">{t("detail.close")}</span>
          </Button>
        </div>
        <h1 className="a-detail__title">{task.title}</h1>
        {run && (
          <p className="a-detail__meta k-mono">
            {run.id} · {agentLabel(run.agent)} · {runStateLabel(run.state)}
            {run.tokens
              ? ` · ${formatTokens(run.tokens.input)}↑ ${formatTokens(run.tokens.output)}↓`
              : ""}
          </p>
        )}
      </div>
      <div className="a-detail__body">
        <Tabs
          label={t("detail.sections")}
          tabs={tabs}
          selected={selected}
          onSelect={(tab) => dispatch({ type: "tab", tab: tab as DetailTab })}
        />
      </div>
    </aside>
  );
}

function DetailTabContent({
  task,
  dispatch,
  index,
}: {
  task: Task;
  dispatch: Dispatch<Action>;
  index: Map<string, Task>;
}) {
  return (
    <div className="a-stack">
      {task.state === "proposed" && <ProposalActions task={task} dispatch={dispatch} />}
      {isWaiting(task) && <AnswerBox task={task} dispatch={dispatch} />}
      {task.desc && <p className="a-desc">{codeSpans(task.desc)}</p>}
      {task.acceptance.length > 0 && (
        <table className="a-criteria">
          <caption className="k-label">{t("detail.criteria")}</caption>
          <tbody>
            {task.acceptance.map((ac) => (
              <tr key={ac.id}>
                <td className="k-mono a-criteria__id">{ac.id}</td>
                <td>
                  {ac.text}
                  {ac.check && <div className="k-mono a-criteria__check">{ac.check}</div>}
                </td>
                <td
                  className={`k-mono a-criteria__result a-criteria__result--${ac.result ?? "none"}`}
                >
                  {ac.result === "pass"
                    ? t("detail.pass")
                    : ac.result === "fail"
                      ? t("detail.fail")
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {task.deps.length > 0 && (
        <div>
          <div className="k-label">{t("detail.deps")}</div>
          <ul className="a-deps">
            {task.deps.map((id) => {
              const dep = index.get(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="a-link"
                    onClick={() => dispatch({ type: "open", id })}
                  >
                    {id}
                  </button>{" "}
                  {dep?.title}
                  {dep && <StateBadge kind={dep.state} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {task.notes.length > 0 && <Notes notes={task.notes} />}
    </div>
  );
}

function Notes({ notes }: { notes: readonly Note[] }) {
  return (
    <div>
      <div className="k-label">{t("detail.notes")}</div>
      <ol className="a-notes">
        {notes.map((n) => (
          <li key={n.id} className={`a-note a-note--${n.kind}`}>
            <span className="k-mono a-note__at">{time(n.at)}</span>
            <span>
              <b className="a-note__by">
                {n.by === "human" ? t("detail.you") : n.by.replace("agent:", "")} ·{" "}
                {t(`note.${n.kind}`)}
              </b>{" "}
              {n.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProposalActions({ task, dispatch }: { task: Task; dispatch: Dispatch<Action> }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <div className="a-callout">
      <p className="a-callout__text">
        {t("detail.proposal.text", { actor: task.createdBy.replace("agent:", "") })}
      </p>
      {asking ? (
        <form
          className="a-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return setError(t("detail.feedback.required"));
            dispatch({ type: "requestChanges", id: task.id, text, at: now() });
            toast.show(t("app.toast.changes", { id: task.id }), "info");
            setAsking(false);
            setText("");
          }}
        >
          <Field
            label={t("detail.proposal.changes")}
            multiline
            value={text}
            error={error}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="a-actions">
            <Button type="submit" variant="primary">
              {t("detail.send")}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t("detail.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="a-actions">
          <Button
            variant="primary"
            onClick={() => {
              dispatch({ type: "approve", id: task.id });
              toast.show(t("app.toast.approved", { id: task.id }), "success");
            }}
          >
            {t("detail.approve")}
          </Button>
          <Button onClick={() => setAsking(true)}>{t("detail.proposal.ask")}</Button>
        </div>
      )}
    </div>
  );
}

function AnswerBox({ task, dispatch }: { task: Task; dispatch: Dispatch<Action> }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const question = [...task.notes].reverse().find((n) => n.kind === "question");
  return (
    <form
      className="a-callout a-callout--warn a-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return setError(t("detail.feedback.required"));
        dispatch({ type: "answer", id: task.id, text, at: now() });
        toast.show(t("app.toast.answered", { id: task.id }), "success");
        setText("");
      }}
    >
      <p className="a-callout__text">
        <b>{t("detail.question")}</b> {question?.text}
      </p>
      <Field
        label={t("detail.answer")}
        multiline
        value={text}
        error={error}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="a-actions">
        <Button type="submit" variant="primary">
          {t("detail.send")}
        </Button>
      </div>
    </form>
  );
}

function RunTab({ run, dispatch, clock }: { run: Run; dispatch: Dispatch<Action>; clock: number }) {
  const toast = useToast();
  const live = run.state === "running";
  const duration = live ? (clock - Date.parse(run.startedAt)) / 1000 : (run.durationS ?? 0);
  return (
    <div className="a-stack">
      <dl className="a-stats">
        <div>
          <dt className="k-label">{t("run.duration")}</dt>
          <dd className="k-mono">{formatDuration(duration)}</dd>
        </div>
        <div>
          <dt className="k-label">{t("run.state")}</dt>
          <dd>{runStateLabel(run.state)}</dd>
        </div>
        <div>
          <dt className="k-label">{t("run.tokens")}</dt>
          <dd className="k-mono">
            {run.tokens
              ? `${formatTokens(run.tokens.input)} / ${formatTokens(run.tokens.output)}`
              : "—"}
          </dd>
        </div>
      </dl>
      <RunLog events={run.events} live={live} />
      {live && (
        <div className="a-actions">
          <Button
            variant="danger"
            onClick={() => {
              dispatch({ type: "cancelRun", id: run.id });
              toast.show(t("app.toast.cancelled", { id: run.task }), "info");
            }}
          >
            {t("run.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ReviewTab({ task, run, dispatch }: { task: Task; run: Run; dispatch: Dispatch<Action> }) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const added = run.diff.reduce((n, f) => n + f.added, 0);
  const removed = run.diff.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="a-stack">
      <ul className="a-checks">
        {run.checks.map((c) => (
          <li key={c.id} className={c.ok ? "a-check a-check--ok" : "a-check a-check--fail"}>
            <span aria-hidden="true">■</span> {c.id}
            <span className="k-visually-hidden">{c.ok ? t("detail.pass") : t("detail.fail")}</span>
          </li>
        ))}
      </ul>
      <p className="k-mono a-diffstat">
        {t("review.files", { n: run.diff.length })} · +{added} −{removed}
      </p>
      <DiffView files={run.diff} />
      {run.summary && (
        <div className="a-summary">
          <div className="k-label">{t("review.summary")}</div>
          <p>{run.summary}</p>
        </div>
      )}
      {sending ? (
        <form
          className="a-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return setError(t("detail.feedback.required"));
            dispatch({ type: "sendBack", id: task.id, text, at: now() });
            toast.show(t("app.toast.sentBack", { id: task.id }), "info");
          }}
        >
          <Field
            label={t("review.feedback")}
            multiline
            value={text}
            error={error}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="a-actions">
            <Button type="submit" variant="primary">
              {t("review.sendBack")}
            </Button>
            <Button variant="ghost" onClick={() => setSending(false)}>
              {t("detail.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="a-actions a-actions--joined">
          <Button
            variant="primary"
            className="a-grow"
            onClick={() => {
              dispatch({ type: "accept", id: task.id });
              toast.show(t("app.toast.accepted", { id: task.id }), "success");
            }}
          >
            {t("review.accept")}
          </Button>
          <Button onClick={() => setSending(true)}>{t("review.sendBack")}…</Button>
          <Button onClick={() => toast.show(t("app.toast.retry"), "info")}>
            {t("review.retry")}…
          </Button>
        </div>
      )}
    </div>
  );
}
