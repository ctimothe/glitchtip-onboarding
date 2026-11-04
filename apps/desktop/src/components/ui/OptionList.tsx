import type { KeyboardEvent, ReactNode } from "react";

// A source list of selectable rows, as in Mail's message list: one row is selected, ↑/↓ moves the
// selection, and the selected row alone is in the tab order.
export function OptionList({
  label,
  onMove,
  children,
}: {
  label: string;
  /** Called with -1 or 1 when ↑ or ↓ is pressed inside the list. */
  onMove: (step: -1 | 1) => void;
  children: ReactNode;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    onMove(event.key === "ArrowDown" ? 1 : -1);
  }
  return (
    <div role="listbox" aria-label={label} className="ui-options" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export type OptionTone = "error" | "warning" | "info" | "neutral";

export function OptionRow({
  tone,
  title,
  meta,
  selected,
  onSelect,
  buttonRef,
}: {
  /** A small dot before the title. */
  tone?: OptionTone;
  title: string;
  meta?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className="ui-option"
      onClick={onSelect}
    >
      {tone ? <span className="ui-option__dot" data-tone={tone} aria-hidden="true" /> : null}
      <span className="ui-option__text">
        <span className="ui-option__title">{title}</span>
        {meta ? <span className="ui-option__meta">{meta}</span> : null}
      </span>
    </button>
  );
}
