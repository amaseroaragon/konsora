export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

/** Where the choice is remembered (UI-30); public/theme.js reads the same key before painting. */
export const THEME_KEY = "konsora.theme";

const isForced = (value: unknown): value is "light" | "dark" =>
  value === "light" || value === "dark";

/** The remembered choice; the system's when there is none or storage is unavailable. */
export function readThemeChoice(storage: Pick<Storage, "getItem"> | undefined = safeStorage()) {
  try {
    const stored = storage?.getItem(THEME_KEY);
    return isForced(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function writeThemeChoice(
  choice: ThemeChoice,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage(),
): void {
  try {
    if (choice === "system") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered; the choice still applies to this page.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The theme to start with: `?theme=light|dark` (used for screenshots) wins, then the remembered
 * choice (UI-30), else the OS setting.
 */
export function initialThemeChoice(
  search: string = window.location.search,
  storage?: Pick<Storage, "getItem">,
): ThemeChoice {
  const requested = new URLSearchParams(search).get("theme");
  if (isForced(requested)) return requested;
  return storage ? readThemeChoice(storage) : readThemeChoice();
}

/**
 * Sets the theme on <html>. Call it before the first render so the page never paints
 * with the wrong palette (transitions would otherwise animate from it).
 */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}
