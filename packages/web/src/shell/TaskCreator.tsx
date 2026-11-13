import type { TasksDocument } from "@konsora/core";
import { type FormEvent, useId, useState } from "react";
import { useProjectOp } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, useToast } from "../ui/index.ts";
import { opErrorText } from "./board-model.ts";
import { type CreateDraft, type CreateField, createOp, emptyDraft } from "./create-model.ts";
import { Criteria, DifficultySelect, GroupSelect } from "./TaskEditor.tsx";

/**
 * Side panel to create a task as the human: approved work in "Por hacer" by default, or a
 * proposal. One `propose` op; the new task opens once the daemon confirms it.
 */
export function TaskCreator({
  projectId,
  doc,
  onCreated,
  onClose,
}: {
  projectId: string;
  doc: TasksDocument;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CreateDraft>(() => emptyDraft(doc.groups[0]?.id ?? ""));
  const [error, setError] = useState<{ field?: CreateField; text: string } | null>(null);
  const mutation = useProjectOp(projectId);
  const toast = useToast();
  const templateId = useId();
  const templates = doc.project.templates ?? [];
  const set = <K extends keyof CreateDraft>(key: K, value: CreateDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };
  const fieldError = (field: CreateField) => (error?.field === field ? error.text : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = createOp(draft, {
      groups: doc.groups,
      tasks: doc.tasks,
      templates,
    });
    if (!result.ok) {
      setError({ field: result.field, text: result.message });
      return;
    }
    mutation.mutate(result.op, {
      onSuccess: (response) => {
        const id = (response as { created?: string[] }).created?.[0];
        toast.show(t("create.done", { id: id ?? "" }), "success");
        if (id) onCreated(id);
        else onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.unauthorized) return;
        const code = err instanceof ApiError ? err.code : "error";
        setError({ text: opErrorText(code, draft.title.trim(), err.message) });
      },
    });
  };

  return (
    <aside className="a-detail b-panel" aria-label={t("create.title")}>
      <div className="a-detail__head">
        <div className="a-detail__chips">
          <h2 className="a-detail__title">{t("create.title")}</h2>
          <Button size="sm" variant="ghost" className="a-detail__close" onClick={onClose}>
            ✕<span className="k-visually-hidden">{t("create.close")}</span>
          </Button>
        </div>
      </div>
      <form className="a-detail__body a-stack b-edit" onSubmit={submit} noValidate>
        <Field
          label={t("edit.field.title")}
          value={draft.title}
          maxLength={120}
          required
          error={fieldError("title")}
          onChange={(e) => set("title", e.target.value)}
        />
        <GroupSelect
          groups={doc.groups}
          value={draft.group}
          error={fieldError("group")}
          onChange={(value) => set("group", value)}
        />
        {templates.length > 0 && (
          <div className="k-field">
            <label htmlFor={templateId} className="k-field__label">
              {t("create.template")}
            </label>
            <select
              id={templateId}
              className="k-field__control"
              value={draft.template}
              aria-invalid={fieldError("template") ? true : undefined}
              onChange={(e) => set("template", e.target.value)}
            >
              <option value="">{t("create.template.none")}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            {fieldError("template") && (
              <span className="k-field__error">{fieldError("template")}</span>
            )}
          </div>
        )}
        <Field
          multiline
          rows={6}
          label={t("edit.field.desc")}
          hint={t("edit.field.desc.hint")}
          value={draft.desc}
          error={fieldError("desc")}
          onChange={(e) => set("desc", e.target.value)}
        />
        <Criteria
          rows={draft.acceptance}
          error={fieldError("acceptance")}
          onChange={(rows) => set("acceptance", rows)}
          onRow={(index, row) =>
            set(
              "acceptance",
              draft.acceptance.map((r, i) => (i === index ? { ...r, ...row } : r)),
            )
          }
        />
        <Field
          label={t("edit.field.labels")}
          hint={t("edit.field.labels.hint")}
          value={draft.labels}
          onChange={(e) => set("labels", e.target.value)}
        />
        <DifficultySelect value={draft.difficulty} onChange={(value) => set("difficulty", value)} />
        <Field
          mono
          label={t("create.deps")}
          hint={t("create.deps.hint")}
          value={draft.deps}
          error={fieldError("deps")}
          onChange={(e) => set("deps", e.target.value)}
        />
        <label className="b-create__check">
          <input
            type="checkbox"
            checked={draft.state === "proposed"}
            onChange={(e) => set("state", e.target.checked ? "proposed" : "todo")}
          />{" "}
          {t("create.asProposal")}
        </label>
        {error && !error.field && (
          <p className="k-field__error" role="alert">
            {error.text}
          </p>
        )}
        <div className="a-actions">
          <Button type="submit" variant="primary" busy={mutation.isPending}>
            {t("create.submit")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("edit.cancel")}
          </Button>
        </div>
      </form>
    </aside>
  );
}
