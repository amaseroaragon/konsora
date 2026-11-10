import {
  ACTION_TEXT,
  type AgentSpec,
  availableActions,
  type Run,
  type TaskAction,
  type TasksDocument,
  taskCost,
} from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useAgents } from "../api/agents.ts";
import { type BoardTask, type ExternalFlag, useTaskAction } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { useStartRun } from "../api/runs.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, StateBadge, useToast } from "../ui/index.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { agentProblem, agentReason, difficultyText, taskAgent } from "./agent-model.ts";
import { opErrorText } from "./board-model.ts";
import { CostSummaryView } from "./CostSummary.tsx";
import { checkOutcome, confirmAccept, criterionResults, runChecksFailed } from "./checks-model.ts";
import { ExternalChanges } from "./External.tsx";
import { Markdown } from "./Markdown.tsx";
import { OlderRuns } from "./OlderRuns.tsx";
import { ReviewSection } from "./ReviewSection.tsx";
import { RunSection } from "./RunSection.tsx";
import { type AcceptResult, acceptText, integrationErrorText } from "./review-model.ts";
import { canRun, latestRun, olderDiscardable, reviewRun, runErrorText } from "./run-model.ts";
import { DependencyEditor, TaskEditor } from "./TaskEditor.tsx";

const LABEL: Record<TaskAction, MessageKey> = {
  approve: "action.approve",
  answer: "action.answer",
  accept: "action.accept",
  "send-back": "action.send-back",
  reopen: "action.reopen",
};
const TEXT_LABEL: Partial<Record<TaskAction, MessageKey>> = {
  answer: "action.text.answer",
  "send-back": "action.text.send-back",
  reopen: "action.text.reopen",
};
const DONE: Record<TaskAction, MessageKey> = {
  approve: "move.done.approve",
  answer: "move.done.answer",
  accept: "move.done.accept",
  "send-back": "move.done.send-back",
  reopen: "move.done.reopen",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

/** The buttons for the human actions core allows on this task; text-taking ones open a form. */
function Actions({
  projectId,
  task,
  actions,
  checksFailed = false,
}: {
  projectId: string;
  task: BoardTask;
  actions: TaskAction[];
  /** The latest run's checks are red: accepting asks first. */
  checksFailed?: boolean;
}) {
  const mutation = useTaskAction(projectId);
  const toast = useToast();
  // Answering is always shown as a form: an open question is what needs the human.
  const [open, setOpen] = useState<TaskAction | null>(actions.includes("answer") ? "answer" : null);
  const [text, setText] = useState("");
  /** Why the last accept could not integrate the run's work (the task stays in review). */
  const [problem, setProblem] = useState<string | null>(null);
  const run = (action: TaskAction, value?: string) => {
    if (
      action === "accept" &&
      !confirmAccept(task.id, checksFailed, (question) => window.confirm(question))
    ) {
      return;
    }
    mutation.mutate(
      { task, action, ...(value ? { text: value } : {}) },
      {
        onSuccess: (result) => {
          toast.show(
            action === "accept"
              ? acceptText(task.id, result as AcceptResult)
              : t(DONE[action], { id: task.id }),
            "success",
          );
          setProblem(null);
          setOpen(null);
          setText("");
        },
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          const files = error instanceof ApiError ? (error.details.files ?? []) : [];
          const integration = integrationErrorText(code, task.id, files);
          if (integration) setProblem(integration);
          toast.show(integration ?? opErrorText(code, task.id, error.message), "error");
        },
      },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!open) return;
    if (ACTION_TEXT[open] === "required" && !text.trim()) return;
    run(open, text.trim());
  };
  const question = [...(task.notes ?? [])].reverse().find((n) => n.kind === "question");
  const busy = (action: TaskAction) => mutation.isPending && mutation.variables?.action === action;
  if (open) {
    return (
      <form
        className={`a-callout a-stack ${open === "answer" ? "a-callout--warn" : ""}`}
        onSubmit={submit}
      >
        {open === "answer" && question && (
          <p className="a-callout__text">
            <b>{t("detail.question")}</b> {question.text}
          </p>
        )}
        <Field
          multiline
          rows={4}
          label={t(TEXT_LABEL[open] ?? "action.text.reopen")}
          required={ACTION_TEXT[open] === "required"}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="a-actions">
          <Button
            type="submit"
            variant="primary"
            busy={busy(open)}
            disabled={ACTION_TEXT[open] === "required" && !text.trim()}
          >
            {t(LABEL[open])}
          </Button>
          {open !== "answer" && (
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("feedback.cancel")}
            </Button>
          )}
        </div>
      </form>
    );
  }
  return (
    <>
      {problem && (
        <p className="a-callout a-callout--warn" role="alert">
          {problem}
        </p>
      )}
      <div className="a-actions">
        {actions.map((action, index) =>
          ACTION_TEXT[action] === "none" ? (
            <Button
              key={action}
              variant={index === 0 ? "primary" : "secondary"}
              busy={busy(action)}
              onClick={() => run(action)}
            >
              {t(LABEL[action])}
            </Button>
          ) : (
            <Button
              key={action}
              variant={index === 0 ? "primary" : "secondary"}
              onClick={() => setOpen(action)}
            >
              {t(LABEL[action])}
            </Button>
          ),
        )}
      </div>
    </>
  );
}

/** Launches a run of a ready task (Claude, default profile, until the selector of M7). */
function RunButton({
  projectId,
  task,
  doc,
}: {
  projectId: string;
  task: BoardTask;
  doc: TasksDocument;
}) {
  const start = useStartRun(projectId);
  const toast = useToast();
  const agents = useAgents();
  const catalog = agents.data;
  const [chosen, setChosen] = useState<AgentSpec | undefined>(undefined);
  const resolved = catalog ? taskAgent(task, doc.project, catalog) : undefined;
  const agent = chosen ?? resolved?.agent;
  const problem = agentProblem(agent, catalog);
  return (
    <div className="a-stack">
      {catalog ? (
        <>
          <AgentPicker agent={agent} catalog={catalog} onChange={setChosen} />
          {!chosen && resolved && <p className="s-muted">{agentReason(resolved)}</p>}
        </>
      ) : (
        <p className="s-muted">{agents.isError ? t("agent.unavailable") : t("agent.loading")}</p>
      )}
      <div className="a-actions">
        <Button
          variant="primary"
          busy={start.isPending}
          disabled={problem !== null}
          title={t("run.run.hint", { id: task.id })}
          onClick={() =>
            start.mutate(
              // Without the catalog, the daemon uses the task's agent or the project's.
              { task: task.id, agent: catalog ? agent : undefined },
              {
                onSuccess: () => toast.show(t("run.started", { id: task.id }), "success"),
                onError: (error) => {
                  if (error instanceof ApiError && error.unauthorized) return;
                  const code = error instanceof ApiError ? error.code : "error";
                  toast.show(runErrorText(code, task.id, error.message), "error");
                },
              },
            )
          }
        >
          {t("run.run")} →
        </Button>
      </div>
    </div>
  );
}

/** Side panel for one task: what it is, its history, and what you can do with it now. */
export function TaskPanel({
  projectId,
  task,
  doc,
  groupName,
  external,
  readOnly,
  onClose,
  onOpen,
  onSelectWithDeps,
  groups = [],
  runs,
}: {
  projectId: string;
  task: BoardTask;
  doc: TasksDocument;
  groupName: string;
  external: readonly ExternalFlag[];
  readOnly: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Selects this task with its pending dependencies (UI-07); only offered where it applies. */
  onSelectWithDeps?: (() => void) | undefined;
  /** The plan's groups, for moving the task while editing it. */
  groups?: readonly { id: string; name: string }[];
  /** The project's runs (undefined while loading). */
  runs?: readonly Run[] | undefined;
}) {
  // Editing is the human's, and never on an invalid (read-only) plan.
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly;
  const actions = readOnly ? [] : availableActions(doc, task.id);
  const index = new Map(doc.tasks.map((x) => [x.id, x]));
  const run = task.state === "review" ? reviewRun(runs, task.id) : latestRun(runs, task.id);
  const criteria = criterionResults(run);
  const checksFailed = task.state === "review" && runChecksFailed(run);
  const runnable = runs !== undefined && canRun(task, { readOnly, runs, id: task.id });
  return (
    <aside className="a-detail b-panel" aria-label={t("detail.label", { id: task.id })}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <span className="a-chip k-mono">{task.id}</span>
          <span className="a-chip k-mono">{groupName}</span>
          <StateBadge kind={task.state} />
          {task.state === "todo" && task.blocked && <StateBadge kind="blocked" />}
          {task.waiting && <StateBadge kind="waiting" />}
          {task.difficulty && <span className="a-chip">{difficultyText(task.difficulty)}</span>}
          {canEdit && !editing && (
            <Button
              size="sm"
              variant="secondary"
              className="a-detail__edit"
              onClick={() => setEditing(true)}
            >
              {t("edit.open")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="a-detail__close" onClick={onClose}>
            ✕<span className="k-visually-hidden">{t("detail.close")}</span>
          </Button>
        </div>
        <h2 className="a-detail__title">{task.title}</h2>
      </div>
      <div className="a-detail__body a-stack">
        <ExternalChanges
          projectId={projectId}
          flags={external}
          readOnly={readOnly}
          showTask={false}
        />
        {/* Keyed by task and its hash so a changed task resets any half-written form. */}
        {actions.length > 0 && (
          <Actions
            key={`${task.id}:${task.hash}`}
            projectId={projectId}
            task={task}
            actions={actions}
            checksFailed={checksFailed}
          />
        )}
        {runnable && <RunButton projectId={projectId} task={task} doc={doc} />}
        {run && (
          <RunSection projectId={projectId} run={run} readOnly={readOnly}>
            {task.state === "review" && run.state === "succeeded" && (
              <ReviewSection
                projectId={projectId}
                run={run}
                readOnly={readOnly}
                notes={task.notes}
                hasReviewer={doc.project.reviewer !== undefined}
                summary={
                  [...(task.notes ?? [])]
                    .reverse()
                    .find((n) => n.kind === "summary" && n.run === run.id)?.text ?? run.summary
                }
              />
            )}
          </RunSection>
        )}
        {runs?.some((r) => r.task === task.id) && (
          <section className="a-stack" aria-label={t("cost.title")}>
            <div className="k-label">{t("cost.title")}</div>
            <CostSummaryView summary={taskCost(runs, task.id)} />
          </section>
        )}
        <OlderRuns
          projectId={projectId}
          runs={olderDiscardable(runs, task.id, run?.id)}
          readOnly={readOnly}
        />
        {onSelectWithDeps && (
          <div className="a-actions">
            <Button size="sm" variant="secondary" onClick={onSelectWithDeps}>
              {t("selection.withDeps")}
            </Button>
          </div>
        )}
        {editing && canEdit ? (
          <TaskEditor
            projectId={projectId}
            task={task}
            groups={groups}
            defaults={doc.project.defaults}
            onClose={() => setEditing(false)}
          />
        ) : (
          <>
            {task.desc && <Markdown className="a-desc" text={task.desc} />}
            {(task.acceptance ?? []).length > 0 && (
              <table className="a-criteria">
                <caption className="k-label">{t("detail.criteria")}</caption>
                <tbody>
                  {(task.acceptance ?? []).map((ac) => {
                    const result = ac.check ? criteria.get(ac.id) : undefined;
                    const ok = result ? result.exit_code === 0 && result.timed_out !== true : null;
                    return (
                      <tr key={ac.id}>
                        <td className="k-mono a-criteria__id">{ac.id}</td>
                        <td>
                          {ac.text}
                          {ac.check && <div className="k-mono a-criteria__check">{ac.check}</div>}
                          {ac.check && (
                            <div
                              className={`a-criteria__result ${
                                ok === null ? "s-muted" : ok ? "b-checks__ok" : "b-checks__fail"
                              }`}
                            >
                              {result
                                ? `${ok ? "✓" : "✕"} ${t("checks.criterion.last", {
                                    outcome: checkOutcome(result),
                                  })}`
                                : t("checks.criterion.none")}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        {((task.deps ?? []).length > 0 || (editing && canEdit)) && (
          <div>
            <div className="k-label">{t("detail.deps")}</div>
            <ul className="a-deps">
              {(task.deps ?? []).map((id) => {
                const dep = index.get(id);
                return (
                  <li key={id}>
                    <button type="button" className="a-link" onClick={() => onOpen(id)}>
                      {id}
                    </button>{" "}
                    {dep?.title}
                    {dep && <StateBadge kind={dep.state} />}
                  </li>
                );
              })}
            </ul>
            {editing && canEdit && <DependencyEditor projectId={projectId} task={task} doc={doc} />}
          </div>
        )}
        {(task.notes ?? []).length > 0 && (
          <div>
            <div className="k-label">{t("detail.notes")}</div>
            <ol className="a-notes">
              {(task.notes ?? []).map((note) => (
                <li key={note.id} className={`a-note a-note--${note.kind}`}>
                  <span className="k-mono a-note__at">{when(note.at)}</span>
                  <div className="a-note__body">
                    <b className="a-note__by">
                      {note.by === "human" ? t("detail.you") : note.by.replace(/^agent:/, "")} ·{" "}
                      {t(`note.${note.kind}`)}
                    </b>
                    <Markdown className="md--compact" text={note.text} />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </aside>
  );
}
