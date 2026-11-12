import { type ReactNode, useState } from "react";
import { type FoldableSection, readSectionOpen, writeSectionOpen } from "./panel-model.ts";

/**
 * One section of the task panel under its title. Folded with a native <details>, so the keyboard
 * and the expanded state come from the browser; `foldable={false}` (while editing) shows it plain,
 * so a form is never hidden.
 */
export function PanelSection({
  section,
  title,
  count,
  foldable = true,
  children,
}: {
  section: FoldableSection;
  title: string;
  /** How many items it holds, shown next to the title so a folded section still says something. */
  count?: number;
  foldable?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readSectionOpen(section));
  const heading = (
    <>
      {title}
      {count !== undefined && <span className="b-fold__count">· {count}</span>}
    </>
  );
  if (!foldable) {
    return (
      <section className="b-fold" data-section={section}>
        <div className="b-fold__head k-label">{heading}</div>
        <div className="b-fold__body">{children}</div>
      </section>
    );
  }
  return (
    <details
      className="b-fold"
      data-section={section}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        writeSectionOpen(section, next);
      }}
    >
      <summary className="b-fold__head b-fold__title k-label">{heading}</summary>
      <div className="b-fold__body">{children}</div>
    </details>
  );
}
