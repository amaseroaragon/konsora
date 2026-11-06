import type { Project } from "@konsora/core";
import { type FormEvent, useRef, useState } from "react";
import { useSetChecks } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, Panel, useToast } from "../ui/index.ts";
import {
  type DraftCheck,
  defaults,
  type FieldErrors,
  moveCheck,
  type SettingsDraft,
  serverErrors,
  settingsFrom,
  settingsOp,
} from "./settings-model.ts";

type Settings = Pick<Project, "checks" | "check_retries" | "setup">;

function CheckRow({
  row,
  index,
  count,
  errors,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  row: DraftCheck;
  index: number;
  count: number;
  errors: FieldErrors;
  disabled: boolean;
  onChange: (row: Partial<DraftCheck>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  // Labels go by position, so they do not change while the id is typed.
  const n = index + 1;
  return (
    <li className="b-settings__check">
      <Field
        mono
        label={t("settings.check.id", { n })}
        value={row.id}
        maxLength={31}
        disabled={disabled}
        error={errors[`checks.${index}.id`]}
        onChange={(e) => onChange({ id: e.target.value })}
      />
      <Field
        mono
        label={t("settings.check.run", { n })}
        value={row.run}
        maxLength={1000}
        disabled={disabled}
        error={errors[`checks.${index}.run`]}
        onChange={(e) => onChange({ run: e.target.value })}
      />
      <Field
        label={t("settings.check.timeout", { n })}
        hint={t("settings.timeout.hint", { s: defaults.timeout })}
        inputMode="numeric"
        value={row.timeout}
        disabled={disabled}
        error={errors[`checks.${index}.timeout`]}
        onChange={(e) => onChange({ timeout: e.target.value })}
      />
      <div className="b-settings__row-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
        >
          ↑<span className="k-visually-hidden">{t("settings.check.up", { n })}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || index === count - 1}
          onClick={() => onMove(1)}
        >
          ↓<span className="k-visually-hidden">{t("settings.check.down", { n })}</span>
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
          ✕<span className="k-visually-hidden">{t("settings.check.remove", { n })}</span>
        </Button>
      </div>
    </li>
  );
}

/**
 * The project's settings (UI-17): its checks (id, command, timeout, in order), how many times a
 * run retries them, and the setup command of new worktrees. Saving sends one `set-checks` op
 * with what changed; nothing is written by hand.
 */
export function ProjectSettings({
  projectId,
  project,
  readOnly,
}: {
  projectId: string;
  project: Settings;
  readOnly: boolean;
}) {
  const [base, setBase] = useState<Settings>(project);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsFrom(project));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** Saved: the next version of the plan is ours, so the form takes it whatever it holds. */
  const [saved, setSaved] = useState(false);
  const save = useSetChecks(projectId);
  const rowCount = useRef(0);
  const toast = useToast();
  // Someone else changed the settings and this form has no edits: show theirs.
  const pristine = JSON.stringify(draft) === JSON.stringify(settingsFrom(base));
  if (JSON.stringify(project) !== JSON.stringify(base) && (pristine || saved)) {
    setBase(project);
    setDraft(settingsFrom(project));
    setSaved(false);
  }

  const set = (next: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setErrors({});
    setFormError(null);
  };
  const setRow = (index: number, row: Partial<DraftCheck>) =>
    set({ checks: draft.checks.map((r, i) => (i === index ? { ...r, ...row } : r)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = settingsOp(draft, base);
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
        toast.show(t("settings.saved"), "success");
        setSaved(true);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.unauthorized) return;
        const placed =
          error instanceof ApiError
            ? serverErrors({
                code: error.code,
                message: error.message,
                issues: error.details.issues as { path: string; message: string }[] | undefined,
              })
            : { fields: {}, form: t("settings.error.other", { message: String(error) }) };
        setErrors(placed.fields);
        setFormError(placed.form);
      },
    });
  };

  const disabled = readOnly || save.isPending;
  return (
    <form className="b-settings" onSubmit={submit} noValidate>
      {readOnly && (
        <p className="a-callout a-callout--warn" role="status">
          {t("settings.readonly")}
        </p>
      )}
      <Panel title={t("settings.checks.title")} eyebrow={t("settings.eyebrow")}>
        <p className="s-text s-muted">{t("settings.checks.text")}</p>
        {draft.checks.length === 0 ? (
          <p className="s-text s-muted">{t("settings.checks.none")}</p>
        ) : (
          <ol className="b-settings__checks">
            {draft.checks.map((row, index) => (
              <CheckRow
                key={row.key}
                row={row}
                index={index}
                count={draft.checks.length}
                errors={errors}
                disabled={disabled}
                onChange={(next) => setRow(index, next)}
                onMove={(by) => set({ checks: moveCheck(draft.checks, index, by) })}
                onRemove={() => set({ checks: draft.checks.filter((_, i) => i !== index) })}
              />
            ))}
          </ol>
        )}
        {errors.checks && (
          <p className="k-field__error" role="alert">
            {errors.checks}
          </p>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              rowCount.current += 1;
              set({
                checks: [
                  ...draft.checks,
                  { key: `new-${rowCount.current}`, id: "", run: "", timeout: "" },
                ],
              });
            }}
          >
            {t("settings.check.add")}
          </Button>
        </div>
        <div className="b-settings__short">
          <Field
            label={t("settings.retries")}
            hint={t("settings.retries.hint", { n: defaults.retries, max: defaults.maxRetries })}
            inputMode="numeric"
            value={draft.retries}
            disabled={disabled}
            error={errors.retries}
            onChange={(e) => set({ retries: e.target.value })}
          />
        </div>
      </Panel>
      <Panel title={t("settings.setup.title")}>
        <p className="s-text s-muted">{t("settings.setup.text")}</p>
        <Field
          mono
          label={t("settings.setup.run")}
          placeholder={t("settings.setup.placeholder")}
          maxLength={1000}
          value={draft.setupRun}
          disabled={disabled}
          error={errors["setup.run"]}
          onChange={(e) => set({ setupRun: e.target.value })}
        />
        <Field
          label={t("settings.setup.timeout")}
          hint={t("settings.timeout.hint", { s: defaults.timeout })}
          inputMode="numeric"
          value={draft.setupTimeout}
          disabled={disabled}
          error={errors["setup.timeout"]}
          onChange={(e) => set({ setupTimeout: e.target.value })}
        />
      </Panel>
      {formError && (
        <p className="a-callout a-callout--warn" role="alert">
          {formError}
        </p>
      )}
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={readOnly}>
          {t("settings.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || pristine}
          onClick={() => {
            setDraft(settingsFrom(base));
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
