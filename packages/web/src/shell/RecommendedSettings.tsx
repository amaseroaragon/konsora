import type { AgentSpec, Difficulty, Project } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useAgents } from "../api/agents.ts";
import { useSetChecks } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Panel, useToast } from "../ui/index.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { agentLabel, initialAgent } from "./agent-model.ts";
import {
  DIFFICULTIES,
  type RecommendedDraft,
  recommendedFrom,
  recommendedOp,
} from "./recommended-model.ts";
import { serverErrors } from "./settings-model.ts";

const level = (difficulty: Difficulty) => t(`difficulty.${difficulty}`).toLowerCase();

/**
 * The agent the project recommends for each difficulty (UI-21): tasks without their own agent
 * run with it. Saved with `set-recommended`.
 */
export function RecommendedSettings({
  projectId,
  recommended,
  defaults,
  readOnly,
}: {
  projectId: string;
  recommended: Project["recommended"];
  defaults: AgentSpec | undefined;
  readOnly: boolean;
}) {
  const [base, setBase] = useState(recommended);
  const [draft, setDraft] = useState<RecommendedDraft>(() => recommendedFrom(recommended));
  const [errors, setErrors] = useState<Partial<Record<Difficulty, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const catalog = useAgents().data;
  const save = useSetChecks(projectId);
  const toast = useToast();
  const pristine = JSON.stringify(draft) === JSON.stringify(recommendedFrom(base));
  if (JSON.stringify(recommended) !== JSON.stringify(base) && (pristine || saved)) {
    setBase(recommended);
    setDraft(recommendedFrom(recommended));
    setSaved(false);
  }
  const set = (difficulty: Difficulty, agent: AgentSpec | undefined) => {
    setDraft((current) => {
      const next = { ...current };
      if (agent) next[difficulty] = agent;
      else delete next[difficulty];
      return next;
    });
    setErrors({});
    setFormError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = recommendedOp(draft, base, catalog);
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
        toast.show(t("recommended.saved"), "success");
        setSaved(true);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.unauthorized) return;
        setFormError(
          error instanceof ApiError && error.code === "forbidden"
            ? serverErrors({ code: error.code, message: error.message }).form
            : t("recommended.error", { message: error.message }),
        );
      },
    });
  };

  const disabled = readOnly || save.isPending;
  return (
    <form className="b-settings" onSubmit={submit} noValidate>
      <Panel title={t("recommended.title")} eyebrow={t("settings.eyebrow")}>
        <p className="s-text s-muted">{t("recommended.text")}</p>
        <ul className="b-settings__checks">
          {DIFFICULTIES.map((difficulty) => {
            const agent = draft[difficulty];
            return (
              <li key={difficulty} className="b-settings__template">
                <div className="b-settings__template-head">
                  <span className="k-label">
                    {t("recommended.for", { difficulty: level(difficulty) })}
                  </span>
                  {agent && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => set(difficulty, undefined)}
                    >
                      {t("recommended.unset")}
                    </Button>
                  )}
                </div>
                {agent ? (
                  catalog ? (
                    <AgentPicker
                      label={t("recommended.agent", { difficulty: level(difficulty) })}
                      agent={agent}
                      catalog={catalog}
                      disabled={disabled}
                      onChange={(next) => set(difficulty, next)}
                    />
                  ) : (
                    <p className="k-mono">{agentLabel(agent)}</p>
                  )
                ) : (
                  <div className="a-actions">
                    <span className="s-muted">{t("recommended.none")}</span>
                    {catalog && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => set(difficulty, initialAgent({}, { defaults }, catalog))}
                      >
                        {t("recommended.set")}
                      </Button>
                    )}
                  </div>
                )}
                {errors[difficulty] && (
                  <p className="k-field__error" role="alert">
                    {errors[difficulty]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {formError && (
          <p className="k-field__error" role="alert">
            {formError}
          </p>
        )}
      </Panel>
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={readOnly}>
          {t("recommended.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || pristine}
          onClick={() => {
            setDraft(recommendedFrom(base));
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
