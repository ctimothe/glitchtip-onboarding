import { useId, useRef, type KeyboardEvent } from "react";

import { ControlRow } from "./Field";

// Radio-group keyboard model shared by the segmented control and the swatches:
// arrow keys move the selection, only the selected item is in the tab order.
function useRadioKeys<T extends string>(values: T[], value: T, onChange: (value: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent, index: number) {
    const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + values.length) % values.length;
    onChange(values[next]);
    refs.current[next]?.focus();
  }
  return {
    itemProps: (index: number) => ({
      ref: (node: HTMLButtonElement | null) => {
        refs.current[index] = node;
      },
      role: "radio" as const,
      "aria-checked": values[index] === value,
      tabIndex: values[index] === value ? 0 : -1,
      onClick: () => onChange(values[index]),
      onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index),
    }),
  };
}

/** macOS segmented control for a short, exclusive choice. */
export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  const labelId = useId();
  const { itemProps } = useRadioKeys(options.map((option) => option.value), value, onChange);
  return (
    <ControlRow labelId={labelId} label={label}>
      <div role="radiogroup" aria-labelledby={labelId} className="ui-segmented">
        {options.map((option, index) => (
          <button key={option.value} type="button" className="ui-segmented__item" {...itemProps(index)}>
            {option.label}
          </button>
        ))}
      </div>
    </ControlRow>
  );
}

/** Colour swatches, like the accent colour picker in System Settings. */
export function SwatchPicker<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  /** `color` is a data value (for example a Telegram topic colour), not a style token. */
  options: Array<{ value: T; label: string; color: string }>;
}) {
  const labelId = useId();
  const { itemProps } = useRadioKeys(options.map((option) => option.value), value, onChange);
  return (
    <ControlRow labelId={labelId} label={label}>
      <div role="radiogroup" aria-labelledby={labelId} className="ui-swatches">
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            title={option.label}
            className="ui-swatch"
            style={{ background: option.color }}
            {...itemProps(index)}
          />
        ))}
      </div>
    </ControlRow>
  );
}
