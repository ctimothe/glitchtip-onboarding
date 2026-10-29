import { createContext, useContext, useId, type ReactNode } from "react";

/** True inside a FormSection: fields lay out as label-left, control-right rows. */
export const RowLayout = createContext(false);

// Shared label / description / error wiring for the field primitives.
export function Field({
  label,
  description,
  error,
  wide = false,
  render,
}: {
  label: string;
  description?: string;
  error?: string;
  /** Stack the control under its label even inside a FormSection (multi-line input). */
  wide?: boolean;
  render: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const rows = useContext(RowLayout);
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const className = rows ? `ui-field-row${wide ? " ui-field-row--wide" : ""}` : "ui-field";
  return (
    <div className={className}>
      <label htmlFor={id} className="ui-field__label">
        {label}
      </label>
      {render({ id, describedBy, invalid: Boolean(error) })}
      {description || error ? (
        <div className="ui-field__notes">
          {description ? (
            <p id={descriptionId} className="ui-field__description">
              {description}
            </p>
          ) : null}
          {error ? (
            <p id={errorId} className="ui-field__error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Label for a control that is not a native form element (segmented control, swatches). */
export function ControlRow({ labelId, label, children }: { labelId: string; label: string; children: ReactNode }) {
  const rows = useContext(RowLayout);
  return (
    <div className={rows ? "ui-field-row" : "ui-field"}>
      <span id={labelId} className="ui-field__label">
        {label}
      </span>
      <div className="ui-field-row__control">{children}</div>
    </div>
  );
}

export const CONTROL_CLASS = "ui-input";
