/**
 * The app's own yes/no question (UI-08). The browser's native confirm box blocks the page and does
 * not follow Plano, so questions go through `ConfirmHost` (a modal dialog mounted once by the app).
 * Only one question is open at a time: a newer one answers the older one "no".
 *
 * Kept free of React so the answers can be tested without a DOM.
 */

/** How the confirm button reads: the action's verb, and red when it cannot be undone. */
export type ConfirmOptions = { yes?: string; danger?: boolean };

export type ConfirmAsk = (question: string, options?: ConfirmOptions) => Promise<boolean>;

/** The question on screen and the way to answer it (yes, no, or closed as "no"). */
export type OpenConfirm = {
  id: number;
  question: string;
  options: ConfirmOptions;
  answer: (yes: boolean) => void;
};

let open: OpenConfirm | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Shows `question` and resolves with the human's answer; closing the dialog counts as "no". */
export function askConfirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const asked: OpenConfirm = {
      id: ++counter,
      question,
      options,
      answer: (yes) => {
        if (open === asked) {
          open = null;
          publish();
        }
        resolve(yes);
      },
    };
    const previous = open;
    open = asked;
    previous?.answer(false);
    publish();
  });
}

/** The question on screen, if any (the host's snapshot). */
export function getOpenConfirm(): OpenConfirm | null {
  return open;
}

/** Subscribes to changes of the open question; returns the unsubscribe function. */
export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
