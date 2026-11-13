/**
 * Browser notices when an agent asks (UI-15): which pending questions are new since the last look,
 * the tab title with how many wait, and the preference, remembered in this browser.
 */
import type { PendingQuestions } from "../api/questions.ts";

export type NewQuestion = {
  project: string;
  projectName: string;
  task: string;
  title: string;
  text: string;
};

/** One key per open question: a new question on the same task is a new key. */
export const questionKey = (project: string, task: string, note: string) =>
  `${project}:${task}:${note}`;

export function questionKeys(data: PendingQuestions): Set<string> {
  return new Set(
    data.projects.flatMap((group) =>
      group.questions.map((q) => questionKey(group.project.id, q.task.id, q.question.id)),
    ),
  );
}

/** The questions in `data` that were not in `seen`. */
export function newQuestions(seen: ReadonlySet<string>, data: PendingQuestions): NewQuestion[] {
  return data.projects.flatMap((group) =>
    group.questions
      .filter((q) => !seen.has(questionKey(group.project.id, q.task.id, q.question.id)))
      .map((q) => ({
        project: group.project.id,
        projectName: group.project.name,
        task: q.task.id,
        title: q.task.title,
        text: q.question.text,
      })),
  );
}

/** «(2) Konsora» while two questions wait; the plain title otherwise. */
export function titleWithCount(base: string, pending: number): string {
  return pending > 0 ? `(${pending}) ${base}` : base;
}

const KEY = "konsora.notify";

/** Whether the human turned the notices on in this browser. */
export function readNotify(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function writeNotify(on: boolean) {
  try {
    if (on) window.localStorage.setItem(KEY, "on");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Not remembered; it still applies to this page.
  }
}

export type NotifySupport = "unsupported" | NotificationPermission;

/** What the browser allows: no API at all, or the permission it has given this page. */
export function notifySupport(): NotifySupport {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

/**
 * What to do with a new answer of the pending questions: the keys to remember and the questions to
 * notify. The first answer is what was already waiting, so nothing is news; after that, only new
 * questions, and only with the notices on, permission granted and the tab in the background.
 */
export function questionAlerts(
  seen: ReadonlySet<string> | null,
  data: PendingQuestions,
  when: { enabled: boolean; permission: NotifySupport; hidden: boolean },
): { seen: Set<string>; notify: NewQuestion[] } {
  const keys = questionKeys(data);
  if (seen === null) return { seen: keys, notify: [] };
  const fresh = newQuestions(seen, data);
  const allowed = when.enabled && when.permission === "granted" && when.hidden;
  return { seen: keys, notify: allowed ? fresh : [] };
}
