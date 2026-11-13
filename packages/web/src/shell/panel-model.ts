/**
 * Folding of the task panel's sections (UI-09). The summary and the actions stay on top and never
 * fold; the rest fold, and each remembers its state for every task (a per-viewer preference).
 */
export const FOLDABLE_SECTIONS = ["desc", "criteria", "commits", "deps", "notes"] as const;

export type FoldableSection = (typeof FOLDABLE_SECTIONS)[number];

const key = (section: FoldableSection) => `konsora.panel.${section}`;

/** Whether the section starts open; open unless the human folded it (or storage is unavailable). */
export function readSectionOpen(section: FoldableSection): boolean {
  try {
    return window.localStorage.getItem(key(section)) !== "closed";
  } catch {
    return true;
  }
}

export function writeSectionOpen(section: FoldableSection, open: boolean): void {
  try {
    window.localStorage.setItem(key(section), open ? "open" : "closed");
  } catch {
    // Not persisted; folding still works for the open panel.
  }
}
