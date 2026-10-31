import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";

export type TabItem = { id: string; label: string; content: ReactNode };

export type TabsProps = {
  label: string;
  tabs: readonly TabItem[];
  selected: string;
  onSelect: (id: string) => void;
};

/** Tabs with automatic activation and roving focus (ArrowLeft/Right, Home, End). */
export function Tabs({ label, tabs, selected, onSelect }: TabsProps) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === selected),
  );

  function onKey(event: KeyboardEvent) {
    const last = tabs.length - 1;
    const next: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = next[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const tab = tabs[target];
    if (!tab) return;
    onSelect(tab.id);
    refs.current[target]?.focus();
  }

  const active = tabs[index];
  return (
    <div>
      <div role="tablist" aria-label={label} className="k-tabs__list" onKeyDown={onKey}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[i] = node;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={i === index}
            aria-controls={`${base}-panel`}
            tabIndex={i === index ? 0 : -1}
            className="k-tabs__tab"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active && (
        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${active.id}`}
          className="k-tabs__panel"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs make the panel focusable.
          tabIndex={0}
        >
          {active.content}
        </div>
      )}
    </div>
  );
}

export type SegmentedProps = {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
};

/** Toggle group for switching views (Tablero / Grafo / Runs). */
export function Segmented({ label, options, value, onChange }: SegmentedProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toggle-button group, not a form fieldset.
    <div role="group" aria-label={label} className="k-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="k-segmented__item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
