import {
  ACTION_TEXT,
  availableActions,
  criteriaEvidence,
  dependentsOf,
  recommendedModel,
  startedBy,
  type Task,
  type TaskAction,
  type TasksDocument,
} from "@konsora/core";
import { type FormEvent, useState } from "react";
import { type BoardTask, type ExternalFlag, useAddNote, useTaskAction } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import {
  askConfirm,
  Button,
  DifficultyMark,
  Field,
  Labels,
  StateBadge,
  useToast,
} from "../ui/index.ts";
import { choiceAnswer, confirmDelete, opErrorText } from "./board-model.ts";
import { ExternalChanges } from "./External.tsx";
import { Markdown } from "./Markdown.tsx";
import { PanelSection } from "./PanelSection.tsx";
import { canRefine } from "./refine.ts";
import { DependencyEditor, TaskEditor } from "./TaskEditor.tsx";
import { useUndoOffer } from "./undo.ts";

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
export function Actions({
  projectId,
  task,
  actions,
  dependents,
  onDone,
}: {
  projectId: string;
  task: BoardTask;
  actions: TaskAction[];
  /** Tasks that depend on this one: deleting it asks first, naming them. */
  dependents: readonly string[];
  /** Called once an action succeeded. */
  onDone?: (action: TaskAction) => void;
}) {
  const mutation = useTaskAction(projectId);
  const toast = useToast();
  const offer = useUndoOffer(projectId);
  // Answering is always shown as a form: an open question is what needs the human.
  const [open, setOpen] = useState<TaskAction | null>(actions.includes("answer") ? "answer" : null);
  const [text, setText] = useState("");
  const run = async (action: TaskAction, value?: string) => {
    if (action === "delete" && !(await confirmDelete([task.id], dependents, askConfirm))) return;
    mutation.mutate(
      { task, action, ...(value ? { text: value } : {}) },
      {
        onSuccess: (reply) => {
          offer(t(DONE[action], { id: task.id }), reply.undo);
          setOpen(null);
          setText("");
          onDone?.(action);
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
  // A question with options is answered with one click; the text adds a comment (or another answer).
  const choices = open === "answer" ? (question?.options ?? []) : [];
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
        {choices.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a group of answer buttons, not form fields.
          <div className="a-actions" role="group" aria-label={t("answer.options")}>
            {choices.map((option) => (
              <Button
                key={option}
                variant="secondary"
                disabled={mutation.isPending}
                onClick={() => void run("answer", choiceAnswer(option, text))}
              >
                {option}
              </Button>
            ))}
          </div>
        )}
        <Field
          multiline
          rows={choices.length > 0 ? 2 : 4}
          label={
            choices.length > 0 ? t("answer.comment") : t(TEXT_LABEL[open] ?? "action.text.reopen")
          }
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

/** The human's note for the agent (UI-12): it lands in the timeline and `konsora show`. */
function NoteForm({ projectId, taskId }: { projectId: string; taskId: string }) {
  const mutation = useAddNote(projectId);
  const toast = useToast();
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    mutation.mutate(
      { task: taskId, text },
      {
        onSuccess: () => {
          toast.show(t("note.add.done", { id: taskId }), "success");
          setText("");
        },
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          toast.show(opErrorText(code, taskId, error.message), "error");
        },
      },
    );
  };
  return (
    <form className="a-stack b-note-form" onSubmit={submit}>
      <Field
        multiline
        rows={2}
        label={t("note.add.label")}
        hint={t("note.add.hint")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="a-actions">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          busy={mutation.isPending}
          disabled={!text.trim()}
        >
          {t("note.add")}
        </Button>
      </div>
    </form>
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
  onRefine,
  groups = [],
  archived = false,
  archive = [],
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
  /** «Afinar con IA» (UI-20): only offered for tasks nobody started, outside read-only. */
  onRefine?: (() => void) | undefined;
  /** The plan's groups, for moving the task while editing it. */
  groups?: readonly { id: string; name: string }[];
  /** The task is archived (CORE-18): shown as it was closed, never changed. */
  archived?: boolean;
  /** The archived tasks, to name the dependencies that were archived. */
  archive?: readonly Task[] | undefined;
}) {
  // Editing is the human's, and never on an invalid (read-only) plan.
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly;
  const actions = readOnly ? [] : availableActions(doc, task.id);
  const index = new Map([...archive, ...doc.tasks].map((x) => [x.id, x]));
  const criteria = task.acceptance ?? [];
  // CORE-23: the human's hint for this difficulty; nothing when there is none.
  const model = recommendedModel(doc.project, task);
  // A done task shows, per criterion, what its closing summary says (CORE-15).
  const checks =
    task.state === "done" ? new Map(criteriaEvidence(task).map((c) => [c.id, c])) : null;
  const deps = task.deps ?? [];
  const notes = task.notes ?? [];
  const started = task.state === "doing" ? startedBy(task) : undefined;
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
          {archived && <span className="a-chip">{t("detail.archived")}</span>}
          {task.difficulty && <DifficultyMark difficulty={task.difficulty} text />}
          {model && <span className="a-chip b-model">{t("model.recommended", { model })}</span>}
          {task.milestone && (
            <span className="a-chip" title={t("milestone.chip.title")}>
              {t("milestone.chip", {
                name: doc.milestones?.find((m) => m.id === task.milestone)?.name ?? task.milestone,
              })}
            </span>
          )}
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
        <Labels labels={task.labels} className="a-detail__labels" />
        {started && (
          <p className="s-text s-muted a-detail__started">
            {t("detail.started", {
              actor: started.by === "human" ? t("detail.you") : started.by.replace(/^agent:/, ""),
              when: when(started.at),
            })}
          </p>
        )}
      </div>
      <div className="a-detail__body a-stack">
        {archived && <p className="s-text s-muted">{t("detail.archived.text")}</p>}
        <ExternalChanges
          projectId={projectId}
          flags={external}
          tasks={doc.tasks}
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
        {onRefine && canRefine(task, readOnly) && (
          <div className="a-actions">
            <Button size="sm" variant="secondary" onClick={onRefine}>
              {t("refine.open")}
            </Button>
          </div>
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
            milestones={doc.milestones ?? []}
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
                    {criteria.map((ac) => {
                      const check = checks?.get(ac.id);
                      return (
                        <tr key={ac.id}>
                          <td className="k-mono a-criteria__id">{ac.id}</td>
                          <td>
                            {ac.text}
                            {check && (
                              <div className={`a-evidence a-evidence--${check.status}`}>
                                <b>{t(`evidence.${check.status}`)}</b>
                                {check.evidence && (
                                  <Markdown className="md--compact" text={check.evidence} />
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
                    {note.options && (
                      <ul className="a-note__options" aria-label={t("answer.options")}>
                        {note.options.map((option) => (
                          <li key={option} className="a-chip">
                            {option}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </PanelSection>
        )}
        {!readOnly && <NoteForm key={task.id} projectId={projectId} taskId={task.id} />}
      </div>
    </aside>
  );
}
