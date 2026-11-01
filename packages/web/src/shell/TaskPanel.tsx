import { ACTION_TEXT, availableActions, type TaskAction, type TasksDocument } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { type BoardTask, type ExternalFlag, useTaskAction } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Field, StateBadge, useToast } from "../ui/index.ts";
import { opErrorText } from "./board-model.ts";
import { ExternalChanges } from "./External.tsx";
import { Markdown } from "./Markdown.tsx";

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
}: {
  projectId: string;
  task: BoardTask;
  actions: TaskAction[];
}) {
  const mutation = useTaskAction(projectId);
  const toast = useToast();
  // Answering is always shown as a form: an open question is what needs the human.
  const [open, setOpen] = useState<TaskAction | null>(actions.includes("answer") ? "answer" : null);
  const [text, setText] = useState("");
  const run = (action: TaskAction, value?: string) =>
    mutation.mutate(
      { task, action, ...(value ? { text: value } : {}) },
      {
        onSuccess: () => {
          toast.show(t(DONE[action], { id: task.id }), "success");
          setOpen(null);
          setText("");
        },
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          toast.show(opErrorText(code, task.id, error.message), "error");
        },
      },
    );
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
}) {
  const actions = readOnly ? [] : availableActions(doc, task.id);
  const index = new Map(doc.tasks.map((x) => [x.id, x]));
  return (
    <aside className="a-detail b-panel" aria-label={t("detail.label", { id: task.id })}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <span className="a-chip k-mono">{task.id}</span>
          <span className="a-chip k-mono">{groupName}</span>
          <StateBadge kind={task.state} />
          {task.state === "todo" && task.blocked && <StateBadge kind="blocked" />}
          {task.waiting && <StateBadge kind="waiting" />}
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
          />
        )}
        {onSelectWithDeps && (
          <div className="a-actions">
            <Button size="sm" variant="secondary" onClick={onSelectWithDeps}>
              {t("selection.withDeps")}
            </Button>
          </div>
        )}
        {task.desc && <Markdown className="a-desc" text={task.desc} />}
        {(task.acceptance ?? []).length > 0 && (
          <table className="a-criteria">
            <caption className="k-label">{t("detail.criteria")}</caption>
            <tbody>
              {(task.acceptance ?? []).map((ac) => (
                <tr key={ac.id}>
                  <td className="k-mono a-criteria__id">{ac.id}</td>
                  <td>
                    {ac.text}
                    {ac.check && <div className="k-mono a-criteria__check">{ac.check}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(task.deps ?? []).length > 0 && (
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
