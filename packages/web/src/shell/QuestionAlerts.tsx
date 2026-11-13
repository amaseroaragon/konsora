import { useEffect, useRef, useState } from "react";
import { useQuestions } from "../api/questions.ts";
import { t } from "../i18n/index.ts";
import { Button, Panel } from "../ui/index.ts";
import {
  notifySupport,
  questionAlerts,
  questionKey,
  readNotify,
  titleWithCount,
  writeNotify,
} from "./notify-model.ts";
import { projectHref } from "./route.ts";

const BASE_TITLE = "Konsora";

/**
 * Keeps the tab title with the number of pending questions and, when the human turned the notices
 * on and the browser allows them, shows a notification for each new question while the tab is in
 * the background; clicking it opens that task (UI-15). Renders nothing.
 */
export function QuestionAlerts() {
  const questions = useQuestions();
  const seen = useRef<Set<string> | null>(null);
  const total = questions.data?.total ?? 0;
  useEffect(() => {
    document.title = titleWithCount(BASE_TITLE, total);
  }, [total]);
  useEffect(() => {
    const data = questions.data;
    if (!data) return;
    const next = questionAlerts(seen.current, data, {
      enabled: readNotify(),
      permission: notifySupport(),
      hidden: document.hidden,
    });
    seen.current = next.seen;
    for (const question of next.notify) {
      const notice = new window.Notification(
        t("notify.title", { id: question.task, project: question.projectName }),
        {
          body: question.text,
          tag: questionKey(question.project, question.task, ""),
        },
      );
      notice.onclick = () => {
        window.focus();
        window.location.hash = projectHref(question.project, { task: question.task });
        notice.close();
      };
    }
  }, [questions.data]);
  return null;
}

/**
 * The switch for the notices, in Ajustes (UI-15). Turning them on asks the browser for permission;
 * without it nothing is shown, and the text says why and what to do. Remembered in this browser.
 */
export function NotifySettings() {
  const [on, setOn] = useState(readNotify);
  const [support, setSupport] = useState(notifySupport);
  const enable = async () => {
    if (support === "unsupported") return;
    const permission =
      window.Notification.permission === "granted"
        ? "granted"
        : await window.Notification.requestPermission();
    setSupport(permission);
    const granted = permission === "granted";
    setOn(granted);
    writeNotify(granted);
  };
  const disable = () => {
    setOn(false);
    writeNotify(false);
  };
  const active = on && support === "granted";
  return (
    <Panel title={t("notify.settings.title")} eyebrow={t("notify.settings.eyebrow")}>
      <p className="s-text s-muted">{t("notify.settings.text")}</p>
      <p className="s-text" role="status">
        {support === "unsupported"
          ? t("notify.unsupported")
          : support === "denied"
            ? t("notify.denied")
            : active
              ? t("notify.on")
              : t("notify.off")}
      </p>
      <div className="a-actions">
        {active ? (
          <Button size="sm" variant="secondary" onClick={disable}>
            {t("notify.disable")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={support === "unsupported" || support === "denied"}
            onClick={() => void enable()}
          >
            {t("notify.enable")}
          </Button>
        )}
      </div>
    </Panel>
  );
}
