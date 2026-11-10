import { DifficultySchema, type Template } from "@konsora/core";
import { type FormEvent, useRef, useState } from "react";
import { useSetChecks } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, Panel, useToast } from "../ui/index.ts";
import type { FieldErrors } from "./settings-model.ts";
import {
  type DraftCriterion,
  type DraftTemplate,
  moveRow,
  TEMPLATE_LIMITS,
  templatesFrom,
  templatesOp,
  templatesServerErrors,
} from "./templates-model.ts";

function TemplateRow({
  row,
  index,
  count,
  errors,
  disabled,
  onChange,
  onMove,
  onRemove,
  newKey,
}: {
  row: DraftTemplate;
  index: number;
  count: number;
  errors: FieldErrors;
  disabled: boolean;
  onChange: (row: Partial<DraftTemplate>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  newKey: () => string;
}) {
  // Labels go by position, so they do not change while the name is typed.
  const n = index + 1;
  const at = `templates.${index}`;
  const setCriterion = (j: number, next: Partial<DraftCriterion>) =>
    onChange({ criteria: row.criteria.map((c, k) => (k === j ? { ...c, ...next } : c)) });
  return (
    <li className="b-settings__template">
      <div className="b-settings__template-head">
        <span className="k-label">{t("templates.item", { n })}</span>
        <div className="b-settings__row-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            ↑<span className="k-visually-hidden">{t("templates.up", { n })}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓<span className="k-visually-hidden">{t("templates.down", { n })}</span>
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
            ✕<span className="k-visually-hidden">{t("templates.remove", { n })}</span>
          </Button>
        </div>
      </div>
      <div className="b-settings__template-fields">
        <Field
          mono
          label={t("templates.id", { n })}
          value={row.id}
          maxLength={31}
          disabled={disabled}
          error={errors[`${at}.id`]}
          onChange={(e) => onChange({ id: e.target.value })}
        />
        <Field
          label={t("templates.name", { n })}
          value={row.name}
          maxLength={TEMPLATE_LIMITS.name}
          disabled={disabled}
          error={errors[`${at}.name`]}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <label className="k-field">
          <span className="k-field__label">{t("templates.difficulty", { n })}</span>
          <select
            className="k-field__control"
            value={row.difficulty}
            disabled={disabled}
            aria-invalid={errors[`${at}.difficulty`] ? true : undefined}
            onChange={(e) =>
              onChange({ difficulty: e.target.value as DraftTemplate["difficulty"] })
            }
          >
            <option value="">{t("difficulty.none")}</option>
            {DifficultySchema.options.map((d) => (
              <option key={d} value={d}>
                {t(`difficulty.${d}`)}
              </option>
            ))}
          </select>
          {errors[`${at}.difficulty`] && (
            <span className="k-field__error">{errors[`${at}.difficulty`]}</span>
          )}
        </label>
        <Field
          mono
          label={t("templates.labels", { n })}
          hint={t("templates.labels.hint")}
          value={row.labels}
          disabled={disabled}
          error={errors[`${at}.labels`]}
          onChange={(e) => onChange({ labels: e.target.value })}
        />
      </div>
      <Field
        multiline
        rows={4}
        label={t("templates.desc", { n })}
        value={row.desc}
        maxLength={TEMPLATE_LIMITS.desc}
        disabled={disabled}
        error={errors[`${at}.desc`]}
        onChange={(e) => onChange({ desc: e.target.value })}
      />
      <div className="a-stack">
        <div className="k-label">{t("templates.criteria")}</div>
        {row.criteria.length > 0 && (
          <ol className="b-settings__checks">
            {row.criteria.map((criterion, j) => {
              const m = j + 1;
              return (
                <li key={criterion.key} className="b-settings__criterion">
                  <Field
                    label={t("templates.criterion.text", { m, n })}
                    value={criterion.text}
                    maxLength={TEMPLATE_LIMITS.text}
                    disabled={disabled}
                    error={errors[`${at}.criteria.${j}.text`]}
                    onChange={(e) => setCriterion(j, { text: e.target.value })}
                  />
                  <Field
                    mono
                    label={t("templates.criterion.check", { m })}
                    value={criterion.check}
                    maxLength={TEMPLATE_LIMITS.check}
                    disabled={disabled}
                    error={errors[`${at}.criteria.${j}.check`]}
                    onChange={(e) => setCriterion(j, { check: e.target.value })}
                  />
                  <div className="b-settings__row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => onChange({ criteria: row.criteria.filter((_, k) => k !== j) })}
                    >
                      ✕
                      <span className="k-visually-hidden">
                        {t("templates.criterion.remove", { m, n })}
                      </span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {errors[`${at}.criteria`] && (
          <p className="k-field__error" role="alert">
            {errors[`${at}.criteria`]}
          </p>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              onChange({ criteria: [...row.criteria, { key: newKey(), text: "", check: "" }] })
            }
          >
            {t("templates.criterion.add")}
          </Button>
        </div>
      </div>
      {errors[at] && (
        <p className="k-field__error" role="alert">
          {errors[at]}
        </p>
      )}
    </li>
  );
}

/**
 * The project's task templates (UI-22): create, edit, reorder and remove them. Saving sends one
 * `set-templates` op with the whole list, validated first with core's rules.
 */
export function TemplateSettings({
  projectId,
  templates,
  readOnly,
}: {
  projectId: string;
  templates: readonly Template[] | undefined;
  readOnly: boolean;
}) {
  const [base, setBase] = useState(templates);
  const [draft, setDraft] = useState<DraftTemplate[]>(() => templatesFrom(templates));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useSetChecks(projectId);
  const rowCount = useRef(0);
  const newKey = () => {
    rowCount.current += 1;
    return `new-${rowCount.current}`;
  };
  const toast = useToast();
  // Someone else changed the templates and this form has no edits: show theirs.
  const pristine = JSON.stringify(draft) === JSON.stringify(templatesFrom(base));
  if (JSON.stringify(templates) !== JSON.stringify(base) && (pristine || saved)) {
    setBase(templates);
    setDraft(templatesFrom(templates));
    setSaved(false);
  }

  const set = (next: DraftTemplate[]) => {
    setDraft(next);
    setErrors({});
    setFormError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = templatesOp(draft, base);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (!result.op) {
      toast.show(t("settings.unchanged"), "info");
      return;
    }
    save.mutate(result.op, {
      onSuccess: () => {
        toast.show(t("templates.saved"), "success");
        setSaved(true);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.unauthorized) return;
        const placed =
          error instanceof ApiError
            ? templatesServerErrors({
                code: error.code,
                message: error.message,
                issues: error.details.issues as
                  | { path: string; code: string; message: string }[]
                  | undefined,
              })
            : { fields: {}, form: t("templates.error.other", { message: String(error) }) };
        setErrors(placed.fields);
        setFormError(placed.form);
      },
    });
  };

  const disabled = readOnly || save.isPending;
  return (
    <form className="b-settings" onSubmit={submit} noValidate>
      <Panel title={t("templates.title")} eyebrow={t("settings.eyebrow")}>
        <p className="s-text s-muted">{t("templates.text")}</p>
        {draft.length === 0 ? (
          <p className="s-text s-muted">{t("templates.none")}</p>
        ) : (
          <ol className="b-settings__checks">
            {draft.map((row, index) => (
              <TemplateRow
                key={row.key}
                row={row}
                index={index}
                count={draft.length}
                errors={errors}
                disabled={disabled}
                newKey={newKey}
                onChange={(next) => set(draft.map((r, i) => (i === index ? { ...r, ...next } : r)))}
                onMove={(by) => set(moveRow(draft, index, by))}
                onRemove={() => set(draft.filter((_, i) => i !== index))}
              />
            ))}
          </ol>
        )}
        {errors.templates && (
          <p className="k-field__error" role="alert">
            {errors.templates}
          </p>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              set([
                ...draft,
                {
                  key: newKey(),
                  id: "",
                  name: "",
                  desc: "",
                  criteria: [],
                  labels: "",
                  difficulty: "",
                },
              ])
            }
          >
            {t("templates.add")}
          </Button>
        </div>
      </Panel>
      {formError && (
        <p className="a-callout a-callout--warn" role="alert">
          {formError}
        </p>
      )}
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={readOnly}>
          {t("templates.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || pristine}
          onClick={() => {
            setDraft(templatesFrom(base));
            setErrors({});
            setFormError(null);
          }}
        >
          {t("settings.discard")}
        </Button>
      </div>
    </form>
  );
}
