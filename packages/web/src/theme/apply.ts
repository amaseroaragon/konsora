export type ThemeChoice = "system" | "light" | "dark";

/** Reads `?theme=light|dark` (used by the gallery and screenshots); defaults to the OS setting. */
export function initialThemeChoice(search: string = window.location.search): ThemeChoice {
  const requested = new URLSearchParams(search).get("theme");
  return requested === "light" || requested === "dark" ? requested : "system";
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
