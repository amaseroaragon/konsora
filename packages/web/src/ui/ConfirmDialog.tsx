import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "./Button.tsx";
import { getOpenConfirm, type OpenConfirm, subscribeConfirm } from "./confirm.ts";

/** Mounted once by the app: shows the open question (if any) in a modal dialog (UI-08). */
export function ConfirmHost() {
  const open = useSyncExternalStore(subscribeConfirm, getOpenConfirm, getOpenConfirm);
  return open ? <ConfirmDialog key={open.id} asked={open} /> : null;
}

/**
 * Modal dialog for one question. showModal() traps focus inside it and Escape cancels; the first
 * focusable button is Cancelar, so a stray Enter does not confirm. Closing it answers "no".
 */
export function ConfirmDialog({ asked }: { asked: OpenConfirm }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="b-dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(event) => {
        // Escape: the host unmounts the dialog, which closes it.
        event.preventDefault();
        asked.answer(false);
      }}
    >
      <h2 id={titleId} className="k-panel__title">
        {t("confirm.title")}
      </h2>
      <p id={textId} className="s-text">
        {asked.question}
      </p>
      <div className="b-dialog__actions">
        <Button onClick={() => asked.answer(false)}>{t("confirm.no")}</Button>
        <Button
          variant={asked.options.danger ? "danger" : "primary"}
          onClick={() => asked.answer(true)}
        >
          {asked.options.yes ?? t("confirm.yes")}
        </Button>
      </div>
    </dialog>
  );
}
