import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

export type MenuOption = { value: string; label: string };

export type MenuProps = {
  /** Small mono caption above the value, e.g. "AGENTE". */
  caption: string;
  options: readonly MenuOption[];
  value: string;
  onChange: (value: string) => void;
};

/**
 * Single-choice menu button (WAI-ARIA menu button pattern): Enter/Space/ArrowDown open it,
 * arrows/Home/End move, Enter selects, Escape or Tab closes and returns focus.
 */
export function Menu({ caption, options, value, onChange }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    items.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function show(index: number) {
    setActive(Math.max(0, Math.min(options.length - 1, index)));
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function onTriggerKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show(options.findIndex((option) => option.value === value));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      show(options.length - 1);
    }
  }

  function onListKey(event: KeyboardEvent) {
    const moves: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      setActive(((moves[event.key] ?? 0) + options.length) % options.length);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <div className="k-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="k-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : show(options.indexOf(current as MenuOption)))}
        onKeyDown={onTriggerKey}
      >
        <span className="k-label">{caption}</span>
        <span>{current?.label} ▾</span>
      </button>
      {open && (
        <div
          id={listId}
          role="menu"
          aria-label={caption}
          className="k-menu__list"
          onKeyDown={onListKey}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => {
                items.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              tabIndex={index === active ? 0 : -1}
              className="k-menu__item"
              onClick={() => {
                onChange(option.value);
                close(true);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
