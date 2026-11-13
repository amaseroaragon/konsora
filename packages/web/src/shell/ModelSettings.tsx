import { DIFFICULTIES, type Difficulty, type Models } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useProjectOp } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, difficultyLabel, Field, Panel, useToast } from "../ui/index.ts";

type Draft = Record<Difficulty, string>;

export const draftFromModels = (models: Models | undefined): Draft => ({
  low: models?.low ?? "",
  medium: models?.medium ?? "",
  high: models?.high ?? "",
});

/** The `models` of a `set-models` op: the levels with a text, trimmed; `{}` removes them all. */
export function modelsFromDraft(draft: Draft): Models {
  const models: Models = {};
  for (const level of DIFFICULTIES) {
    const value = draft[level].trim();
    if (value) models[level] = value;
  }
  return models;
}

/**
 * The model or effort the human recommends for each difficulty (CORE-23). Only a hint in text,
 * shown next to the difficulty in the task panel, `konsora show` and `konsora start`: Konsora runs
 * no agent and chooses for nobody.
 */
export function ModelSettings({
  projectId,
  models,
  readOnly,
}: {
  projectId: string;
  models: Models | undefined;
  readOnly: boolean;
}) {
  const saved = draftFromModels(models);
  const [draft, setDraft] = useState<Draft>(saved);
  const [base, setBase] = useState(saved);
  const mutation = useProjectOp(projectId);
  const toast = useToast();
  const changed = JSON.stringify(modelsFromDraft(draft)) !== JSON.stringify(modelsFromDraft(base));
  // Someone else changed them and this form has no edits: show theirs.
  if (JSON.stringify(saved) !== JSON.stringify(base) && !changed) {
    setBase(saved);
    setDraft(saved);
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) {
      toast.show(t("settings.unchanged"), "info");
      return;
    }
    mutation.mutate(
      { op: "set-models", models: modelsFromDraft(draft) },
      {
        onSuccess: () => toast.show(t("models.saved"), "success"),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          const code = error instanceof ApiError ? error.code : "error";
          toast.show(
            code === "forbidden"
              ? t("settings.error.forbidden")
              : t("settings.error.other", { message: error.message }),
            "error",
          );
        },
      },
    );
  };
  const disabled = readOnly || mutation.isPending;
  return (
    <form onSubmit={submit} noValidate>
      <Panel title={t("models.title")} eyebrow={t("settings.eyebrow")}>
        <p className="s-text s-muted">{t("models.text")}</p>
        <div className="b-settings__models">
          {DIFFICULTIES.map((level) => (
            <Field
              key={level}
              label={t("models.level", { level: difficultyLabel(level).toLowerCase() })}
              placeholder={t(`models.placeholder.${level}`)}
              value={draft[level]}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, [level]: event.target.value })}
            />
          ))}
        </div>
        <div className="a-actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            busy={mutation.isPending}
            disabled={readOnly || !changed}
          >
            {t("models.save")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !changed}
            onClick={() => setDraft(base)}
          >
            {t("settings.discard")}
          </Button>
        </div>
      </Panel>
    </form>
  );
}
