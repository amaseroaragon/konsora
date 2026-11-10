import type { AgentSpec, Reviewer } from "@konsora/core";
import { type FormEvent, useState } from "react";
import { useAgents } from "../api/agents.ts";
import { useSetChecks } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Panel, useToast } from "../ui/index.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import {
  type ReviewerDraft,
  type ReviewerLaunch,
  reviewerCatalog,
  reviewerFrom,
  reviewerOp,
} from "./reviewer-model.ts";
import { serverErrors } from "./settings-model.ts";

const LAUNCHES: ReviewerLaunch[] = ["none", "manual", "auto"];

/**
 * The project's reviewer (UI-25): which agent reviews finished runs, read-only, and whether it
 * starts on its own when a task reaches review or only when asked. Saved with `set-reviewer`.
 */
export function ReviewerSettings({
  projectId,
  reviewer,
  defaults,
  readOnly,
}: {
  projectId: string;
  reviewer: Reviewer | undefined;
  /** The project's default agent, where the picker starts when there is no reviewer yet. */
  defaults: AgentSpec | undefined;
  readOnly: boolean;
}) {
  const [base, setBase] = useState(reviewer);
  const [draft, setDraft] = useState<ReviewerDraft>(() => reviewerFrom(reviewer, defaults));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const catalog = useAgents().data;
  const save = useSetChecks(projectId);
  const toast = useToast();
  // Someone else changed the reviewer and this form has no edits: show theirs.
  const pristine = JSON.stringify(draft) === JSON.stringify(reviewerFrom(base, defaults));
  if (JSON.stringify(reviewer) !== JSON.stringify(base) && (pristine || saved)) {
    setBase(reviewer);
    setDraft(reviewerFrom(reviewer, defaults));
    setSaved(false);
  }
  const set = (next: Partial<ReviewerDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = reviewerOp(draft, base, catalog);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!result.op) {
      toast.show(t("settings.unchanged"), "info");
      return;
    }
    const removed = result.op.reviewer === null;
    save.mutate(result.op, {
      onSuccess: () => {
        toast.show(t(removed ? "reviewer.removed" : "reviewer.saved"), "success");
        setSaved(true);
      },
      onError: (failure) => {
        if (failure instanceof ApiError && failure.unauthorized) return;
        if (failure instanceof ApiError && failure.code === "forbidden") {
          setError(serverErrors({ code: failure.code, message: failure.message }).form);
          return;
        }
        setError(t("reviewer.error.save", { message: failure.message }));
      },
    });
  };

  const disabled = readOnly || save.isPending;
  return (
    <form className="b-settings" onSubmit={submit} noValidate>
      <Panel title={t("reviewer.title")} eyebrow={t("settings.eyebrow")}>
        <p className="s-text s-muted">{t("reviewer.text")}</p>
        <label className="k-field b-settings__short">
          <span className="k-field__label">{t("reviewer.launch")}</span>
          <select
            className="k-field__control"
            value={draft.launch}
            disabled={disabled}
            onChange={(e) => set({ launch: e.target.value as ReviewerLaunch })}
          >
            {LAUNCHES.map((launch) => (
              <option key={launch} value={launch}>
                {t(`reviewer.launch.${launch}`)}
              </option>
            ))}
          </select>
        </label>
        {draft.launch !== "none" && (
          <>
            <AgentPicker
              label={t("reviewer.agent")}
              agent={draft.agent}
              catalog={reviewerCatalog(catalog ?? [])}
              disabled={disabled || !catalog}
              onChange={(agent) => set({ agent })}
            />
            <p className="s-text s-muted">{t("reviewer.agent.hint")}</p>
          </>
        )}
        {error && (
          <p className="k-field__error" role="alert">
            {error}
          </p>
        )}
      </Panel>
      <div className="a-actions">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={readOnly}>
          {t("reviewer.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || pristine}
          onClick={() => {
            setDraft(reviewerFrom(base, defaults));
            setError(null);
          }}
        >
          {t("settings.discard")}
        </Button>
      </div>
    </form>
  );
}
