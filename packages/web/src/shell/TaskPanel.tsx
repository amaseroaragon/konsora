import {
  ACTION_TEXT,
  availableActions,
  dependentsOf,
  type TaskAction,
  type TasksDocument,
} from "@konsora/core";
import { type FormEvent, useState } from "react";
import { type BoardTask, type ExternalFlag, useTaskAction } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { askConfirm, Button, Field, StateBadge, useToast } from "../ui/index.ts";
import { confirmDelete, opErrorText } from "./board-model.ts";
import { ExternalChanges } from "./External.tsx";
import { Markdown } from "./Markdown.tsx";
import { PanelSection } from "./PanelSection.tsx";
import { DependencyEditor, TaskEditor } from "./TaskEditor.tsx";

const LABEL: Record<TaskAction, MessageKey> = {
  promote: "action.promote",
  demote: "action.demote",
  answer: "action.answer",
  reopen: "action.reopen",
  delete: "action.delete",
};
const TEXT_LABEL: Partial<Record<TaskAction, MessageKey>> = {
  answer: "action.text.answer",
  reopen: "action.text.reopen",
};
const DONE: Record<TaskAction, MessageKey> = {
  promote: "move.done.promote",
  demote: "move.done.demote",
  answer: "move.done.answer",
  reopen: "move.done.reopen",
  delete: "move.done.delete",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

/** The buttons for the human actions core allows on this task; text-taking ones open a form. */
function Actions({
  projectId,
  task,
  actions,
  dependents,
}: {
  projectId: string;
  task: BoardTask;
  actions: TaskAction[];
  /** Tasks that depend on this one: deleting it asks first, naming them. */
  dependents: readonly string[];
}) {
  const mutation = useTaskAction(projectId);
  const toast = useToast();
  // Answering is always shown as a form: an open question is what needs the human.
  const [open, setOpen] = useState<TaskAction | null>(actions.includes("answer") ? "answer" : null);
  const [text, setText] = useState("");
  const run = async (action: TaskAction, value?: string) => {
    if (action === "delete" && !(await confirmDelete([task.id], dependents, askConfirm))) return;
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
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!open) return;
    if (ACTION_TEXT[open] === "required" && !text.trim()) return;
    void run(open, text.trim());
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
            variant={
              action === "delete"
                ? "danger"
                : index === 0 && action !== "demote"
                  ? "primary"
                  : "secondary"
            }
            busy={busy(action)}
            onClick={() => void run(action)}
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

/**
 * Side panel for one task: what it is, its history, and what you can do with it now. Read top to
 * bottom by priority: closing summary, actions, then description, criteria, dependencies and notes,
 * which fold (UI-09).
 */
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
}) {
  // Editing is the human's, and never on an invalid (read-only) plan.
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly;
  const actions = readOnly ? [] : availableActions(doc, task.id);
  const index = new Map(doc.tasks.map((x) => [x.id, x]));
  const criteria = task.acceptance ?? [];
  const deps = task.deps ?? [];
  const notes = task.notes ?? [];
  // Once done, the agent's closing summary is what the human reads first.
  const summary =
    task.state === "done"
      ? [...(task.notes ?? [])].reverse().find((note) => note.kind === "summary")
      : undefined;
  return (
    <aside className="a-detail b-panel" aria-label={t("detail.label", { id: task.id })}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <span className="a-chip k-mono">{task.id}</span>
          <span className="a-chip k-mono">{groupName}</span>
          <StateBadge kind={task.state} />
          {task.state === "todo" && task.blocked && <StateBadge kind="blocked" />}
          {task.waiting && <StateBadge kind="waiting" />}
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
        {summary && (
          <section className="a-callout a-stack b-summary" aria-label={t("detail.summary")}>
            <div className="k-label">
              {t("detail.summary")} ·{" "}
              {summary.by === "human" ? t("detail.you") : summary.by.replace(/^agent:/, "")}
            </div>
            <Markdown className="md--compact" text={summary.text} />
          </section>
        )}
        {/* Keyed by task and its hash so a changed task resets any half-written form. */}
        {actions.length > 0 && (
          <Actions
            key={`${task.id}:${task.hash}`}
            projectId={projectId}
            task={task}
            actions={actions}
            dependents={dependentsOf(task.id, doc)}
          />
        )}
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
            onClose={() => setEditing(false)}
          />
        ) : (
          <>
            {task.desc && (
              <PanelSection section="desc" title={t("detail.desc")}>
                <Markdown className="a-desc" text={task.desc} />
              </PanelSection>
            )}
            {criteria.length > 0 && (
              <PanelSection section="criteria" title={t("detail.criteria")} count={criteria.length}>
                <table className="a-criteria">
                  <tbody>
                    {criteria.map((ac) => (
                      <tr key={ac.id}>
                        <td className="k-mono a-criteria__id">{ac.id}</td>
                        <td>{ac.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </PanelSection>
            )}
          </>
        )}
        {(deps.length > 0 || (editing && canEdit)) && (
          <PanelSection
            section="deps"
            title={t("detail.deps")}
            count={deps.length}
            foldable={!(editing && canEdit)}
          >
            <ul className="a-deps">
              {deps.map((id) => {
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
          </PanelSection>
        )}
        {notes.length > 0 && (
          <PanelSection section="notes" title={t("detail.notes")} count={notes.length}>
            <ol className="a-notes">
              {notes.map((note) => (
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
          </PanelSection>
        )}
      </div>
    </aside>
  );
}
