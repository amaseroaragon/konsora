import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button, Field } from "../ui/index.ts";

/** Asks for the feedback that sending a task back requires (modal, Escape cancels). */
export function FeedbackDialog({
  id,
  busy = false,
  onCancel,
  onSubmit,
}: {
  id: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (feedback: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [text, setText] = useState("");
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) onSubmit(text.trim());
  };
  return (
    <dialog
      ref={ref}
      className="b-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form className="s-form" onSubmit={submit}>
        <h2 id={titleId} className="k-panel__title">
          {t("feedback.title", { id })}
        </h2>
        <p className="s-text s-muted">{t("feedback.text")}</p>
        <Field
          multiline
          rows={5}
          required
          label={t("feedback.label")}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="b-dialog__actions">
          <Button onClick={onCancel}>{t("feedback.cancel")}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>
            {t("feedback.submit")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
