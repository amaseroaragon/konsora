import type { ReactNode } from "react";

export type PanelProps = {
  title: string;
  /** Mono caps caption above or beside the title. */
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function Panel({ title, eyebrow, actions, children }: PanelProps) {
  return (
    <section className="k-panel" aria-label={title}>
      <header className="k-panel__head">
        <div>
          {eyebrow && <div className="k-label">{eyebrow}</div>}
          <h2 className="k-panel__title">{title}</h2>
        </div>
        {actions && <div className="k-panel__actions">{actions}</div>}
      </header>
      <div className="k-panel__body">{children}</div>
    </section>
  );
}
